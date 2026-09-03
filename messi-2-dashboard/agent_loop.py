#!/usr/bin/env python3
"""Bounded local planner/coder loop for frontend implementation work."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import shlex
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Iterable, Sequence


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_TASK_FILE = PROJECT_ROOT / "TASK_ORDER.md"
DEFAULT_REPORT_FILE = PROJECT_ROOT / "AGENT_LOOP_REPORT.md"
DEFAULT_TEST_COMMAND = "npm test -- --watchAll=false"
MAX_TEST_TAIL = 3_000
MAX_CONTEXT_FILE_BYTES = 160_000
MAX_SLACK_CHUNK = 3_000

FILE_BLOCK_RE = re.compile(
    r"(?ms)^\[FILE:\s*([^\]\r\n]+?)\s*\]\s*\r?\n"
    r"```(?:[^\r\n`]*)\r?\n(.*?)\r?\n```[ \t]*$"
)
READ_RE = re.compile(r"(?m)^\[READ:\s*([^\]\r\n]+?)\s*\]\s*$")
DONE_RE = re.compile(r"(?m)^\s*DONE\s*$")
VITEST_WATCHALL_RE = re.compile(r"unknown option.*watchall", re.I)
SLACK_MENTION_RE = re.compile(r"<@[A-Z0-9]+>", re.I)


class AgentLoopError(RuntimeError):
    """Expected, user-actionable loop failure."""


@dataclass(frozen=True)
class TestResult:
    command: list[str]
    returncode: int
    output_tail: str
    duration_seconds: float
    timed_out: bool = False
    compatibility_retry: bool = False

    @property
    def passed(self) -> bool:
        return self.returncode == 0 and not self.timed_out


@dataclass(frozen=True)
class AppliedChange:
    path: str
    bytes_written: int


@dataclass(frozen=True)
class SlackCommand:
    event_id: str
    user_id: str
    text: str
    channel_id: str
    thread_ts: str
    event_ts: str


def configure_stdio() -> None:
    """Force stable UTF-8 output even from a CP949 Windows console."""
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="replace")


def normalized_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    env = dict(os.environ if base is None else base)
    env["CI"] = "true"
    env["PYTHONIOENCODING"] = "utf-8"
    env["PYTHONUTF8"] = "1"
    return env


def build_client() -> tuple[Any | None, str]:
    """Create an OpenAI client, or return a safe status instead of raising."""
    if not os.environ.get("OPENAI_API_KEY", "").strip():
        return None, "OPENAI_API_KEY is not set"
    try:
        from openai import OpenAI
    except (ImportError, OSError) as exc:
        return _StdlibOpenAIClient(os.environ["OPENAI_API_KEY"]), "ready (stdlib HTTPS fallback)"
    try:
        return OpenAI(), "ready"
    except Exception as exc:
        return None, f"OpenAI client initialization failed: {type(exc).__name__}: {exc}"


class _StdlibResponses:
    """Small Responses API fallback used when the optional SDK is unavailable."""

    def __init__(self, api_key: str) -> None:
        self._api_key = api_key

    def create(self, **payload: Any) -> SimpleNamespace:
        request = urllib.request.Request(
            "https://api.openai.com/v1/responses",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self._api_key}",
                "Content-Type": "application/json",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=120) as response:
                body = json.loads(response.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as exc:
            raise AgentLoopError(f"Responses API HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise AgentLoopError(f"Responses API network error: {exc.reason}") from exc
        chunks: list[str] = []
        for item in body.get("output", []):
            for content in item.get("content", []):
                text = content.get("text")
                if content.get("type") == "output_text" and isinstance(text, str):
                    chunks.append(text)
        return SimpleNamespace(output_text="".join(chunks))


class _StdlibOpenAIClient:
    def __init__(self, api_key: str) -> None:
        self.responses = _StdlibResponses(api_key)


ANSI_RE = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
AUDIT_SECRET_RES = (
    re.compile(r"sk-[A-Za-z0-9_-]{12,}"),
    re.compile(r"xox[baprs]-[A-Za-z0-9-]{10,}"),
    re.compile(r"https://hooks\.slack\.com/services/\S+", re.I),
    re.compile(r"(?i)(authorization\s*:\s*bearer\s+)\S+"),
)


def redact_audit_text(value: str) -> str:
    text = ANSI_RE.sub("", value)
    for pattern in AUDIT_SECRET_RES:
        if pattern.groups:
            text = pattern.sub(r"\1[REDACTED]", text)
        else:
            text = pattern.sub("[REDACTED]", text)
    return text


def _chunks(value: str, size: int = MAX_SLACK_CHUNK) -> list[str]:
    value = value or "(empty)"
    return [value[index : index + size] for index in range(0, len(value), size)]


class SlackAuditSink:
    """Write a redacted run transcript to one Slack channel/thread."""

    def __init__(
        self,
        *,
        bot_token: str = "",
        channel_id: str = "",
        webhook_url: str = "",
        required: bool = False,
    ) -> None:
        self.bot_token = bot_token
        self.channel_id = channel_id
        self.webhook_url = webhook_url
        self.required = required
        self.thread_ts: str | None = None
        self.disabled_reason: str | None = None

    @classmethod
    def from_environment(cls, *, required: bool = False) -> "SlackAuditSink":
        token = os.environ.get("SLACK_BOT_TOKEN", "").strip()
        channel = os.environ.get("SLACK_CHANNEL_ID", "").strip()
        webhook = os.environ.get("SLACK_WEBHOOK_URL", "").strip()
        sink = cls(bot_token=token, channel_id=channel, webhook_url=webhook, required=required)
        if bool(token) != bool(channel) and not webhook:
            sink.disabled_reason = "SLACK_BOT_TOKEN and SLACK_CHANNEL_ID must be set together"
        elif not sink.enabled:
            sink.disabled_reason = "Slack credentials are not set"
        if required and not sink.enabled:
            raise AgentLoopError(sink.disabled_reason or "Slack audit is unavailable")
        return sink

    @property
    def mode(self) -> str:
        if self.bot_token and self.channel_id:
            return "bot-thread"
        if self.webhook_url:
            return "incoming-webhook"
        return "disabled"

    @property
    def enabled(self) -> bool:
        return self.mode != "disabled"

    def status(self) -> dict[str, Any]:
        return {
            "enabled": self.enabled,
            "mode": self.mode,
            "required": self.required,
            "channelConfigured": bool(self.channel_id),
            "threadStarted": bool(self.thread_ts),
            "reason": self.disabled_reason,
        }

    def _bot_post(self, text: str, *, root: bool) -> None:
        payload: dict[str, Any] = {
            "channel": self.channel_id,
            "text": text,
            "unfurl_links": False,
            "unfurl_media": False,
        }
        if self.thread_ts and not root:
            payload["thread_ts"] = self.thread_ts
        request = urllib.request.Request(
            "https://slack.com/api/chat.postMessage",
            data=json.dumps(payload).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {self.bot_token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as exc:
            raise AgentLoopError(f"Slack HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise AgentLoopError(f"Slack network error: {exc.reason}") from exc
        if body.get("ok") is not True:
            raise AgentLoopError(f"Slack API error: {body.get('error', 'unknown_error')}")
        if root:
            thread_ts = body.get("ts")
            if not isinstance(thread_ts, str) or not thread_ts:
                raise AgentLoopError("Slack root message returned no thread timestamp")
            self.thread_ts = thread_ts

    def _webhook_post(self, text: str) -> None:
        request = urllib.request.Request(
            self.webhook_url,
            data=json.dumps({"text": text}).encode("utf-8"),
            headers={"Content-Type": "application/json; charset=utf-8"},
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                if response.status < 200 or response.status >= 300:
                    raise AgentLoopError(f"Slack webhook HTTP {response.status}")
        except urllib.error.HTTPError as exc:
            raise AgentLoopError(f"Slack webhook HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise AgentLoopError(f"Slack webhook network error: {exc.reason}") from exc

    def post(self, label: str, body: str, *, root: bool = False) -> None:
        if not self.enabled:
            if self.required:
                raise AgentLoopError(self.disabled_reason or "Slack audit is unavailable")
            return
        safe = redact_audit_text(body)
        pieces = _chunks(safe)
        for index, piece in enumerate(pieces, start=1):
            suffix = f" ({index}/{len(pieces)})" if len(pieces) > 1 else ""
            message = f"*{label}{suffix}*\n```{piece}```"
            if self.mode == "bot-thread":
                self._bot_post(message, root=root and index == 1)
            else:
                self._webhook_post(message)


class SlackSocketBridge:
    """Receive bounded commands from one Slack channel over Socket Mode."""

    def __init__(self, *, app_token: str, bot_token: str, channel_id: str) -> None:
        if not app_token or not bot_token or not channel_id:
            raise AgentLoopError(
                "SLACK_APP_TOKEN, SLACK_BOT_TOKEN, and SLACK_CHANNEL_ID are required"
            )
        self.app_token = app_token
        self.bot_token = bot_token
        self.channel_id = channel_id
        self.bot_user_id = ""
        self.active_threads: set[str] = set()
        self.seen_event_ids: set[str] = set()
        self._seen_event_order: list[str] = []

    @classmethod
    def from_environment(cls) -> "SlackSocketBridge":
        return cls(
            app_token=os.environ.get("SLACK_APP_TOKEN", "").strip(),
            bot_token=os.environ.get("SLACK_BOT_TOKEN", "").strip(),
            channel_id=os.environ.get("SLACK_CHANNEL_ID", "").strip(),
        )

    @staticmethod
    def _json_request(url: str, token: str, payload: dict[str, Any] | None = None) -> dict[str, Any]:
        request = urllib.request.Request(
            url,
            data=json.dumps(payload or {}).encode("utf-8"),
            headers={
                "Authorization": f"Bearer {token}",
                "Content-Type": "application/json; charset=utf-8",
            },
            method="POST",
        )
        try:
            with urllib.request.urlopen(request, timeout=30) as response:
                body = json.loads(response.read().decode("utf-8", errors="replace"))
        except urllib.error.HTTPError as exc:
            raise AgentLoopError(f"Slack Socket API HTTP {exc.code}") from exc
        except urllib.error.URLError as exc:
            raise AgentLoopError(f"Slack Socket API network error: {exc.reason}") from exc
        if body.get("ok") is not True:
            raise AgentLoopError(f"Slack Socket API error: {body.get('error', 'unknown_error')}")
        return body

    def _socket_url(self) -> str:
        body = self._json_request("https://slack.com/api/apps.connections.open", self.app_token)
        url = body.get("url")
        if not isinstance(url, str) or not url.startswith("wss://"):
            raise AgentLoopError("Slack Socket API returned no WebSocket URL")
        return url

    def _resolve_bot_user_id(self) -> str:
        body = self._json_request("https://slack.com/api/auth.test", self.bot_token)
        user_id = body.get("user_id")
        if not isinstance(user_id, str) or not user_id:
            raise AgentLoopError("Slack auth.test returned no bot user ID")
        return user_id

    def _remember_event(self, event_id: str) -> bool:
        if not event_id or event_id in self.seen_event_ids:
            return False
        self.seen_event_ids.add(event_id)
        self._seen_event_order.append(event_id)
        if len(self._seen_event_order) > 2_000:
            expired = self._seen_event_order.pop(0)
            self.seen_event_ids.discard(expired)
        return True

    def command_from_envelope(self, envelope: dict[str, Any]) -> SlackCommand | None:
        payload = envelope.get("payload")
        if not isinstance(payload, dict) or payload.get("type") != "event_callback":
            return None
        event = payload.get("event")
        if not isinstance(event, dict) or event.get("channel") != self.channel_id:
            return None
        event_id = payload.get("event_id")
        if not isinstance(event_id, str) or not self._remember_event(event_id):
            return None
        if event.get("bot_id") or event.get("subtype") == "bot_message":
            return None
        user_id = event.get("user")
        if not isinstance(user_id, str) or not user_id or user_id == self.bot_user_id:
            return None
        event_type = event.get("type")
        event_ts = event.get("ts")
        text = event.get("text")
        if not isinstance(event_ts, str) or not isinstance(text, str):
            return None

        thread_ts = event.get("thread_ts") or event_ts
        if not isinstance(thread_ts, str) or not thread_ts:
            return None
        if event_type == "app_mention":
            text = SLACK_MENTION_RE.sub("", text).strip()
            self.active_threads.add(thread_ts)
        elif event_type == "message" and event.get("thread_ts") in self.active_threads:
            text = text.strip()
        else:
            return None
        if not text:
            return None
        return SlackCommand(
            event_id=event_id,
            user_id=user_id,
            text=text,
            channel_id=self.channel_id,
            thread_ts=thread_ts,
            event_ts=event_ts,
        )

    @staticmethod
    def _websockets_module() -> Any:
        try:
            import websockets
        except (ImportError, OSError) as exc:
            raise AgentLoopError(
                "Socket Mode requires the Python 'websockets' package"
            ) from exc
        return websockets

    async def check_connection(self) -> dict[str, Any]:
        websockets = self._websockets_module()
        url = await asyncio.to_thread(self._socket_url)
        async with websockets.connect(
            url, open_timeout=30, close_timeout=10, ping_interval=20, max_size=1_000_000
        ) as socket:
            raw = await asyncio.wait_for(socket.recv(), timeout=30)
            hello = json.loads(raw)
            if hello.get("type") != "hello":
                raise AgentLoopError("Slack Socket Mode did not return a hello envelope")
        return {"connected": True, "hello": True, "channelConfigured": True}

    async def listen(self, handler: Callable[[SlackCommand], int]) -> None:
        websockets = self._websockets_module()
        self.bot_user_id = await asyncio.to_thread(self._resolve_bot_user_id)
        backoff = 1
        while True:
            url = await asyncio.to_thread(self._socket_url)
            try:
                async with websockets.connect(
                    url,
                    open_timeout=30,
                    close_timeout=10,
                    ping_interval=20,
                    max_size=1_000_000,
                ) as socket:
                    backoff = 1
                    async for raw in socket:
                        envelope = json.loads(raw)
                        envelope_id = envelope.get("envelope_id")
                        if isinstance(envelope_id, str) and envelope_id:
                            await socket.send(json.dumps({"envelope_id": envelope_id}))
                        command = self.command_from_envelope(envelope)
                        if command is not None:
                            try:
                                await asyncio.to_thread(handler, command)
                            except Exception as exc:
                                print(
                                    f"agent_loop: Slack command failed: {type(exc).__name__}",
                                    file=sys.stderr,
                                )
                        if envelope.get("type") == "disconnect" and envelope.get("reason") == "link_disabled":
                            raise AgentLoopError("Slack Socket Mode was disabled")
            except AgentLoopError:
                raise
            except Exception as exc:
                print(
                    f"agent_loop: Slack socket reconnect after {type(exc).__name__}",
                    file=sys.stderr,
                )
                await asyncio.sleep(backoff)
                backoff = min(backoff * 2, 30)


def _safe_project_path(raw_path: str) -> Path:
    normalized = raw_path.strip().replace("\\", "/")
    candidate = Path(normalized)
    if not normalized or candidate.is_absolute():
        raise AgentLoopError(f"absolute or empty paths are forbidden: {raw_path!r}")
    if any(part in {"", ".", ".."} for part in candidate.parts):
        raise AgentLoopError(f"path traversal is forbidden: {raw_path!r}")
    if candidate.parts[0].lower() in {".git", "node_modules", "dist"}:
        raise AgentLoopError(f"generated or repository-internal path is forbidden: {raw_path!r}")
    if candidate.name.lower().startswith(".env"):
        raise AgentLoopError(f"environment files are forbidden: {raw_path!r}")
    if candidate.as_posix().lower() == "agent_loop.py":
        raise AgentLoopError("the loop may not rewrite itself")
    resolved = (PROJECT_ROOT / candidate).resolve()
    try:
        resolved.relative_to(PROJECT_ROOT)
    except ValueError as exc:
        raise AgentLoopError(f"path escapes project root: {raw_path!r}") from exc
    return resolved


def extract_file_changes(response_text: str) -> list[tuple[str, str]]:
    matches = [(path.strip(), content) for path, content in FILE_BLOCK_RE.findall(response_text)]
    seen: set[str] = set()
    for raw_path, _ in matches:
        key = raw_path.replace("\\", "/").casefold()
        if key in seen:
            raise AgentLoopError(f"duplicate [FILE] block: {raw_path}")
        seen.add(key)
    return matches


def apply_file_changes(response_text: str) -> list[AppliedChange]:
    """Atomically replace UTF-8 files emitted as [FILE: relative/path] blocks."""
    changes = extract_file_changes(response_text)
    if not changes:
        raise AgentLoopError("coder response contained no valid [FILE] blocks")
    staged = [(_safe_project_path(raw_path), content) for raw_path, content in changes]
    applied: list[AppliedChange] = []
    for target, content in staged:
        target.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            errors="strict",
            newline="\n",
            dir=target.parent,
            prefix=f".{target.name}.",
            suffix=".tmp",
            delete=False,
        ) as handle:
            handle.write(content)
            temporary = Path(handle.name)
        os.replace(temporary, target)
        applied.append(
            AppliedChange(
                path=target.relative_to(PROJECT_ROOT).as_posix(),
                bytes_written=len(content.encode("utf-8")),
            )
        )
    return applied


def _split_command(command: str | Sequence[str]) -> list[str]:
    if not isinstance(command, str):
        return list(command)
    return shlex.split(command, posix=os.name != "nt")


def _windows_executable(argv: list[str]) -> list[str]:
    if os.name == "nt" and argv and argv[0].lower() in {"npm", "npx", "pnpm", "yarn"}:
        argv[0] = f"{argv[0]}.cmd"
    return argv


def _run_process(argv: list[str], timeout_seconds: int) -> TestResult:
    started = time.monotonic()
    flags = subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
    process = subprocess.Popen(
        argv,
        cwd=PROJECT_ROOT,
        env=normalized_environment(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=flags,
    )
    timed_out = False
    try:
        output, _ = process.communicate(timeout=timeout_seconds)
    except subprocess.TimeoutExpired:
        timed_out = True
        process.kill()
        output, _ = process.communicate()
        output += f"\n[agent_loop] test timeout after {timeout_seconds}s"
    return TestResult(
        command=argv,
        returncode=process.returncode if process.returncode is not None else 124,
        output_tail=output[-MAX_TEST_TAIL:],
        duration_seconds=round(time.monotonic() - started, 3),
        timed_out=timed_out,
    )


def run_tests(command: str | Sequence[str] | None = None, timeout_seconds: int = 900) -> TestResult:
    """Run tests in a child process and return the exit code plus final 3,000 chars."""
    configured = command or os.environ.get("AGENT_TEST_COMMAND", DEFAULT_TEST_COMMAND)
    argv = _windows_executable(_split_command(configured))
    result = _run_process(argv, timeout_seconds)
    if result.returncode != 0 and "--watchAll=false" in argv and VITEST_WATCHALL_RE.search(result.output_tail):
        retry = _run_process([part for part in argv if part != "--watchAll=false"], timeout_seconds)
        return TestResult(**{**asdict(retry), "compatibility_retry": True})
    return result


def _read_utf8(path: Path, limit: int = MAX_CONTEXT_FILE_BYTES) -> str:
    data = path.read_bytes()
    if len(data) > limit:
        raise AgentLoopError(f"context file exceeds {limit} bytes: {path}")
    return data.decode("utf-8", errors="replace")


def collect_requested_context(response_text: str) -> str:
    sections: list[str] = []
    for raw_path in READ_RE.findall(response_text):
        target = _safe_project_path(raw_path)
        if not target.is_file():
            sections.append(f"[MISSING: {raw_path.strip()}]")
        else:
            relative = target.relative_to(PROJECT_ROOT).as_posix()
            sections.append(f"[SOURCE: {relative}]\n{_read_utf8(target)}")
    return "\n\n".join(sections)


def call_agent(client: Any, *, model: str, instructions: str, prompt: str) -> str:
    response = client.responses.create(
        model=model,
        instructions=instructions,
        input=prompt,
        store=False,
    )
    output_text = getattr(response, "output_text", None)
    if not isinstance(output_text, str) or not output_text.strip():
        raise AgentLoopError("Responses API returned no output_text")
    return output_text


PLANNER_INSTRUCTIONS = """You are the planning/review agent for a bounded React/Vite task.
Never emit file changes. Request source files with one `[READ: relative/path]` per line.
Return a concrete next plan. Return a line containing only `DONE` only when every acceptance
criterion is met and tests passed. Never request git, secrets, environment files, network calls,
deployment, or changes outside the project root."""

CODER_INSTRUCTIONS = """You are the implementation agent for a bounded React/Vite task.
Follow the task and planner. Emit each changed file in full as a fenced
`[FILE: relative/path]` block. Do not emit diffs. Never change agent_loop.py, environment files,
git state, APIs, scores, cohorts, data files, or unrelated files. Do not claim tests passed."""


def write_report(payload: dict[str, Any], report_file: Path = DEFAULT_REPORT_FILE) -> None:
    report_file.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def run_loop(
    task_file: Path,
    max_iterations: int,
    test_timeout: int,
    *,
    require_slack: bool = False,
    audit_sink: SlackAuditSink | None = None,
) -> int:
    client, client_status = build_client()
    if client is None:
        raise AgentLoopError(client_status)
    if not task_file.is_file():
        raise AgentLoopError(f"task file not found: {task_file}")
    task = _read_utf8(task_file)
    audit = audit_sink or SlackAuditSink.from_environment(required=require_slack)
    planner_model = os.environ.get("OPENAI_PLANNER_MODEL", "gpt-5.4")
    coder_model = os.environ.get("OPENAI_CODER_MODEL", planner_model)
    run_id = f"{time.strftime('%Y%m%d-%H%M%S')}-{uuid.uuid4().hex[:8]}"
    history: list[dict[str, Any]] = []
    test_result: TestResult | None = None
    planner_prompt = f"TASK\n{task}\n\nRequest only the source files needed for iteration 1."

    audit.post(
        "AGENT RUN",
        f"run={run_id}\nplanner={planner_model}\ncoder={coder_model}\n"
        f"task={task_file.name}\n\n{task[:2_000]}",
        root=not bool(audit.thread_ts),
    )

    try:
        for iteration in range(1, max_iterations + 1):
            planner_text = call_agent(
                client, model=planner_model, instructions=PLANNER_INSTRUCTIONS, prompt=planner_prompt
            )
            audit.post(f"PLANNER → CODER · iteration {iteration}", planner_text)
            context = collect_requested_context(planner_text)
            if DONE_RE.search(planner_text):
                if test_result and test_result.passed:
                    audit.post("PLANNER → DONE", planner_text)
                    write_report(
                        {
                            "status": "complete",
                            "runId": run_id,
                            "slack": audit.status(),
                            "iterations": history,
                            "finalPlanner": planner_text,
                        }
                    )
                    return 0
                planner_text += "\nTests have not passed; provide the next corrective plan."

            coder_text = call_agent(
                client,
                model=coder_model,
                instructions=CODER_INSTRUCTIONS,
                prompt=f"TASK\n{task}\n\nPLANNER\n{planner_text}\n\nSOURCE\n{context or '[none requested]'}",
            )
            proposed = extract_file_changes(coder_text)
            audit.post(
                f"CODER → FILES · iteration {iteration}",
                "\n".join(
                    f"{path} · {len(content.encode('utf-8'))} bytes" for path, content in proposed
                ),
            )
            applied = apply_file_changes(coder_text)
            test_result = run_tests(timeout_seconds=test_timeout)
            event = {
                "iteration": iteration,
                "planner": planner_text,
                "applied": [asdict(change) for change in applied],
                "tests": asdict(test_result),
            }
            audit.post(
                f"TEST → PLANNER · iteration {iteration}",
                json.dumps(event["tests"], ensure_ascii=False, indent=2),
            )
            history.append(event)
            write_report(
                {"status": "running", "runId": run_id, "slack": audit.status(), "iterations": history}
            )
            planner_prompt = (
                f"TASK\n{task}\n\nITERATION {iteration}\n"
                f"Changed: {json.dumps(event['applied'], ensure_ascii=False)}\n"
                f"Tests: {json.dumps(event['tests'], ensure_ascii=False)}\n"
                "Review and request exact source files for the next correction, or return DONE."
            )
    except Exception as exc:
        try:
            audit.post("AGENT RUN → STOP", f"{type(exc).__name__}: {exc}")
        except Exception:
            pass
        raise

    audit.post("AGENT RUN → STOP", f"iteration limit reached: {max_iterations}")
    write_report(
        {"status": "iteration_limit", "runId": run_id, "slack": audit.status(), "iterations": history}
    )
    return 2


def handle_slack_command(command: SlackCommand, *, max_iterations: int, test_timeout: int) -> int:
    audit = SlackAuditSink.from_environment(required=True)
    audit.thread_ts = command.thread_ts
    audit.post(
        "USER → AGENT",
        f"user={command.user_id}\nevent={command.event_id}\n\n{command.text}",
    )
    if command.text.casefold() in {"ping", "연결 확인", "연결 테스트"}:
        audit.post("AGENT LOOP", "Socket Mode command receive is ready; no model was invoked.")
        return 0
    temporary_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            encoding="utf-8",
            errors="strict",
            newline="\n",
            prefix="messi-slack-task-",
            suffix=".md",
            delete=False,
        ) as handle:
            handle.write(command.text)
            temporary_path = Path(handle.name)
        return run_loop(
            temporary_path,
            max_iterations,
            test_timeout,
            require_slack=True,
            audit_sink=audit,
        )
    finally:
        if temporary_path is not None:
            temporary_path.unlink(missing_ok=True)


def check_environment(run_test: bool = False) -> int:
    client, status = build_client()
    payload: dict[str, Any] = {
        "projectRoot": str(PROJECT_ROOT),
        "packageJson": (PROJECT_ROOT / "package.json").is_file(),
        "taskFile": DEFAULT_TASK_FILE.is_file(),
        "apiClientReady": client is not None,
        "apiClientStatus": status,
        "ci": normalized_environment().get("CI"),
        "pythonIoEncoding": normalized_environment().get("PYTHONIOENCODING"),
        "defaultTestCommand": DEFAULT_TEST_COMMAND,
        "slack": SlackAuditSink.from_environment().status(),
        "slackSocketConfigured": all(
            os.environ.get(name, "").strip()
            for name in ("SLACK_APP_TOKEN", "SLACK_BOT_TOKEN", "SLACK_CHANNEL_ID")
        ),
    }
    if run_test:
        payload["tests"] = asdict(run_tests())
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["packageJson"] and payload["taskFile"] else 2


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate without API calls")
    parser.add_argument("--check-tests", action="store_true", help="also run the test command")
    parser.add_argument("--check-slack", action="store_true", help="post one Slack connectivity probe")
    parser.add_argument(
        "--check-slack-socket",
        action="store_true",
        help="open Socket Mode, validate the hello envelope, then exit",
    )
    parser.add_argument(
        "--listen-slack",
        action="store_true",
        help="listen for approved-channel mentions and thread follow-ups",
    )
    parser.add_argument(
        "--require-slack",
        action="store_true",
        help="fail closed before model calls or file writes when Slack audit is unavailable",
    )
    parser.add_argument("--task", type=Path, default=DEFAULT_TASK_FILE)
    parser.add_argument("--max-iterations", type=int, default=8)
    parser.add_argument("--test-timeout", type=int, default=900)
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    if args.max_iterations < 1:
        raise AgentLoopError("--max-iterations must be positive")
    if args.check_slack:
        sink = SlackAuditSink.from_environment(required=True)
        sink.post("AGENT LOOP · CONNECTION TEST", "Slack audit transport is ready.", root=True)
        print(json.dumps(sink.status(), ensure_ascii=False, indent=2))
        return 0
    if args.check_slack_socket:
        bridge = SlackSocketBridge.from_environment()
        print(json.dumps(asyncio.run(bridge.check_connection()), ensure_ascii=False, indent=2))
        return 0
    if args.listen_slack:
        bridge = SlackSocketBridge.from_environment()
        print(
            json.dumps(
                {"status": "listening", "channelConfigured": True, "mentionRequiredForNewThread": True},
                ensure_ascii=False,
            )
        )
        asyncio.run(
            bridge.listen(
                lambda command: handle_slack_command(
                    command,
                    max_iterations=args.max_iterations,
                    test_timeout=args.test_timeout,
                )
            )
        )
        return 0
    if args.check or args.check_tests:
        return check_environment(run_test=args.check_tests)
    require_slack = args.require_slack or os.environ.get("SLACK_AUDIT_REQUIRED") == "true"
    return run_loop(
        args.task.resolve(),
        args.max_iterations,
        args.test_timeout,
        require_slack=require_slack,
    )


if __name__ == "__main__":
    configure_stdio()
    try:
        raise SystemExit(main())
    except AgentLoopError as exc:
        print(f"agent_loop: {exc}", file=sys.stderr)
        raise SystemExit(2)
