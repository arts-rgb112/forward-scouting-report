import tempfile
import unittest
from pathlib import Path

import slack_watcher
from agent_loop import SlackSocketBridge


class FakeWakeClient:
    def __init__(self):
        self.wakes = []
        self.eye_messages = []

    def wake(self, summary):
        self.wakes.append(summary)
        return f"alert-{len(self.wakes)}"

    def eyes(self, message):
        self.eye_messages.append(message.key)


def envelope(event_id, *, channel, user, text, ts, channel_type="channel", thread_ts=None):
    event = {
        "type": "message",
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


if __name__ == "__main__":
    unittest.main()
