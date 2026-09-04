import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import agent_loop
import slack_watcher
from agent_loop import SlackCommand, SlackSocketBridge, SlackThreadStore


class FakeWakeClient:
    def __init__(self):
        self.wakes = []
        self.eye_messages = []

    def wake(self, summary):
        self.wakes.append(summary)
        return f"alert-{len(self.wakes)}"

    def eyes(self, message):
        self.eye_messages.append(message.key)


class FakeAuditSink:
    def __init__(self):
        self.thread_ts = None
        self.posts = []

    def post(self, label, body, **kwargs):
        self.posts.append((label, body))


def envelope(
    event_id, *, channel, user, text, ts, channel_type="channel", thread_ts=None,
    event_type="message",
):
    event = {
        "type": event_type,
        "channel": channel,
        "channel_type": channel_type,
        "user": user,
        "text": text,
        "ts": ts,
    }
    if thread_ts:
        event["thread_ts"] = thread_ts
    return {"payload": {"type": "event_callback", "event_id": event_id, "event": event}}


class SlackWatcherTests(unittest.TestCase):
    def make_watcher(self, root, wake=None, clock=lambda: 100.0):
        config = slack_watcher.WatchConfig(
            channel_ids=frozenset({"CEXEC", "CBRAIN"}),
            brainshower_channel_ids=frozenset({"CBRAIN"}),
            claude_user_id="UCLAUDE",
            codex_recipient_id="UCODEX",
            claude_user_ids=frozenset({"UCLAUDE"}),
            claude_bot_ids=frozenset(),
            claude_app_ids=frozenset(),
            codex_user_ids=frozenset({"UCODEX"}),
            codex_bot_ids=frozenset(),
            codex_app_ids=frozenset(),
            receipt_timeout_seconds=90,
            poll_interval_seconds=45,
            state_file=Path(root) / "slack_watch_alert_state.json",
            stop_file=Path(root) / "slack_watcher.stop",
            decisions_file=Path(root) / "BRAINSHOWER_DECISIONS.md",
            owner_user_id="UOWNER",
        )
        bridge = SlackSocketBridge(
            app_token="xapp-test", bot_token="xoxb-test", channel_id="CEXEC"
        )
        return slack_watcher.SlackWatcher(
            config, bridge, wake_client=wake or FakeWakeClient(), clock=clock
        )

    def test_report_parser_tolerates_backticks_and_defaults_to_note(self):
        self.assertEqual(
            slack_watcher.parse_tag("<@UCLAUDE> `[FAIL]` broken", slack_watcher.REPORT_TAGS),
            ("FAIL", "broken"),
        )
        self.assertIsNone(slack_watcher.parse_tag("ordinary note", slack_watcher.REPORT_TAGS))

    def test_codex_report_envelope_is_tagged_mentioned_and_bounded(self):
        sink = agent_loop.SlackAuditSink(
            bot_token="xoxb-test",
            channel_id="CEXEC",
            claude_user_id="UCLAUDE",
        )
        sink.thread_ts = "9.1"
        with patch.object(sink, "_bot_post") as post:
            sink.post_codex_report("DONE", "AGENT RUN → DONE", "commit : abc\nbranch : task")
        message = post.call_args.args[0]
        self.assertTrue(message.startswith("<@UCLAUDE> [DONE] 🔧 Codex"))
        self.assertLessEqual(len(message.splitlines()), 20)

    def test_regression_gate_handoff_uses_accepted_decision(self):
        result = agent_loop.TestResult(
            ["npm", "test"],
            1,
            "Tests  17 failed | 569 passed (586)",
            1.0,
        )
        summary = agent_loop._test_handoff_summary(
            result,
            True,
            "신규 회귀 없음 — 기존 실패 17건 그대로(이 턴이 만든 실패 아님)",
        )
        self.assertIn("569/586", summary)
        self.assertIn("신규 회귀 0건", summary)

    def test_same_process_detects_two_events_from_channel_and_dm(self):
        with tempfile.TemporaryDirectory() as root:
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake)
            watcher.process_envelope(
                envelope(
                    "E1", channel="CEXEC", user="UCODEX", text="<@UCLAUDE> [FAIL] tests failed", ts="1.1"
                )
            )
            watcher.process_envelope(
                envelope(
                    "E2",
                    channel="D123",
                    channel_type="im",
                    user="UCODEX",
                    text="<@UCLAUDE> [ASK] 승인 필요",
                    ts="1.2",
                )
            )
            self.assertEqual(len(wake.wakes), 2)
            self.assertIn("channel=CEXEC", wake.wakes[0])
            self.assertIn("channel=DM", wake.wakes[1])
            self.assertEqual(len(wake.eye_messages), 2)

    def test_restart_does_not_repeat_an_alerted_message(self):
        with tempfile.TemporaryDirectory() as root:
            message = envelope(
                "E1", channel="CEXEC", user="UCODEX", text="[BLOCKED] worktree locked", ts="2.1"
            )
            first = FakeWakeClient()
            self.make_watcher(root, first).process_envelope(message)
            second = FakeWakeClient()
            self.make_watcher(root, second).process_envelope(message)
            self.assertEqual(len(first.wakes), 1)
            self.assertEqual(second.wakes, [])

    def test_done_missing_required_fields_is_flagged(self):
        with tempfile.TemporaryDirectory() as root:
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake)
            watcher.process_envelope(
                envelope("E3", channel="CEXEC", user="UCODEX", text="[DONE] 됐습니다", ts="3.1")
            )
            self.assertIn("형식 미달", wake.wakes[0])
            self.assertIn("commit", wake.wakes[0])

    def test_untagged_codex_message_is_quiet_note(self):
        with tempfile.TemporaryDirectory() as root:
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake)
            watcher.process_envelope(
                envelope("E4", channel="CEXEC", user="UCODEX", text="진행 중입니다", ts="4.1")
            )
            self.assertEqual(wake.wakes, [])
            self.assertEqual(len(wake.eye_messages), 1)

    def test_silent_instruction_reports_missing_mention_after_90_seconds(self):
        with tempfile.TemporaryDirectory() as root:
            now = [100.0]
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake, clock=lambda: now[0])
            watcher.process_envelope(
                envelope("E5", channel="CEXEC", user="UCLAUDE", text="[APPLY] 승인된 지시", ts="5.1")
            )
            self.assertEqual(wake.wakes, [])
            now[0] = 191.0
            watcher.check_silent_failures()
            self.assertEqual(len(wake.wakes), 1)
            self.assertIn("미접수 무음 실패", wake.wakes[0])
            self.assertIn("멘션 누락", wake.wakes[0])

    def test_thread_receipt_cancels_silent_failure(self):
        with tempfile.TemporaryDirectory() as root:
            now = [100.0]
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake, clock=lambda: now[0])
            watcher.process_envelope(
                envelope(
                    "E6",
                    channel="CEXEC",
                    user="UCLAUDE",
                    text="<@UCODEX> [PLAN] 계획",
                    ts="6.1",
                )
            )
            watcher.process_envelope(
                envelope(
                    "E7",
                    channel="CEXEC",
                    user="UCODEX",
                    text="SLACK → AGENT accepted",
                    ts="6.2",
                    thread_ts="6.1",
                )
            )
            now[0] = 191.0
            watcher.check_silent_failures()
            self.assertEqual(wake.wakes, [])

    def test_brainshower_closed_thread_reports_decision_file_gap(self):
        with tempfile.TemporaryDirectory() as root:
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake)
            watcher.process_envelope(
                envelope("E8", channel="CBRAIN", user="UOTHER", text="결론 확정", ts="8.1")
            )
            self.assertEqual(len(wake.wakes), 1)
            self.assertIn("미편입", wake.wakes[0])

    def test_owner_message_wakes_immediately_without_tag_or_mention(self):
        with tempfile.TemporaryDirectory() as root:
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake)
            watcher.process_envelope(
                envelope("E10", channel="CEXEC", user="UOWNER", text="이것 확인해", ts="10.1")
            )
            self.assertEqual(len(wake.wakes), 1)
            self.assertIn("발주자 메시지", wake.wakes[0])

    def test_claude_formal_and_literal_calls_wake_for_any_author(self):
        with tempfile.TemporaryDirectory() as root:
            wake = FakeWakeClient()
            watcher = self.make_watcher(root, wake)
            watcher.process_envelope(
                envelope("E11a", channel="CEXEC", user="UOTHER", text="<@UCLAUDE> 봐줘", ts="11.1")
            )
            watcher.process_envelope(
                envelope("E11b", channel="CBRAIN", user="UOTHER", text="@ClAuDe 판단 필요", ts="11.2")
            )
            self.assertEqual(len(wake.wakes), 2)
            self.assertTrue(all("@claude 호출" in item for item in wake.wakes))

    def test_literal_codex_action_is_relayed_but_formal_mention_is_not(self):
        with tempfile.TemporaryDirectory() as root:
            handled = []
            watcher = self.make_watcher(root)
            watcher.command_handler = lambda command: handled.append(command) or 0
            watcher.process_envelope(
                envelope(
                    "E12a",
                    channel="CEXEC",
                    user="UOWNER",
                    text="@codex [APPLY] instruction_id: relay-1",
                    ts="12.1",
                )
            )
            selected_handler, relayed = watcher.command_queue.get_nowait()
            selected_handler(relayed)
            watcher.command_queue.task_done()
            self.assertEqual(len(handled), 1)
            self.assertEqual(handled[0].text, "[APPLY] instruction_id: relay-1")
            formal = envelope(
                "E12b",
                channel="CEXEC",
                user="UOWNER",
                text="<@UCODEX> [APPLY] instruction_id: native-1",
                ts="12.2",
                event_type="app_mention",
            )
            watcher.process_envelope(formal)
            self.assertTrue(watcher.command_queue.empty())
            self.assertIsNotNone(watcher.bridge.command_from_envelope(formal))
            self.assertEqual(len(handled), 1)

    def test_ticket_grant_caps_budget_and_resumes_limit_stopped_request(self):
        with tempfile.TemporaryDirectory() as root:
            store = SlackThreadStore(Path(root))
            state = store.load("CEXEC", "13.1")
            state["executionCount"] = 3
            state["pendingBudgetCommand"] = {
                "mode": "execution",
                "eventId": "OLD",
                "userId": "UOWNER",
                "text": "[APPLY] instruction_id: pending-1",
                "actorType": "human",
            }
            store.save(state)
            audit = FakeAuditSink()
            resumed = []
            command = SlackCommand(
                event_id="E13",
                user_id="UOWNER",
                text="[티켓 추가 100]",
                channel_id="CEXEC",
                thread_ts="13.1",
                event_ts="13.2",
            )
            with patch.dict("os.environ", {"SLACK_MAX_CODEX_RUNS_PER_THREAD": "3"}):
                result = agent_loop.handle_ticket_addition(
                    command,
                    mode="execution",
                    resume_handler=lambda item: resumed.append(item) or 0,
                    state_store=store,
                    audit_sink=audit,
                    owner_user_id="UOWNER",
                )
            saved = store.load("CEXEC", "13.1")
            self.assertEqual(result, 0)
            self.assertEqual(saved["ticketGrantCount"], 5)
            self.assertNotIn("pendingBudgetCommand", saved)
            self.assertEqual(len(resumed), 1)
            self.assertIn("요청 100, 부여 5, 남은 예산 5", audit.posts[0][1])
            self.assertIn("1회 상한 5", audit.posts[0][1])

            second = SlackCommand(
                event_id="E13-second",
                user_id="UOWNER",
                text="[티켓추가 100]",
                channel_id="CEXEC",
                thread_ts="13.1",
                event_ts="13.3",
            )
            third = SlackCommand(
                event_id="E13-third",
                user_id="UOWNER",
                text="[티켓추가 1]",
                channel_id="CEXEC",
                thread_ts="13.1",
                event_ts="13.4",
            )
            with patch.dict("os.environ", {"SLACK_MAX_CODEX_RUNS_PER_THREAD": "3"}):
                agent_loop.handle_ticket_addition(
                    second, mode="execution", state_store=store, audit_sink=audit,
                    owner_user_id="UOWNER",
                )
                agent_loop.handle_ticket_addition(
                    third, mode="execution", state_store=store, audit_sink=audit,
                    owner_user_id="UOWNER",
                )
            self.assertEqual(store.load("CEXEC", "13.1")["ticketGrantCount"], 10)
            self.assertIn("부여 0", audit.posts[-1][1])
            self.assertIn("누적 상한 10", audit.posts[-1][1])

    def test_ticket_default_and_bot_rejection_are_explicit(self):
        with tempfile.TemporaryDirectory() as root:
            store = SlackThreadStore(Path(root))
            audit = FakeAuditSink()
            owner = SlackCommand(
                event_id="E13b",
                user_id="UOWNER",
                text="[티켓추가]",
                channel_id="CBRAIN",
                thread_ts="13.3",
                event_ts="13.4",
            )
            agent_loop.handle_ticket_addition(
                owner,
                mode="opinion",
                state_store=store,
                audit_sink=audit,
                owner_user_id="UOWNER",
            )
            bot = SlackCommand(
                event_id="E13c",
                user_id="UBOT",
                text="[티켓추가 2]",
                channel_id="CBRAIN",
                thread_ts="13.3",
                event_ts="13.5",
                actor_type="allowed_bot",
            )
            agent_loop.handle_ticket_addition(
                bot,
                mode="opinion",
                state_store=store,
                audit_sink=audit,
                owner_user_id="UOWNER",
            )
            self.assertIn("부여 1", audit.posts[0][1])
            self.assertEqual(audit.posts[1][0], "AGENT LOOP · TICKET IGNORED")

    def test_ticket_message_routes_to_the_current_thread_budget_mode(self):
        with tempfile.TemporaryDirectory() as root:
            handled = []
            watcher = self.make_watcher(root)
            watcher.ticket_handler = lambda command, mode: handled.append((command, mode)) or 0
            wrapped = envelope(
                "E13-route",
                channel="CBRAIN",
                user="UOWNER",
                text="[ 티켓 추가 2 ]",
                ts="13.6",
                thread_ts="13.1",
            )
            watcher.process_envelope(wrapped)
            selected_handler, command = watcher.command_queue.get_nowait()
            selected_handler(command)
            watcher.command_queue.task_done()
            self.assertEqual(handled[0][1], "opinion")
            self.assertEqual(handled[0][0].thread_ts, "13.1")
            self.assertTrue(wrapped["_slack_watcher_skip_command"])


if __name__ == "__main__":
    unittest.main()
