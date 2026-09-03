#!/usr/bin/env python3
"""Bounded local planner/coder loop for frontend implementation work."""

from __future__ import annotations

import argparse
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
from dataclasses import asdict, dataclass
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Iterable, Sequence


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_TASK_FILE = PROJECT_ROOT / "TASK_ORDER.md"
DEFAULT_REPORT_FILE = PROJECT_ROOT / "AGENT_LOOP_REPORT.md"
DEFAULT_TEST_COMMAND = "npm test -- --watchAll=false"
MAX_TEST_TAIL = 3_000
MAX_CONTEXT_FILE_BYTES = 160_000

FILE_BLOCK_RE = re.compile(
    r"(?ms)^\[FILE:\s*([^\]\r\n]+?)\s*\]\s*\r?\n"
    r"```(?:[^\r\n`]*)\r?\n(.*?)\r?\n```[ \t]*$"
)
READ_RE = re.compile(r"(?m)^\[READ:\s*([^\]\r\n]+?)\s*\]\s*$")
DONE_RE = re.compile(r"(?m)^\s*DONE\s*$")
VITEST_WATCHALL_RE = re.compile(r"unknown option.*watchall", re.I)


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


def run_loop(task_file: Path, max_iterations: int, test_timeout: int) -> int:
    client, client_status = build_client()
    if client is None:
        raise AgentLoopError(client_status)
    if not task_file.is_file():
        raise AgentLoopError(f"task file not found: {task_file}")
    task = _read_utf8(task_file)
    planner_model = os.environ.get("OPENAI_PLANNER_MODEL", "gpt-5.4")
    coder_model = os.environ.get("OPENAI_CODER_MODEL", planner_model)
    history: list[dict[str, Any]] = []
    test_result: TestResult | None = None
    planner_prompt = f"TASK\n{task}\n\nRequest only the source files needed for iteration 1."

    for iteration in range(1, max_iterations + 1):
        planner_text = call_agent(
            client, model=planner_model, instructions=PLANNER_INSTRUCTIONS, prompt=planner_prompt
        )
        context = collect_requested_context(planner_text)
        if DONE_RE.search(planner_text):
            if test_result and test_result.passed:
                write_report({"status": "complete", "iterations": history, "finalPlanner": planner_text})
                return 0
            planner_text += "\nTests have not passed; provide the next corrective plan."

        coder_text = call_agent(
            client,
            model=coder_model,
            instructions=CODER_INSTRUCTIONS,
            prompt=f"TASK\n{task}\n\nPLANNER\n{planner_text}\n\nSOURCE\n{context or '[none requested]'}",
        )
        applied = apply_file_changes(coder_text)
        test_result = run_tests(timeout_seconds=test_timeout)
        event = {
            "iteration": iteration,
            "planner": planner_text,
            "applied": [asdict(change) for change in applied],
            "tests": asdict(test_result),
        }
        history.append(event)
        write_report({"status": "running", "iterations": history})
        planner_prompt = (
            f"TASK\n{task}\n\nITERATION {iteration}\n"
            f"Changed: {json.dumps(event['applied'], ensure_ascii=False)}\n"
            f"Tests: {json.dumps(event['tests'], ensure_ascii=False)}\n"
            "Review and request exact source files for the next correction, or return DONE."
        )

    write_report({"status": "iteration_limit", "iterations": history})
    return 2


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
    }
    if run_test:
        payload["tests"] = asdict(run_tests())
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0 if payload["packageJson"] and payload["taskFile"] else 2


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate without API calls")
    parser.add_argument("--check-tests", action="store_true", help="also run the test command")
    parser.add_argument("--task", type=Path, default=DEFAULT_TASK_FILE)
    parser.add_argument("--max-iterations", type=int, default=8)
    parser.add_argument("--test-timeout", type=int, default=900)
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    if args.max_iterations < 1:
        raise AgentLoopError("--max-iterations must be positive")
    if args.check or args.check_tests:
        return check_environment(run_test=args.check_tests)
    return run_loop(args.task.resolve(), args.max_iterations, args.test_timeout)


if __name__ == "__main__":
    configure_stdio()
    try:
        raise SystemExit(main())
    except AgentLoopError as exc:
        print(f"agent_loop: {exc}", file=sys.stderr)
        raise SystemExit(2)
