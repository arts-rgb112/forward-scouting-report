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
