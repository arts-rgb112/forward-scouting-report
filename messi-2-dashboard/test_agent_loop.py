import importlib.util
import asyncio
import os
import subprocess
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


def _init_git_repo(root: Path) -> None:
    """The executor role now writes directly under a workspace-write sandbox
    and `apply_workspace_changes` finds those writes via `git status
    --porcelain`, instead of parsing [FILE] blocks out of the response text.
    Tests that simulate an executor turn need a real (if empty) git repo at
    PROJECT_ROOT for that diff to work."""
    for argv in (
        ["git", "init", "-q"],
        ["git", "config", "user.email", "test@example.com"],
        ["git", "config", "user.name", "Test"],
    ):
        subprocess.run(argv, cwd=root, check=True, capture_output=True)


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

    def test_apply_workspace_changes_detects_a_direct_write_via_git_status(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _init_git_repo(root)
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                before = agent_loop.snapshot_workspace()
                target = root / "src/new.ts"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("export const created = true;", encoding="utf-8")
                applied = agent_loop.apply_workspace_changes(before)
            self.assertEqual(len(applied), 1)
            self.assertEqual(applied[0].path, "src/new.ts")
            self.assertGreater(applied[0].bytes_written, 0)

    def test_apply_workspace_changes_raises_when_nothing_changed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _init_git_repo(root)
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                before = agent_loop.snapshot_workspace()
                with self.assertRaises(agent_loop.AgentLoopError):
                    agent_loop.apply_workspace_changes(before)

    def test_apply_workspace_changes_reverts_a_write_to_the_loop_itself(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _init_git_repo(root)
            guarded = root / "agent_loop.py"
            guarded.write_text("original", encoding="utf-8")
            subprocess.run(["git", "add", "agent_loop.py"], cwd=root, check=True, capture_output=True)
            subprocess.run(
                ["git", "commit", "-q", "-m", "seed"], cwd=root, check=True, capture_output=True
            )
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                before = agent_loop.snapshot_workspace()
                guarded.write_text("tampered by a runaway turn", encoding="utf-8")
                (root / "src").mkdir()
                (root / "src/legit.ts").write_text("export const ok = true;", encoding="utf-8")
                with self.assertRaises(agent_loop.AgentLoopError):
                    agent_loop.apply_workspace_changes(before)
            self.assertEqual(guarded.read_text(encoding="utf-8"), "original")

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

    def test_acknowledgement_footer_requests_only_explicit_reactions(self):
        message = agent_loop.with_acknowledgement_footer("검증 완료")
        self.assertTrue(message.startswith("검증 완료"))
        self.assertIn("👀 읽음", message)
        self.assertIn("✅ 동의/승인", message)
        self.assertIn("❓ 질문", message)

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

    def test_call_agent_passes_private_reference_images_with_codex_image_flag(self):
        def fake_run(argv, **kwargs):
            output_path = Path(argv[argv.index("--output-last-message") + 1])
            output_path.write_text("DONE\n", encoding="utf-8")
            self.assertEqual(argv[argv.index("--image") + 1], str(image))
            self.assertEqual(argv[-1], "-")
            return CompletedProcess(args=argv, returncode=0, stdout="", stderr="")

        with tempfile.TemporaryDirectory() as temp_dir:
            image = Path(temp_dir) / "reference.png"
            image.write_bytes(b"png")
            with patch.object(agent_loop.subprocess, "run", side_effect=fake_run):
                result = agent_loop.call_agent(
                    agent_loop.CodexCliRunner(executable="codex.exe"),
                    role="executor",
                    instructions="Use the reference.",
                    prompt="Implement the approved design.",
                    timeout_seconds=10,
                    image_paths=[image],
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

    def test_opinion_channel_is_disabled_when_unset(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test", bot_token="xoxb-test", channel_id="CEXEC"
        )
        self.assertIsNone(
            bridge.command_from_envelope(
                {
                    "payload": {
                        "type": "event_callback",
                        "event_id": "EvOpinionDisabled",
                        "event": {
                            "type": "message",
                            "channel": "CBRAIN",
                            "user": "U1",
                            "text": "태그 없는 안건",
                            "ts": "100.11",
                        },
                    }
                }
            )
        )

    def test_opinion_channel_accepts_untagged_humans_and_rejects_bots(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test",
            bot_token="xoxb-test",
            channel_id="CEXEC",
            opinion_channel_id="CBRAIN",
        )
        human = bridge.command_from_envelope(
            {
                "payload": {
                    "type": "event_callback",
                    "event_id": "EvOpinionHuman",
                    "event": {
                        "type": "message",
                        "channel": "CBRAIN",
                        "user": "U1",
                        "text": "이 설계의 트레이드오프는?",
                        "ts": "100.12",
                    },
                }
            }
        )
        self.assertIsNotNone(human)
        assert human is not None
        self.assertEqual(human.text, "이 설계의 트레이드오프는?")
        self.assertEqual(human.channel_id, "CBRAIN")
        self.assertEqual(human.thread_ts, "100.12")
        self.assertIsNone(
            bridge.command_from_envelope(
                {
                    "payload": {
                        "type": "event_callback",
                        "event_id": "EvOpinionBot",
                        "event": {
                            "type": "message",
                            "subtype": "bot_message",
                            "channel": "CBRAIN",
                            "user": "UOTHERBOT",
                            "bot_id": "BOTHER",
                            "text": "do not loop",
                            "ts": "100.13",
                        },
                    }
                }
            )
        )

    def test_slack_socket_keeps_only_safe_image_attachment_metadata(self):
        bridge = agent_loop.SlackSocketBridge(
            app_token="xapp-test", bot_token="xoxb-test", channel_id="C123"
        )
        command = bridge.command_from_envelope(
            {
                "payload": {
                    "type": "event_callback",
                    "event_id": "EvImage",
                    "event": {
                        "type": "app_mention",
                        "channel": "C123",
                        "user": "U1",
                        "text": "<@UBOT> [PLAN] use attached layout",
                        "ts": "100.15",
                        "files": [
                            {
                                "id": "FPNG",
                                "name": "layout.png",
                                "mimetype": "image/png",
                                "size": 1024,
                                "url_private": "https://files.slack.com/private/secret",
                            },
                            {
                                "id": "FSVG",
                                "name": "ignored.svg",
                                "mimetype": "image/svg+xml",
                                "size": 1024,
                            },
                        ],
                    },
                }
            }
        )
        self.assertIsNotNone(command)
        assert command is not None
        self.assertEqual(command.attachments, (
            agent_loop.SlackAttachment("FPNG", "layout.png", "image/png", 1024),
        ))

    def test_thread_store_persists_image_ids_without_private_urls(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            state = store.load("C123", "100.16")
            agent_loop.SlackThreadStore.append_message(
                state,
                action="PLAN",
                actor="human:U1",
                text="reference attached",
                event_ts="1",
                attachments=[agent_loop.SlackAttachment("FPNG", "layout.png", "image/png", 1024)],
            )
            store.save(state)
            restored = store.load("C123", "100.16")
            self.assertEqual(
                agent_loop.SlackThreadStore.attachments(restored),
                (agent_loop.SlackAttachment("FPNG", "layout.png", "image/png", 1024),),
            )
            self.assertNotIn("url_private", store._path("C123", "100.16").read_text(encoding="utf-8"))

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

    def test_shared_collaboration_message_is_captured_and_read_marked_without_becoming_command(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            context_store = agent_loop.SlackContextStore(Path(temp_dir) / "context")
            bridge = agent_loop.SlackSocketBridge(
                app_token="xapp-test",
                bot_token="xoxb-test",
                channel_id="CEXEC",
                opinion_channel_id="CBRAIN",
                context_channel_ids={"CTODO"},
                shared_channel_ids={"CEXEC", "CBRAIN", "CTODO"},
                read_markers_enabled=True,
                context_store=context_store,
            )
            envelope = {
                "payload": {
                    "type": "event_callback",
                    "event_id": "EvBrain",
                    "event": {
                        "type": "message",
                        "channel": "CBRAIN",
                        "user": "UCLAUDE",
                        "text": "범위 충돌을 발견했습니다.",
                        "ts": "100.58",
                    },
                }
            }
            with patch.object(bridge, "_mark_read", return_value=True) as marker:
                self.assertTrue(bridge.capture_context_from_envelope(envelope))
            marker.assert_called_once_with("CBRAIN", "100.58")
            self.assertIn("범위 충돌", context_store.context({"CBRAIN"}))

    def test_shared_collaboration_channel_ids_unions_all_configured_channels(self):
        with patch.dict(
            os.environ,
            {
                "SLACK_CHANNEL_ID": "CEXEC",
                "SLACK_OPINION_CHANNEL_ID": "CBRAIN",
                "SLACK_BRAINSHOWER_CHANNEL_ID": "CBRAIN2",
                "SLACK_CONTEXT_CHANNEL_IDS": "CTODO, COKR",
            },
            clear=True,
        ):
            self.assertEqual(
                agent_loop.shared_collaboration_channel_ids(),
                frozenset({"CEXEC", "CBRAIN", "CBRAIN2", "CTODO", "COKR"}),
            )

    def test_recorded_acknowledgements_reports_reactions_not_false_read_receipts(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir) / "state")
            store.save(store.load("CBRAIN", "100.60"))
            bridge = agent_loop.SlackSocketBridge(
                app_token="xapp-test",
                bot_token="xoxb-test",
                channel_id="CEXEC",
                opinion_channel_id="CBRAIN",
                shared_channel_ids={"CEXEC", "CBRAIN"},
                state_store=store,
            )
            bridge.bot_user_id = "UBOT"
            with patch.object(
                bridge,
                "_query_request",
                return_value={
                    "messages": [
                        {"user": "UBOT", "ts": "100.61", "reactions": []},
                        {
                            "user": "UBOT",
                            "ts": "100.62",
                            "reactions": [
                                {"name": "eyes", "users": ["UBOT", "UCLAUDE"]},
                                {"name": "thumbsup", "users": ["UCLAUDE"]},
                            ],
                        },
                    ]
                },
            ):
                result = bridge.recorded_acknowledgements()
            self.assertEqual(result["recordedThreads"], 1)
            self.assertEqual(result["agentPosts"], 2)
            self.assertEqual(result["acknowledgedPosts"], 1)
            self.assertEqual(result["acknowledgements"][0]["reactions"], [{"reaction": "eyes", "count": 1}])
            self.assertIn("unknown", result["note"])

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

    def test_only_allowlisted_claude_can_save_brainshower_escalation(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            command = agent_loop.SlackCommand(
                event_id="EvEscalate",
                user_id="UCLAUDE",
                text="[ESCALATE] the specification conflicts with the data contract",
                channel_id="C123",
                thread_ts="200.15",
                event_ts="1",
                actor_type="allowed_bot",
                bot_id="BCLAUDE",
            )
            with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                with patch.object(sink, "_bot_post"):
                    self.assertEqual(
                        agent_loop.handle_slack_command(
                            command, max_iterations=1, test_timeout=1, state_store=store
                        ),
                        0,
                    )
            self.assertTrue(agent_loop.SlackThreadStore.has_allowed_bot_escalation(
                store.load("C123", "200.15")
            ))

    def test_brainshower_post_requires_claude_and_codex_agreement_then_pauses_thread(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _init_git_repo(root)
            store = agent_loop.SlackThreadStore(root / "state")
            state = store.load("C123", "200.18")
            agent_loop.SlackThreadStore.append_message(
                state,
                action="ESCALATE",
                actor="allowed_bot:UCLAUDE",
                text="the two contracts conflict",
                event_ts="1",
            )
            store.save(state)
            command = agent_loop.SlackCommand(
                event_id="EvConfirmEscalation",
                user_id="U1",
                text="[APPLY] independently assess the Claude escalation",
                channel_id="C123",
                thread_ts="200.18",
                event_ts="2",
            )
            execution_sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            brainshower_sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="CBRAIN")
            response = """[BRAINSHOWER]
발견: 명세와 계약이 충돌합니다.
근거: 동일 필드가 두 계산 경로를 가집니다.
선택지: A 또는 B.
필요 결정: 정본 경로를 선택해 주세요.
[/BRAINSHOWER]"""
            with patch.object(agent_loop, "PROJECT_ROOT", root):
                with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=execution_sink):
                    with patch.object(execution_sink, "_bot_post"), patch.object(execution_sink, "react"):
                        with patch.object(brainshower_sink, "_bot_post") as brain_post:
                            with patch.object(
                                agent_loop,
                                "brainshower_sink_from_environment",
                                return_value=brainshower_sink,
                            ):
                                with patch.object(
                                    agent_loop,
                                    "build_codex_runner",
                                    return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                                ):
                                    with patch.object(agent_loop, "call_agent", return_value=response):
                                        with patch.object(agent_loop, "apply_workspace_changes") as apply_changes:
                                            with patch.object(agent_loop, "run_tests") as run_tests:
                                                self.assertEqual(
                                                    agent_loop.handle_slack_command(
                                                        command,
                                                        max_iterations=1,
                                                        test_timeout=1,
                                                        state_store=store,
                                                    ),
                                                    0,
                                                )
            self.assertEqual(brain_post.call_count, 1)
            apply_changes.assert_not_called()
            run_tests.assert_not_called()
            self.assertEqual(store.load("C123", "200.18")["status"], "brainshower_pending")

    def test_apply_invokes_exactly_one_codex_turn_and_one_test_run(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _init_git_repo(root)
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

            def write_one_directly(*args, **kwargs):
                target = root / "src/one.ts"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("export const one = 1;", encoding="utf-8")
                return "Wrote src/one.ts as requested."

            with patch.object(agent_loop, "PROJECT_ROOT", root):
                with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                    with patch.object(sink, "_bot_post"):
                        with patch.object(sink, "react") as react:
                            with patch.object(
                                agent_loop,
                                "build_codex_runner",
                                return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                            ):
                                with patch.object(agent_loop, "call_agent", side_effect=write_one_directly) as call_agent:
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
            # A distinct 'working on this exact message' marker lands separately
            # from the passive context-ingestion 👀 marker, and a second marker
            # confirms completion once tests pass -- so a human can tell "seen"
            # apart from "actually being worked on right now" at a glance.
            react.assert_any_call("C123", "2", "hammer")
            react.assert_any_call("C123", "2", "white_check_mark")

    def test_apply_downloads_planned_images_only_before_codex_turn(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _init_git_repo(root)
            store = agent_loop.SlackThreadStore(root / "state")
            prior = store.load("C123", "200.25")
            agent_loop.SlackThreadStore.append_message(
                prior,
                action="PLAN",
                actor="human:U1",
                text="match the attached layout",
                event_ts="1",
                attachments=[agent_loop.SlackAttachment("FPNG", "layout.png", "image/png", 1024)],
            )
            store.save(prior)
            command = agent_loop.SlackCommand(
                event_id="EvApplyImage",
                user_id="U1",
                text="[APPLY] apply the approved layout",
                channel_id="C123",
                thread_ts="200.25",
                event_ts="2",
            )
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="C123")
            passed = agent_loop.TestResult(["test"], 0, "ok", 0.1)
            test_case = self

            class FakeDownloader:
                def download(self, attachments, destination):
                    test_case.assertEqual(attachments[0].file_id, "FPNG")
                    image = destination / "reference-1.png"
                    image.write_bytes(b"png")
                    return [image]

            with patch.object(agent_loop, "PROJECT_ROOT", root):
                with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                    with patch.object(sink, "_bot_post"), patch.object(sink, "react"):
                        with patch.object(
                            agent_loop,
                            "build_codex_runner",
                            return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                        ):
                            with patch.object(
                                agent_loop.SlackImageDownloader,
                                "from_environment",
                                return_value=FakeDownloader(),
                            ):
                                def call_with_live_image(*args, **kwargs):
                                    image_paths = kwargs["image_paths"]
                                    self.assertEqual(len(image_paths), 1)
                                    self.assertTrue(image_paths[0].is_file())
                                    self.assertEqual(image_paths[0].read_bytes(), b"png")
                                    target = root / "src/image.ts"
                                    target.parent.mkdir(parents=True, exist_ok=True)
                                    target.write_text("export const image = true;", encoding="utf-8")
                                    return "Wrote src/image.ts as requested."

                                with patch.object(agent_loop, "call_agent", side_effect=call_with_live_image) as call_agent:
                                    with patch.object(agent_loop, "run_tests", return_value=passed):
                                        self.assertEqual(
                                            agent_loop.handle_slack_command(
                                                command,
                                                max_iterations=1,
                                                test_timeout=1,
                                                state_store=store,
                                            ),
                                            0,
                                        )
            self.assertEqual(len(call_agent.call_args.kwargs["image_paths"]), 1)

    def test_apply_includes_read_only_report_context_without_extra_codex_turn(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            _init_git_repo(root)
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

            def write_context_directly(*args, **kwargs):
                target = root / "src/context.ts"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("export const context = true;", encoding="utf-8")
                return "Wrote src/context.ts as requested."

            with patch.dict(os.environ, {"SLACK_CONTEXT_CHANNEL_IDS": "CTODO,COKR"}, clear=False):
                with patch.object(agent_loop, "PROJECT_ROOT", root):
                    with patch.object(agent_loop.SlackAuditSink, "from_environment", return_value=sink):
                        with patch.object(sink, "_bot_post"), patch.object(sink, "react"):
                            with patch.object(
                                agent_loop,
                                "build_codex_runner",
                                return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                            ):
                                with patch.object(agent_loop, "call_agent", side_effect=write_context_directly) as call_agent:
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

    def test_opinion_handler_is_read_only_image_aware_and_uses_separate_two_turn_budget(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir) / "state")
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="CBRAIN")
            context_file = Path(temp_dir) / "BRAINSHOWER_CONTEXT.md"
            context_file.write_text("context-for-test", encoding="utf-8")

            class FakeDownloader:
                def download(self, attachments, destination):
                    self.assertion = attachments
                    image = destination / "reference-1.png"
                    image.write_bytes(b"png")
                    return [image]

            calls = []

            def read_only_opinion(*args, **kwargs):
                self.assertEqual(kwargs["role"], "planner")
                self.assertIn("Do not implement anything", kwargs["instructions"])
                self.assertTrue(kwargs["image_paths"][0].is_file())
                calls.append(kwargs["prompt"])
                return "Feasible, with a bounded trade-off."

            commands = [
                agent_loop.SlackCommand(
                    event_id=f"EvOpinion{index}",
                    user_id="U1",
                    text=(
                        "[조사] 추가 근거를 확인해 주세요"
                        if index == 4
                        else "[조사] 두 번째 추가조사"
                        if index == 5
                        else f"의견 {index}"
                    ),
                    channel_id="CBRAIN",
                    thread_ts="300.1",
                    event_ts=str(index),
                    attachments=(
                        (agent_loop.SlackAttachment("FPNG", "layout.png", "image/png", 1024),)
                        if index == 1
                        else ()
                    ),
                )
                for index in range(1, 6)
            ]
            with patch.object(agent_loop, "opinion_sink_from_environment", return_value=sink), patch.object(
                agent_loop, "BRAINSHOWER_CONTEXT_FILE", context_file
            ):
                with patch.object(sink, "_bot_post") as post:
                    with patch.object(
                        agent_loop,
                        "build_codex_runner",
                        return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                    ):
                        with patch.object(
                            agent_loop.SlackImageDownloader,
                            "from_environment",
                            return_value=FakeDownloader(),
                        ):
                            with patch.object(agent_loop, "call_agent", side_effect=read_only_opinion):
                                with patch.object(agent_loop, "apply_file_changes") as apply_changes:
                                    with patch.object(agent_loop, "run_tests") as tests:
                                        results = [
                                            agent_loop.handle_opinion_command(
                                                command,
                                                agent_timeout=1,
                                                state_store=store,
                                            )
                                            for command in commands
                                        ]
            self.assertEqual(results, [0, 0, 0, 0, 0])
            self.assertEqual(len(calls), 3)
            self.assertIn("BRAINSHOWER LOCAL CONTEXT PACK", calls[2])
            self.assertIn("context-for-test", calls[2])
            self.assertIn("CURRENT HUMAN ADDITIONAL RESEARCH", calls[2])
            apply_changes.assert_not_called()
            tests.assert_not_called()
            state = store.load("CBRAIN", "300.1")
            self.assertEqual(state["opinionCount"], 2)
            self.assertEqual(state["researchCount"], 1)
            self.assertEqual(state["executionCount"], 0)
            self.assertTrue(any("OPINION LIMIT" in call.args[0] for call in post.call_args_list))
            self.assertTrue(any("RESEARCH LIMIT" in call.args[0] for call in post.call_args_list))
            forbidden = {"apply_file_changes", "run_tests", "subprocess", "shutil"}
            self.assertTrue(forbidden.isdisjoint(agent_loop.handle_opinion_command.__code__.co_names))

    def test_research_requires_two_automatic_opinions_and_an_exact_prefix(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir) / "state")
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="CBRAIN")
            command = agent_loop.SlackCommand(
                event_id="EvEarlyResearch",
                user_id="U1",
                text="[조사] 아직 자동 의견이 남았나요?",
                channel_id="CBRAIN",
                thread_ts="300.2",
                event_ts="1",
            )
            with patch.object(agent_loop, "opinion_sink_from_environment", return_value=sink):
                with patch.object(sink, "_bot_post") as post:
                    with patch.object(agent_loop, "call_agent") as call_agent:
                        result = agent_loop.handle_opinion_command(command, state_store=store)
            self.assertEqual(result, 0)
            call_agent.assert_not_called()
            self.assertTrue(any("RESEARCH PENDING" in call.args[0] for call in post.call_args_list))
            state = store.load("CBRAIN", "300.2")
            self.assertEqual(state.get("researchCount", 0), 0)

    def test_thread_owner_can_add_read_only_research_capacity(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir) / "state")
            seed = store.load("CBRAIN", "300.3")
            seed.update({"opinionCount": 2, "brainshowerOwnerUserId": "U1"})
            store.save(seed)
            sink = agent_loop.SlackAuditSink(bot_token="xoxb-test", channel_id="CBRAIN")
            approval = agent_loop.SlackCommand(
                event_id="EvApproval",
                user_id="U1",
                text="2회 추가승인",
                channel_id="CBRAIN",
                thread_ts="300.3",
                event_ts="1",
            )
            research = [
                agent_loop.SlackCommand(
                    event_id=f"EvResearch{index}",
                    user_id="U1",
                    text=f"[조사] 근거 {index}",
                    channel_id="CBRAIN",
                    thread_ts="300.3",
                    event_ts=str(index + 1),
                )
                for index in range(1, 5)
            ]
            with patch.object(agent_loop, "opinion_sink_from_environment", return_value=sink):
                with patch.object(sink, "_bot_post") as post:
                    with patch.object(
                        agent_loop,
                        "build_codex_runner",
                        return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                    ):
                        with patch.object(agent_loop, "call_agent", return_value="read-only") as call_agent:
                            self.assertEqual(
                                agent_loop.handle_opinion_command(approval, state_store=store), 0
                            )
                            self.assertEqual(
                                [agent_loop.handle_opinion_command(item, state_store=store) for item in research],
                                [0, 0, 0, 0],
                            )
            self.assertEqual(call_agent.call_count, 3)
            state = store.load("CBRAIN", "300.3")
            self.assertEqual(state["researchApprovalCount"], 2)
            self.assertEqual(state["researchCount"], 3)
            self.assertTrue(any("RESEARCH APPROVED" in call.args[0] for call in post.call_args_list))
            self.assertTrue(any("RESEARCH LIMIT" in call.args[0] for call in post.call_args_list))

    def test_research_approval_parser_accepts_only_the_explicit_human_forms(self):
        self.assertEqual(agent_loop.parse_brainshower_research_approval("3회 추가승인"), 3)
        self.assertEqual(agent_loop.parse_brainshower_research_approval("추가승인 4회"), 4)
        self.assertEqual(agent_loop.parse_brainshower_research_approval("2회 추가조사 승인"), 2)
        self.assertEqual(agent_loop.parse_brainshower_research_approval("추가조사 2회 승인"), 2)
        self.assertIsNone(agent_loop.parse_brainshower_research_approval("3회 추가 조사"))
        with self.assertRaises(agent_loop.AgentLoopError):
            agent_loop.parse_brainshower_research_approval("11회 추가승인")

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
            _init_git_repo(root)
            task = root / "task.md"
            task.write_text("one bounded change", encoding="utf-8")
            sink = agent_loop.SlackAuditSink()
            passed = agent_loop.TestResult(["test"], 0, "ok", 0.1)

            def write_once_directly(*args, **kwargs):
                target = root / "src/once.ts"
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("export const once = true;", encoding="utf-8")
                return "Wrote src/once.ts as requested."

            with patch.object(agent_loop, "PROJECT_ROOT", root):
                with patch.object(
                    agent_loop,
                    "build_codex_runner",
                    return_value=(agent_loop.CodexCliRunner("codex"), "ready"),
                ):
                    with patch.object(agent_loop, "call_agent", side_effect=write_once_directly) as call_agent:
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

    def test_pending_dm_only_pages_explicit_stale_plan_once(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            state = store.load("C123", "100.0")
            agent_loop.SlackThreadStore.append_message(
                state,
                action="PLAN",
                actor="human:UOWNER",
                text="배포 승인 대기",
                event_ts="100.0",
            )
            store.save(state)

            class Sink:
                enabled = True
                reason = None

                def __init__(self):
                    self.posts = []

                def post(self, body):
                    self.posts.append(body)

            sink = Sink()
            first = agent_loop.dispatch_pending_dms(store, sink, now=410.0)
            second = agent_loop.dispatch_pending_dms(store, sink, now=420.0)
            self.assertEqual(first["sent"], 1)
            self.assertEqual(second["suppressed"], 1)
            self.assertEqual(len(sink.posts), 1)

    def test_pending_dm_ignores_discussion_and_recent_plan(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            store = agent_loop.SlackThreadStore(Path(temp_dir))
            state = store.load("C123", "100.0")
            agent_loop.SlackThreadStore.append_message(
                state,
                action="DISCUSS",
                actor="human:UOWNER",
                text="아이디어 논의",
                event_ts="100.0",
            )
            store.save(state)
            self.assertEqual(agent_loop.pending_dm_candidates(store, now=1_000.0), [])

    def test_tail_is_limited_to_3000_characters(self):
        result = agent_loop.run_tests(
            command=[sys.executable, "-c", "print('x' * 5000)"], timeout_seconds=10
        )
        self.assertEqual(result.returncode, 0)
        self.assertLessEqual(len(result.output_tail), 3000)


if __name__ == "__main__":
    unittest.main()
