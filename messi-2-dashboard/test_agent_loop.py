import importlib.util
import asyncio
import os
import sys
import tempfile
import unittest
from pathlib import Path
from subprocess import CompletedProcess
from unittest.mock import patch


MODULE_PATH = Path(__file__).with_name("agent_loop.py")
SPEC = importlib.util.spec_from_file_location("agent_loop", MODULE_PATH)
assert SPEC and SPEC.loader
agent_loop = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = agent_loop
SPEC.loader.exec_module(agent_loop)


class AgentLoopTests(unittest.TestCase):
    def test_extracts_multiple_utf8_files(self):
        response = """[FILE: src/a.ts]
```ts
export const label = "히트맵";
```
[FILE: src/b.css]
```css
.dot { opacity: .5; }
```"""
        self.assertEqual(
            agent_loop.extract_file_changes(response),
            [
                ("src/a.ts", 'export const label = "히트맵";'),
                ("src/b.css", ".dot { opacity: .5; }"),
            ],
        )

    def test_rejects_traversal_before_writing(self):
        with self.assertRaises(agent_loop.AgentLoopError):
            agent_loop.apply_file_changes("[FILE: ../secret]\n```\nnope\n```")

    def test_codex_environment_removes_api_billing_variables(self):
        env = agent_loop.codex_environment(
            {
                "OPENAI_API_KEY": "must-not-leak",
                "OPENAI_PROJECT_ID": "project",
                "OPENAI_BASE_URL": "https://example.invalid",
                "SLACK_CHANNEL_ID": "C123",
            }
        )
        self.assertNotIn("OPENAI_API_KEY", env)
        self.assertNotIn("OPENAI_PROJECT_ID", env)
        self.assertNotIn("OPENAI_BASE_URL", env)
        self.assertEqual(env["SLACK_CHANNEL_ID"], "C123")
        self.assertEqual(env["CI"], "true")

    def test_optional_boolean_environment_accepts_only_trimmed_true_or_false(self):
        with patch.dict(os.environ, {"SLACK_AUDIT_REQUIRED": "TRUE "}, clear=False):
            self.assertIs(agent_loop.optional_boolean_environment("SLACK_AUDIT_REQUIRED"), True)
        with patch.dict(os.environ, {"SLACK_AUDIT_REQUIRED": " false\t"}, clear=False):
            self.assertIs(agent_loop.optional_boolean_environment("SLACK_AUDIT_REQUIRED"), False)

    def test_optional_boolean_environment_distinguishes_unset_from_invalid(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertIsNone(agent_loop.optional_boolean_environment("SLACK_AUDIT_REQUIRED"))
        for blank in ("", "   "):
            with self.subTest(value=blank):
                with patch.dict(
                    os.environ, {"SLACK_AUDIT_REQUIRED": blank}, clear=False
                ):
                    self.assertIsNone(
                        agent_loop.optional_boolean_environment("SLACK_AUDIT_REQUIRED")
                    )
        for invalid in ("ture", "1", "yes", "0"):
            with self.subTest(value=invalid):
                with patch.dict(
                    os.environ, {"SLACK_AUDIT_REQUIRED": invalid}, clear=False
                ):
                    with self.assertRaisesRegex(
                        agent_loop.AgentLoopError,
                        "SLACK_AUDIT_REQUIRED must be true or false when set",
                    ):
                        agent_loop.optional_boolean_environment("SLACK_AUDIT_REQUIRED")

    def test_main_rejects_invalid_audit_boolean_even_in_check_mode(self):
        with patch.dict(os.environ, {"SLACK_AUDIT_REQUIRED": "ture"}, clear=False):
            with self.assertRaisesRegex(agent_loop.AgentLoopError, "must be true or false"):
                agent_loop.main(["--check"])

    def test_build_codex_runner_accepts_chatgpt_subscription_login(self):
        completed = CompletedProcess(
            args=["codex", "login", "status"],
            returncode=0,
            stdout="Logged in using ChatGPT\n",
            stderr="",
        )
        with patch.object(agent_loop.shutil, "which", return_value="codex.exe"):
            with patch.object(agent_loop.subprocess, "run", return_value=completed) as run:
                runner, status = agent_loop.build_codex_runner()
        self.assertEqual(runner, agent_loop.CodexCliRunner(executable="codex.exe"))
        self.assertEqual(status, "ready (ChatGPT subscription via codex exec)")
        self.assertNotIn("OPENAI_API_KEY", run.call_args.kwargs["env"])

    def test_build_codex_runner_rejects_api_key_login(self):
        completed = CompletedProcess(
            args=["codex", "login", "status"],
            returncode=0,
            stdout="Logged in using an API key\n",
            stderr="",
        )
        with patch.object(agent_loop.shutil, "which", return_value="codex.exe"):
            with patch.object(agent_loop.subprocess, "run", return_value=completed):
                runner, status = agent_loop.build_codex_runner()
        self.assertIsNone(runner)
        self.assertIn("authenticated with an API key", status)

    def test_call_agent_uses_read_only_codex_exec_and_last_message(self):
        def fake_run(argv, **kwargs):
            output_path = Path(argv[argv.index("--output-last-message") + 1])
            output_path.write_text("DONE\n", encoding="utf-8")
            self.assertIn("--ephemeral", argv)
            self.assertEqual(argv[argv.index("--sandbox") + 1], "read-only")
            self.assertEqual(argv[-1], "-")
            self.assertNotIn("OPENAI_API_KEY", kwargs["env"])
            self.assertIn("ROLE: planner", kwargs["input"])
            return CompletedProcess(args=argv, returncode=0, stdout="", stderr="")

        with patch.object(agent_loop.subprocess, "run", side_effect=fake_run):
            result = agent_loop.call_agent(
                agent_loop.CodexCliRunner(executable="codex.exe"),
                role="planner",
                instructions="Plan only.",
                prompt="Inspect the task.",
                timeout_seconds=10,
            )
        self.assertEqual(result, "DONE\n")

    def test_slack_required_fails_closed_without_credentials(self):
        with patch.dict(os.environ, {}, clear=True):
            with self.assertRaises(agent_loop.AgentLoopError):
                agent_loop.SlackAuditSink.from_environment(required=True)

    def test_slack_audit_redacts_tokens_and_ansi(self):
        raw = (
            "\x1b[31mAuthorization: Bearer secret-token\x1b[0m "
            "sk-example123456789 https://hooks.slack.com/services/T/A/B"
        )
        safe = agent_loop.redact_audit_text(raw)
        self.assertNotIn("secret-token", safe)
        self.assertNotIn("sk-example", safe)
        self.assertNotIn("hooks.slack.com", safe)
        self.assertNotIn("\x1b", safe)

    def test_slack_posts_coder_summary_in_bounded_chunks(self):
        sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
        with patch.object(sink, "_bot_post") as post:
            sink.post("TEST", "x" * (agent_loop.MAX_SLACK_CHUNK + 10))
        self.assertEqual(post.call_count, 2)

    def test_slack_socket_requires_all_three_credentials(self):
        with patch.dict(
            os.environ,
            {"SLACK_APP_TOKEN": "xapp-test", "SLACK_BOT_TOKEN": "xoxb-test"},
            clear=True,
        ):
            with self.assertRaises(agent_loop.AgentLoopError):
                agent_loop.SlackSocketBridge.from_environment()

    def test_slack_socket_accepts_mention_only_in_configured_channel(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test", bot_token="xoxb-test", channel_id="C123"
        )
        command = bridge.command_from_envelope(
            {
                "payload": {
                    "type": "event_callback",
                    "event_id": "Ev1",
                    "event": {
                        "type": "app_mention",
                        "channel": "C123",
                        "user": "U1",
                        "text": "<@UBOT> 도트 히트맵 수정",
                        "ts": "100.1",
                    },
                }
            }
        )
        self.assertIsNotNone(command)
        assert command is not None
        self.assertEqual(command.text, "도트 히트맵 수정")
        self.assertEqual(command.thread_ts, "100.1")

        wrong_channel = bridge.command_from_envelope(
            {
                "payload": {
                    "type": "event_callback",
                    "event_id": "Ev2",
                    "event": {
                        "type": "app_mention",
                        "channel": "C999",
                        "user": "U1",
                        "text": "<@UBOT> ignore",
                        "ts": "100.2",
                    },
                }
            }
        )
        self.assertIsNone(wrong_channel)

    def test_slack_socket_accepts_human_followup_only_in_active_thread(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test", bot_token="xoxb-test", channel_id="C123"
        )
        bridge.active_threads.add("100.1")
        followup = bridge.command_from_envelope(
            {
                "payload": {
                    "type": "event_callback",
                    "event_id": "Ev3",
                    "event": {
                        "type": "message",
                        "channel": "C123",
                        "user": "U1",
                        "text": "그 부분은 보류해",
                        "thread_ts": "100.1",
                        "ts": "100.3",
                    },
                }
            }
        )
        self.assertIsNotNone(followup)
        assert followup is not None
        self.assertEqual(followup.text, "그 부분은 보류해")

        unrelated = bridge.command_from_envelope(
            {
                "payload": {
                    "type": "event_callback",
                    "event_id": "Ev4",
                    "event": {
                        "type": "message",
                        "channel": "C123",
                        "user": "U1",
                        "text": "ordinary channel chatter",
                        "ts": "100.4",
                    },
                }
            }
        )
        self.assertIsNone(unrelated)

    def test_slack_socket_rejects_bot_and_duplicate_events(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test", bot_token="xoxb-test", channel_id="C123"
        )
        bot_envelope = {
            "payload": {
                "type": "event_callback",
                "event_id": "Ev5",
                "event": {
                    "type": "app_mention",
                    "channel": "C123",
                    "user": "UBOT",
                    "bot_id": "B1",
                    "text": "<@UBOT> loop",
                    "ts": "100.5",
                },
            }
        }
        self.assertIsNone(bridge.command_from_envelope(bot_envelope))
        self.assertIsNone(bridge.command_from_envelope(bot_envelope))

    def test_slack_socket_accepts_only_exact_allowlisted_claude_bot(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test",
            bot_token="xoxb-test",
            channel_id="C123",
            allowed_bot_ids={"BCLAUDE"},
        )
        command = bridge.command_from_envelope(
            {
                "payload": {
                    "type": "event_callback",
                    "event_id": "EvClaude",
                    "event": {
                        "type": "app_mention",
                        "subtype": "bot_message",
                        "channel": "C123",
                        "user": "UCLAUDE",
                        "bot_id": "BCLAUDE",
                        "app_id": "ACLAUDE",
                        "text": "<@UBOT> [PLAN] bounded work",
                        "ts": "100.55",
                    },
                }
            }
        )
        self.assertIsNotNone(command)
        assert command is not None
        self.assertEqual(command.actor_type, "allowed_bot")
        self.assertEqual(command.text, "[PLAN] bounded work")

    def test_context_channel_message_is_saved_but_never_becomes_a_command(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            context_store = agent_loop.SlackContextStore(Path(temp_dir))
            bridge = agent_loop.SlackSocketBridge(
                app_token="xapp-test",
                bot_token="xoxb-test",
                channel_id="CEXEC",
                context_channel_ids={"CTODO", "COKR"},
                context_store=context_store,
            )
            envelope = {
                "payload": {
                    "type": "event_callback",
                    "event_id": "EvReport",
                    "event": {
                        "type": "message",
                        "channel": "CTODO",
                        "user": "UCLAUDE",
                        "text": "정기 업무 보고",
                        "ts": "100.57",
                    },
                }
            }
            self.assertTrue(bridge.capture_context_from_envelope(envelope))
            self.assertFalse(bridge.capture_context_from_envelope(envelope))
            self.assertFalse(
                context_store.append(
                    channel_id="CTODO",
                    event_id="history:CTODO:100.57",
                    event_ts="100.57",
                    text="정기 업무 보고",
                    actor="human:UCLAUDE",
                )
            )
            self.assertIsNone(bridge.command_from_envelope(envelope))
            self.assertIn("정기 업무 보고", context_store.context({"CTODO", "COKR"}))

    def test_slack_socket_always_rejects_own_bot_user(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test",
            bot_token="xoxb-test",
            channel_id="C123",
            allowed_bot_ids={"BSELF"},
        )
        bridge.bot_user_id = "USELF"
        self.assertIsNone(
            bridge.command_from_envelope(
                {
                    "payload": {
                        "type": "event_callback",
                        "event_id": "EvSelf",
                        "event": {
                            "type": "app_mention",
                            "subtype": "bot_message",
                            "channel": "C123",
                            "user": "USELF",
                            "bot_id": "BSELF",
                            "text": "<@USELF> [APPLY] loop",
                            "ts": "100.56",
                        },
                    }
                }
            )
        )

    def test_slack_connection_probe_does_not_invoke_model_loop(self):
        command = agent_loop.SlackCommand(
            event_id="Ev6",
            user_id="U1",
            text="연결 확인",
            channel_id="C123",
            thread_ts="100.6",
            event_ts="100.6",
        )
        sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
        with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
            with patch.object(sink, "_bot_post") as post:
                with patch.object(agent_loop, "run_loop") as run_loop:
                    result = agent_loop.handle_slack_command(
                        command, max_iterations=1, test_timeout=1
                    )
        self.assertEqual(result, 0)
        self.assertEqual(post.call_count, 2)
        run_loop.assert_not_called()

    def test_plan_and_discuss_persist_without_codex_or_tests(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            for event_id, text in (("EvPlan", "[PLAN] 계획"), ("EvDiscuss", "[DISCUSS] 수정 의견")):
                command = agent_loop.SlackCommand(
                    event_id=event_id,
                    user_id="U1",
                    text=text,
                    channel_id="C123",
                    thread_ts="200.1",
                    event_ts="200.1",
                )
                with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                    with patch.object(sink, "_bot_post"):
                        with patch.object(agent_loop, "call_agent") as call_agent:
                            with patch.object(agent_loop, "run_tests") as run_tests:
                                self.assertEqual(
                                    agent_loop.handle_slack_command(
                                        command,
                                        max_iterations=8,
                                        test_timeout=1,
                                        state_store=store,
                                    ),
                                    0,
                                )
                        call_agent.assert_not_called()
                        run_tests.assert_not_called()
            state = store.load("C123", "200.1")
            self.assertEqual([item["action"] for item in state["messages"]], ["PLAN", "DISCUSS"])
            self.assertEqual(state["executionCount"], 0)

    def test_apply_invokes_exactly_one_codex_turn_and_one_test_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = agent_loop.SlackThreadStore(root / "state")
            prior = store.load("C123", "200.2")
            agent_loop.SlackThreadStore.append_message(
                prior, action="PLAN", actor="allowed_bot:UCLAUDE", text="change one file", event_ts="1"
            )
            store.save(prior)
            command = agent_loop.SlackCommand(
                event_id="EvApply",
                user_id="U1",
                text="[APPLY] apply approved plan",
                channel_id="C123",
                thread_ts="200.2",
                event_ts="2",
            )
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            passed = agent_loop.TestResult(["test"], 0, "ok", 0.1)
            response = "[FILE: src/one.ts]\n```ts\nexport const one = 1;\n```"
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                    with patch.object(sink, "_bot_post"):
                        with patch.object(
                            agent_loop,
                            "build_codex_runner",
                            return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                        ):
                            with patch.object(agent_loop, "call_agent", return_value=response) as call_agent:
                                with patch.object(agent_loop, "run_tests", return_value=passed) as run_tests:
                                    result = agent_loop.handle_slack_command(
                                        command,
                                        max_iterations=8,
                                        test_timeout=1,
                                        state_store=store,
                                    )
            self.assertEqual(result, 0)
            self.assertEqual(call_agent.call_count, 1)
            self.assertEqual(run_tests.call_count, 1)
            self.assertEqual((root / "src/one.ts").read_text(encoding="utf-8"), "export const one = 1;")
            self.assertEqual(store.load("C123", "200.2")["executionCount"], 1)

    def test_apply_includes_read_only_report_context_without_extra_codex_turn(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            store = agent_loop.SlackThreadStore(root / "thread-state")
            context_store = agent_loop.SlackContextStore(root / "context-state")
            context_store.append(
                channel_id="COKR",
                event_id="history:COKR:1",
                event_ts="1",
                text="OKR 기준선 보고",
                actor="human:UCLAUDE",
            )
            command = agent_loop.SlackCommand(
                event_id="EvApplyContext",
                user_id="U1",
                text="[APPLY] 승인된 변경",
                channel_id="C123",
                thread_ts="200.21",
                event_ts="2",
            )
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            passed = agent_loop.TestResult(["test"], 0, "ok", 0.1)
            response = "[FILE: src/context.ts]\n```ts\nexport const context = true;\n```"
            with patch.dict(os.environ, {"SLACK_CONTEXT_CHANNEL_IDS": "CTODO,COKR"}, clear=False):
                with patch.object(agent_loop, "PROJECT_ROOT", root):
                    with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                        with patch.object(sink, "_bot_post"):
                            with patch.object(
                                agent_loop,
                                "build_codex_runner",
                                return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                            ):
                                with patch.object(agent_loop, "call_agent", return_value=response) as call_agent:
                                    with patch.object(agent_loop, "run_tests", return_value=passed):
                                        result = agent_loop.handle_slack_command(
                                            command,
                                            max_iterations=1,
                                            test_timeout=1,
                                            state_store=store,
                                            context_store=context_store,
                                        )
            self.assertEqual(result, 0)
            self.assertEqual(call_agent.call_count, 1)
            self.assertIn("OKR 기준선 보고", call_agent.call_args.kwargs["prompt"])
            self.assertIn("background status only", call_agent.call_args.kwargs["prompt"])

    def test_untagged_message_never_invokes_codex(self):
        command = agent_loop.SlackCommand(
            event_id="EvPlain",
            user_id="U1",
            text="그냥 대화",
            channel_id="C123",
            thread_ts="200.3",
            event_ts="3",
        )
        sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
        with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
            with patch.object(sink, "_bot_post"):
                with patch.object(agent_loop, "build_codex_runner") as runner:
                    self.assertEqual(
                        agent_loop.handle_slack_command(command, max_iterations=8, test_timeout=1),
                        0,
                    )
        runner.assert_not_called()

    def test_execution_limit_requires_human_reset(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            state = store.load("C123", "200.4")
            state["executionCount"] = 3
            store.save(state)
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            command = agent_loop.SlackCommand(
                event_id="EvLimit",
                user_id="U1",
                text="[REVISE] again",
                channel_id="C123",
                thread_ts="200.4",
                event_ts="4",
            )
            with patch.dict(os.environ, {"SLACK_MAX_CODEX_RUNS_PER_THREAD": "3"}, clear=False):
                with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                    with patch.object(sink, "_bot_post"):
                        with patch.object(agent_loop, "build_codex_runner") as runner:
                            self.assertEqual(
                                agent_loop.handle_slack_command(
                                    command, max_iterations=8, test_timeout=1, state_store=store
                                ),
                                2,
                            )
            runner.assert_not_called()

            reset = agent_loop.SlackCommand(
                event_id="EvReset",
                user_id="U1",
                text="[RESET]",
                channel_id="C123",
                thread_ts="200.4",
                event_ts="5",
            )
            with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                with patch.object(sink, "_bot_post"):
                    self.assertEqual(
                        agent_loop.handle_slack_command(
                            reset, max_iterations=8, test_timeout=1, state_store=store
                        ),
                        0,
                    )
            self.assertEqual(store.load("C123", "200.4")["executionCount"], 0)

    def test_persisted_thread_is_accepted_after_bridge_restart(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            state = store.load("C123", "200.5")
            store.save(state)
            bridge = agent_loop.SlackSocketBridge(
                app_token="xapp-test",
                bot_token="xoxb-test",
                channel_id="C123",
                state_store=store,
            )
            command = bridge.command_from_envelope(
                {
                    "payload": {
                        "type": "event_callback",
                        "event_id": "EvRestart",
                        "event": {
                            "type": "message",
                            "channel": "C123",
                            "user": "U1",
                            "text": "[DISCUSS] listener restarted",
                            "thread_ts": "200.5",
                            "ts": "6",
                        },
                    }
                }
            )
            self.assertIsNotNone(command)

    def test_persisted_event_id_prevents_second_codex_turn_after_restart(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            state = store.load("C123", "200.6")
            state["processedEventIds"] = ["EvAlready"]
            store.save(state)
            command = agent_loop.SlackCommand(
                event_id="EvAlready",
                user_id="U1",
                text="[APPLY] must not repeat",
                channel_id="C123",
                thread_ts="200.6",
                event_ts="7",
            )
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                with patch.object(sink, "_bot_post"):
                    with patch.object(agent_loop, "build_codex_runner") as runner:
                        self.assertEqual(
                            agent_loop.handle_slack_command(
                                command, max_iterations=8, test_timeout=1, state_store=store
                            ),
                            0,
                        )
            runner.assert_not_called()

    def test_task_file_loop_uses_one_executor_turn_even_with_large_legacy_limit(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            task = root / "task.md"
            task.write_text("one bounded change", encoding="utf-8")
            sink = agent_loop.SlackAuditSink()
            response = "[FILE: src/once.ts]\n```ts\nexport const once = true;\n```"
            passed = agent_loop.TestResult(["test"], 0, "ok", 0.1)
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                with patch.object(
                    agent_loop,
                    "build_codex_runner",
                    return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                ):
                    with patch.object(agent_loop, "call_agent", return_value=response) as call_agent:
                        with patch.object(agent_loop, "run_tests", return_value=passed):
                            with patch.object(agent_loop, "write_report"):
                                result = agent_loop.run_loop(
                                    task,
                                    max_iterations=99,
                                    test_timeout=1,
                                    audit_sink=sink,
                                )
            self.assertEqual(result, 0)
            self.assertEqual(call_agent.call_count, 1)
            self.assertEqual(call_agent.call_args.kwargs["role"], "executor")

    def test_slack_command_failure_does_not_reconnect_socket(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test", bot_token="xoxb-test", channel_id="C123"
        )

        class FakeSocket:
            def __init__(self):
                self.messages = iter(
                    [
                        '{"envelope_id":"E1","payload":{"type":"event_callback",'
                        '"event_id":"Ev7","event":{"type":"app_mention",'
                        '"channel":"C123","user":"U1","text":"<@UBOT> run",'
                        '"ts":"100.7"}}}',
                        '{"type":"disconnect","reason":"link_disabled"}',
                    ]
                )
                self.acks = []

            def __aiter__(self):
                return self

            async def __anext__(self):
                try:
                    return next(self.messages)
                except StopIteration as exc:
                    raise StopAsyncIteration from exc

            async def send(self, value):
                self.acks.append(value)

        class FakeContext:
            def __init__(self, socket):
                self.socket = socket

            async def __aenter__(self):
                return self.socket

            async def __aexit__(self, exc_type, exc, traceback):
                return False

        socket = FakeSocket()
        websockets = type("FakeWebsockets", (), {"connect": lambda *args, **kwargs: FakeContext(socket)})
        bridge._resolve_bot_user_id = lambda: "UBOT"
        bridge._socket_url = lambda: "wss://example.invalid"
        with patch.object(bridge, "_websockets_module", return_value=websockets):
            with self.assertRaises(agent_loop.AgentLoopError):
                asyncio.run(bridge.listen(lambda command: (_ for _ in ()).throw(RuntimeError())))
        self.assertEqual(socket.acks, ['{"envelope_id": "E1"}'])

    def test_apply_file_changes_writes_under_project_root(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                changed = agent_loop.apply_file_changes(
                    "[FILE: src/generated.ts]\n```ts\nexport const ok = true;\n```"
                )
            self.assertEqual(changed[0].path, "src/generated.ts")
            self.assertEqual(
                (root / "src/generated.ts").read_text(encoding="utf-8"),
                "export const ok = true;",
            )

    def test_tail_is_limited_to_3000_characters(self):
        result = agent_loop.run_tests(
            command=[sys.executable, "-c", "print('x' * 5000)"], timeout_seconds=10
        )
        self.assertEqual(result.returncode, 0)
        self.assertLessEqual(len(result.output_tail), 3000)


if __name__ == "__main__":
    unittest.main()
