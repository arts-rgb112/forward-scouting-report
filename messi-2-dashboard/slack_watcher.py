#!/usr/bin/env python3
"""Persistent Slack watcher that wakes Claude without answering Codex."""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import queue
import re
import subprocess
import sys
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Callable, Iterable

from agent_loop import (
    DEFAULT_CODEX_TIMEOUT_SECONDS,
    AgentLoopError,
    SlackSocketBridge,
    _csv_ids,
    handle_slack_command,
    redact_audit_text,
)


PROJECT_ROOT = Path(__file__).resolve().parent
DEFAULT_STATE_FILE = PROJECT_ROOT / ".agent-loop-state" / "slack_watch_alert_state.json"
DEFAULT_STOP_FILE = PROJECT_ROOT / ".agent-loop-state" / "slack_watcher.stop"
DEFAULT_DECISIONS_FILE = PROJECT_ROOT.parent / "messi-specs" / "BRAINSHOWER_DECISIONS.md"
REPORT_TAGS = frozenset({"DONE", "FAIL", "BLOCKED", "ASK", "LIMIT", "NOTE"})
URGENT_TAGS = frozenset({"FAIL", "BLOCKED", "ASK", "LIMIT"})
INSTRUCTION_TAGS = frozenset({"APPLY", "PLAN", "REVISE"})
MENTION_RE = re.compile(r"<@([A-Z0-9]+)(?:\|[^>]+)?>", re.I)
TAG_RE = re.compile(
    r"(?is)^\s*\*?\s*(?:<@[A-Z0-9]+(?:\|[^>]+)?>\s*)?"
    r"(?:`\s*)?\[([A-Z]+)\](?:\s*`)?(?:\s*\*?)\s*(.*)$"
)
DONE_FIELD_RE = {
    name: re.compile(rf"(?im)^\s*{name}\s*:\s*\S.*$")
    for name in ("commit", "branch", "push", "tests", "files")
}
CONCLUSION_RE = re.compile(r"합의|결론|확정|closed|resolved|마감", re.I)
DISAGREEMENT_RE = re.compile(r"의견.{0,8}(갈|충돌)|합의.{0,8}(안|못)|쟁점|보류", re.I)
WORKTREE_RE = re.compile(r"worktree|작업\s*폴더|워크트리", re.I)
APPROVAL_RE = re.compile(r"승인|판단|결정|approve", re.I)


def _env_path(name: str, default: Path) -> Path:
    raw = os.environ.get(name, "").strip()
    return Path(raw).expanduser().resolve() if raw else default


@dataclass(frozen=True)
class WatchConfig:
    channel_ids: frozenset[str]
    brainshower_channel_ids: frozenset[str]
    claude_user_id: str
    codex_recipient_id: str
    claude_user_ids: frozenset[str]
    claude_bot_ids: frozenset[str]
    claude_app_ids: frozenset[str]
    codex_user_ids: frozenset[str]
    codex_bot_ids: frozenset[str]
    codex_app_ids: frozenset[str]
    receipt_timeout_seconds: int
    poll_interval_seconds: int
    state_file: Path
    stop_file: Path
    decisions_file: Path

    @classmethod
    def from_environment(cls) -> "WatchConfig":
        channels = _csv_ids(os.environ.get("SLACK_WATCH_CHANNEL_IDS", ""))
        if not channels:
            raise AgentLoopError("SLACK_WATCH_CHANNEL_IDS must contain at least one channel")
        brainshower = _csv_ids(os.environ.get("SLACK_BRAINSHOWER_CHANNEL_IDS", ""))
        if not brainshower.issubset(channels):
            raise AgentLoopError("SLACK_BRAINSHOWER_CHANNEL_IDS must be included in SLACK_WATCH_CHANNEL_IDS")
        try:
            receipt_timeout = int(os.environ.get("SLACK_WATCH_RECEIPT_TIMEOUT_SECONDS", "90"))
            poll_interval = int(os.environ.get("SLACK_WATCH_POLL_INTERVAL_SECONDS", "45"))
        except ValueError as exc:
            raise AgentLoopError("Slack watcher timeout values must be integers") from exc
        if receipt_timeout < 1 or poll_interval < 1:
            raise AgentLoopError("Slack watcher timeout values must be positive")
        claude_user_id = os.environ.get("SLACK_CLAUDE_USER_ID", "").strip()
        codex_recipient_id = os.environ.get("SLACK_CODEX_RECIPIENT_ID", "").strip()
        if not claude_user_id or not codex_recipient_id:
            raise AgentLoopError("SLACK_CLAUDE_USER_ID and SLACK_CODEX_RECIPIENT_ID are required")
        return cls(
            channel_ids=channels,
            brainshower_channel_ids=brainshower,
            claude_user_id=claude_user_id,
            codex_recipient_id=codex_recipient_id,
            claude_user_ids=_csv_ids(os.environ.get("SLACK_CLAUDE_USER_IDS", "")),
            claude_bot_ids=_csv_ids(os.environ.get("SLACK_CLAUDE_BOT_IDS", "")),
            claude_app_ids=_csv_ids(os.environ.get("SLACK_CLAUDE_APP_IDS", "")),
            codex_user_ids=_csv_ids(os.environ.get("SLACK_CODEX_USER_IDS", "")),
            codex_bot_ids=_csv_ids(os.environ.get("SLACK_CODEX_BOT_IDS", "")),
            codex_app_ids=_csv_ids(os.environ.get("SLACK_CODEX_APP_IDS", "")),
            receipt_timeout_seconds=receipt_timeout,
            poll_interval_seconds=poll_interval,
            state_file=_env_path("SLACK_WATCH_STATE_FILE", DEFAULT_STATE_FILE),
            stop_file=_env_path("SLACK_WATCH_STOP_FILE", DEFAULT_STOP_FILE),
            decisions_file=_env_path("SLACK_BRAINSHOWER_DECISIONS_FILE", DEFAULT_DECISIONS_FILE),
        )


@dataclass(frozen=True)
class WatchMessage:
    event_id: str
    channel_id: str
    channel_type: str
    event_ts: str
    thread_ts: str
    text: str
    user_id: str
    bot_id: str = ""
    app_id: str = ""
    reactions: tuple[str, ...] = ()

    @property
    def key(self) -> str:
        reaction_key = ",".join(sorted(self.reactions))
        return f"{self.channel_id}:{self.event_ts}:{reaction_key}"


class WatchState:
    """Atomic, bounded successor of slack_watch_alert_state.json dedup state."""

    def __init__(self, path: Path) -> None:
        self.path = path
        self.data = self._load()

    def _load(self) -> dict[str, Any]:
        if not self.path.is_file():
            return {
                "schemaVersion": 1,
                "commitSha": _git_sha(),
                "seenMessageKeys": [],
                "alertedKeys": [],
                "notifiedThreadTs": {},
                "pendingReceipts": {},
                "pendingAlerts": {},
            }
        try:
            data = json.loads(self.path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise AgentLoopError(f"Slack watcher state is unreadable: {self.path}") from exc
        if "schemaVersion" not in data:
            legacy = data
            data = {
                "schemaVersion": 1,
                "commitSha": str(legacy.get("commitSha") or legacy.get("commit_sha") or _git_sha()),
                "seenMessageKeys": list(legacy.get("seenMessageKeys", [])),
                "alertedKeys": list(legacy.get("alertedKeys", [])),
                "notifiedThreadTs": dict(legacy.get("notifiedThreadTs", {})),
                "pendingReceipts": dict(legacy.get("pendingReceipts", {})),
                "pendingAlerts": {},
            }
        if data.get("schemaVersion") != 1:
            raise AgentLoopError("Slack watcher state schema is unsupported")
        data["commitSha"] = _git_sha()
        data.setdefault("pendingAlerts", {})
        return data

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        target = self.path
        temporary = target.with_name(f".{target.name}.{os.getpid()}.tmp")
        temporary.write_text(json.dumps(self.data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        os.replace(temporary, target)

    def remember(self, collection: str, key: str, limit: int = 4_000) -> bool:
        values = self.data.setdefault(collection, [])
        if key in values:
            return False
        values.append(key)
        if len(values) > limit:
            del values[:-limit]
        return True


class SlackWakeClient:
    def __init__(self, bridge: SlackSocketBridge, claude_user_id: str) -> None:
        self.bridge = bridge
        self.claude_user_id = claude_user_id
        self._dm_channel_id = ""

    def _claude_dm(self) -> str:
        if not self.claude_user_id:
            raise AgentLoopError("SLACK_CLAUDE_USER_ID is required to send wake-up DMs")
        if not self._dm_channel_id:
            body = self.bridge._json_request(
                "https://slack.com/api/conversations.open",
                self.bridge.bot_token,
                {"users": self.claude_user_id},
            )
            channel = body.get("channel")
            self._dm_channel_id = channel.get("id", "") if isinstance(channel, dict) else ""
            if not self._dm_channel_id:
                raise AgentLoopError("Slack conversations.open returned no Claude DM channel")
        return self._dm_channel_id

    def wake(self, summary: str) -> str:
        body = self.bridge._json_request(
            "https://slack.com/api/chat.postMessage",
            self.bridge.bot_token,
            {"channel": self._claude_dm(), "text": summary, "unfurl_links": False},
        )
        return str(body.get("ts", ""))

    def eyes(self, message: WatchMessage) -> None:
        self.bridge._json_request(
            "https://slack.com/api/reactions.add",
            self.bridge.bot_token,
            {"channel": message.channel_id, "timestamp": message.event_ts, "name": "eyes"},
        )


def _git_sha() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        cwd=PROJECT_ROOT,
        text=True,
        encoding="utf-8",
        errors="replace",
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        check=False,
    )
    return completed.stdout.strip() if completed.returncode == 0 else "unavailable"


def _message_from_envelope(envelope: dict[str, Any], channels: frozenset[str]) -> WatchMessage | None:
    payload = envelope.get("payload")
    if not isinstance(payload, dict) or payload.get("type") != "event_callback":
        return None
    event = payload.get("event")
    if not isinstance(event, dict):
        return None
    if event.get("type") == "reaction_added":
        item = event.get("item")
        channel = item.get("channel") if isinstance(item, dict) else None
        item_ts = item.get("ts") if isinstance(item, dict) else None
        reaction = event.get("reaction")
        if channel not in channels or not isinstance(item_ts, str) or reaction != "white_check_mark":
            return None
        return WatchMessage(
            event_id=str(payload.get("event_id") or f"reaction:{channel}:{item_ts}"),
            channel_id=str(channel),
            channel_type="channel",
            event_ts=item_ts,
            thread_ts=item_ts,
            text="✅ reaction added; thread closed",
            user_id=str(event.get("user") or ""),
            reactions=("white_check_mark",),
        )
    if event.get("type") not in {"message", "app_mention"}:
        return None
    if event.get("subtype") not in {None, "bot_message"}:
        return None
    channel = event.get("channel")
    channel_type = str(event.get("channel_type", ""))
    if not isinstance(channel, str) or (channel not in channels and channel_type != "im"):
        return None
    event_ts = event.get("ts")
    text = event.get("text")
    if not isinstance(event_ts, str) or not isinstance(text, str) or not text.strip():
        return None
    reactions = tuple(
        str(item.get("name"))
        for item in event.get("reactions", [])
        if isinstance(item, dict) and item.get("name")
    )
    return WatchMessage(
        event_id=str(payload.get("event_id") or f"poll:{channel}:{event_ts}"),
        channel_id=channel,
        channel_type=channel_type,
        event_ts=event_ts,
        thread_ts=str(event.get("thread_ts") or event_ts),
        text=text.strip(),
        user_id=str(event.get("user") or ""),
        bot_id=str(event.get("bot_id") or ""),
        app_id=str(event.get("app_id") or ""),
        reactions=reactions,
    )


def parse_tag(text: str, allowed: frozenset[str]) -> tuple[str, str] | None:
    match = TAG_RE.match(text)
    if not match or match.group(1).upper() not in allowed:
        return None
    return match.group(1).upper(), match.group(2).strip()


def _core(text: str) -> str:
    cleaned = redact_audit_text(MENTION_RE.sub("", text))
    cleaned = re.sub(r"[`*_>#]+", " ", cleaned)
    lines = [re.sub(r"\s+", " ", line).strip() for line in cleaned.splitlines() if line.strip()]
    return " / ".join(lines[:2])[:320] or "(내용 없음)"


class SlackWatcher:
    def __init__(
        self,
        config: WatchConfig,
        bridge: SlackSocketBridge,
        *,
        wake_client: SlackWakeClient | None = None,
        clock: Callable[[], float] = time.time,
        command_handler: Callable[[Any], int] | None = None,
    ) -> None:
        self.config = config
        self.bridge = bridge
        self.state = WatchState(config.state_file)
        self.wake_client = wake_client or SlackWakeClient(bridge, config.claude_user_id)
        self.clock = clock
        self.command_handler = command_handler or (lambda command: 0)
        self.command_queue: queue.Queue[Any] = queue.Queue()
        self._command_worker_started = False
        self._state_lock = threading.RLock()

    def stopped(self) -> bool:
        return self.config.stop_file.is_file()

    def _actor(self, message: WatchMessage) -> str:
        if (
            message.user_id in self.config.codex_user_ids
            or message.bot_id in self.config.codex_bot_ids
            or message.app_id in self.config.codex_app_ids
            or message.user_id == self.bridge.bot_user_id
        ):
            return "codex"
        if (
            message.user_id in self.config.claude_user_ids
            or message.bot_id in self.config.claude_bot_ids
            or message.app_id in self.config.claude_app_ids
            or message.user_id == self.config.claude_user_id
        ):
            return "claude"
        return "other"

    def _alert(self, key: str, message: WatchMessage, status: str, detail: str = "") -> None:
        if key in self.state.data.setdefault("alertedKeys", []):
            return
        location = "DM" if message.channel_type == "im" else message.channel_id
        summary = (
            f"[SLACK WATCH] channel={location} thread_ts={message.thread_ts}\n"
            f"author={self._actor(message)}:{message.user_id or message.bot_id} status={status}\n"
            f"core={_core(message.text)}"
        )
        if detail:
            summary += f"\ndetail={detail[:320]}"
        try:
            alert_ts = self.wake_client.wake(summary)
        except Exception as exc:
            self.state.data.setdefault("pendingAlerts", {})[key] = summary
            print(f"slack_watcher: wake queued after {type(exc).__name__}", file=sys.stderr)
            return
        self.state.remember("alertedKeys", key)
        self.state.data.setdefault("pendingAlerts", {}).pop(key, None)
        self.state.data.setdefault("notifiedThreadTs", {})[key] = alert_ts
        print(f"slack_watcher: detected status={status} channel={location} process_alive=true", flush=True)

    def _receipt(self, message: WatchMessage, actor: str) -> None:
        pending = self.state.data.setdefault("pendingReceipts", {})
        item = pending.get(message.thread_ts)
        if item and (actor == "codex" or "SLACK → AGENT" in message.text):
            pending.pop(message.thread_ts, None)
            print(f"slack_watcher: receipt thread_ts={message.thread_ts}", flush=True)

    def _mark_command_received(self, thread_ts: str) -> None:
        with self._state_lock:
            pending = self.state.data.setdefault("pendingReceipts", {})
            if pending.pop(thread_ts, None) is not None:
                self.state.save()
                print(f"slack_watcher: receipt thread_ts={thread_ts}", flush=True)

    def _command_worker(self) -> None:
        while True:
            selected_handler, command = self.command_queue.get()
            try:
                selected_handler(command)
                self._mark_command_received(command.thread_ts)
            except Exception as exc:
                print(
                    f"slack_watcher: command failed: {type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
            finally:
                self.command_queue.task_done()

    def _enqueue_command(self, command: Any) -> int:
        self.command_queue.put((self.command_handler, command))
        return 0

    def _start_command_worker(self) -> None:
        if self._command_worker_started:
            return
        threading.Thread(target=self._command_worker, name="slack-command-worker", daemon=True).start()
        self._command_worker_started = True

    def _watch_instruction(self, message: WatchMessage) -> None:
        parsed = parse_tag(message.text, INSTRUCTION_TAGS)
        if parsed is None:
            loose = re.search(r"(?i)\[(APPLY|PLAN|REVISE)\]", message.text)
            if loose is None:
                return
            tag = loose.group(1).upper()
            cause = "태그 형식 오류"
        else:
            tag, _ = parsed
            cause = ""
        mentioned_ids = set(MENTION_RE.findall(message.text))
        if self.config.codex_recipient_id and self.config.codex_recipient_id not in mentioned_ids:
            cause = "멘션 누락"
        elif not cause:
            cause = "루프 미기동 또는 Socket 미수신"
        self.state.data.setdefault("pendingReceipts", {})[message.thread_ts] = {
            "channelId": message.channel_id,
            "channelType": message.channel_type,
            "eventTs": message.event_ts,
            "threadTs": message.thread_ts,
            "text": message.text[:1_000],
            "userId": message.user_id,
            "deadline": self.clock() + self.config.receipt_timeout_seconds,
            "cause": cause,
            "tag": tag,
        }

    def _brainshower(self, message: WatchMessage) -> None:
        if message.channel_id not in self.config.brainshower_channel_ids:
            return
        closed = "white_check_mark" in message.reactions or bool(CONCLUSION_RE.search(message.text))
        recorded = False
        if closed and self.config.decisions_file.is_file():
            recorded = message.thread_ts in self.config.decisions_file.read_text(encoding="utf-8")
        if closed:
            status = "brainshower 합의 종료"
            detail = "결정문서 편입됨" if recorded else "BRAINSHOWER_DECISIONS.md 미편입"
        elif DISAGREEMENT_RE.search(message.text):
            status, detail = "brainshower 의견 대립 정체", "Claude 판단 필요"
        else:
            status, detail = "brainshower 새 메시지", "읽기 전용 알림"
        self._alert(f"brain:{message.key}", message, status, detail)

    def process_envelope(self, envelope: dict[str, Any]) -> None:
        with self._state_lock:
            self._process_envelope_locked(envelope)

    def _process_envelope_locked(self, envelope: dict[str, Any]) -> None:
        message = _message_from_envelope(envelope, self.config.channel_ids)
        if message is None or not self.state.remember("seenMessageKeys", message.key):
            return
        actor = self._actor(message)
        self._receipt(message, actor)
        if actor == "claude":
            self._watch_instruction(message)
        if actor == "codex":
            parsed = parse_tag(message.text, REPORT_TAGS)
            tag, body = parsed if parsed is not None else ("NOTE", message.text)
            if tag in URGENT_TAGS:
                detector = {
                    "LIMIT": "C 의견/턴 한도",
                    "ASK": "D 승인·판단 대기" if APPROVAL_RE.search(body) else "질문·판단 요청",
                    "BLOCKED": "B 워크트리 정체" if WORKTREE_RE.search(body) else "작업 차단",
                    "FAIL": "실패",
                }[tag]
                self._alert(f"report:{message.key}", message, f"[{tag}] {detector}")
            elif tag == "DONE":
                missing = [name for name, pattern in DONE_FIELD_RE.items() if not pattern.search(body)]
                status = "[DONE] 형식 미달" if missing else "[DONE] 검수 대기"
                detail = f"누락: {', '.join(missing)}" if missing else "필수 5항목 확인"
                self._alert(f"report:{message.key}", message, status, detail)
            try:
                self.wake_client.eyes(message)
            except Exception as exc:
                print(f"slack_watcher: eyes failed: {type(exc).__name__}", file=sys.stderr)
        self._brainshower(message)
        self.state.save()

    def check_silent_failures(self) -> None:
        with self._state_lock:
            self._check_silent_failures_locked()
            self._retry_pending_alerts_locked()

    def _check_silent_failures_locked(self) -> None:
        now = self.clock()
        pending = self.state.data.setdefault("pendingReceipts", {})
        for thread_ts, item in list(pending.items()):
            if now < float(item.get("deadline", now + 1)):
                continue
            message = WatchMessage(
                event_id=f"silent:{thread_ts}",
                channel_id=str(item.get("channelId", "")),
                channel_type=str(item.get("channelType", "")),
                event_ts=str(item.get("eventTs", thread_ts)),
                thread_ts=thread_ts,
                text=str(item.get("text", "")),
                user_id=str(item.get("userId", "")),
            )
            self._alert(
                f"silent:{message.channel_id}:{thread_ts}",
                message,
                "A 미접수 무음 실패",
                str(item.get("cause", "루프 미기동 또는 Socket 미수신")),
            )
            pending.pop(thread_ts, None)
        self.state.save()

    def _retry_pending_alerts_locked(self) -> None:
        for key, summary in list(self.state.data.setdefault("pendingAlerts", {}).items()):
            try:
                alert_ts = self.wake_client.wake(str(summary))
            except Exception as exc:
                print(f"slack_watcher: wake retry failed: {type(exc).__name__}", file=sys.stderr)
                continue
            self.state.remember("alertedKeys", key)
            self.state.data["pendingAlerts"].pop(key, None)
            self.state.data.setdefault("notifiedThreadTs", {})[key] = alert_ts
            print("slack_watcher: queued wake delivered process_alive=true", flush=True)
        self.state.save()

    def poll_fallback(self) -> None:
        """Backup-only history scan used by SlackSocketBridge while reconnecting."""
        channels = set(self.config.channel_ids)
        ims = self.bridge._json_request(
            "https://slack.com/api/conversations.list",
            self.bridge.bot_token,
            {"types": "im", "limit": 200},
        ).get("channels", [])
        for item in ims if isinstance(ims, list) else []:
            if isinstance(item, dict) and isinstance(item.get("id"), str):
                channels.add(str(item["id"]))
        for channel_id in sorted(channels):
            history = self.bridge._json_request(
                "https://slack.com/api/conversations.history",
                self.bridge.bot_token,
                {"channel": channel_id, "limit": 20},
            ).get("messages", [])
            for raw in reversed(history if isinstance(history, list) else []):
                if not isinstance(raw, dict):
                    continue
                event = dict(raw)
                event.update({"type": "message", "channel": channel_id})
                if channel_id not in self.config.channel_ids:
                    event["channel_type"] = "im"
                polled_envelope = {
                    "payload": {
                        "type": "event_callback",
                        "event_id": f"poll:{channel_id}:{event.get('ts')}",
                        "event": event,
                    }
                }
                self.process_envelope(polled_envelope)
                self._dispatch_polled_command(polled_envelope)
                if int(raw.get("reply_count", 0) or 0) > 0 and isinstance(raw.get("ts"), str):
                    replies = self.bridge._json_request(
                        "https://slack.com/api/conversations.replies",
                        self.bridge.bot_token,
                        {"channel": channel_id, "ts": raw["ts"], "limit": 100},
                    ).get("messages", [])
                    for reply in replies[1:] if isinstance(replies, list) else []:
                        if not isinstance(reply, dict):
                            continue
                        reply_event = dict(reply)
                        reply_event.update({"type": "message", "channel": channel_id, "thread_ts": raw["ts"]})
                        if channel_id not in self.config.channel_ids:
                            reply_event["channel_type"] = "im"
                        reply_envelope = {
                            "payload": {
                                "type": "event_callback",
                                "event_id": f"poll:{channel_id}:{reply_event.get('ts')}",
                                "event": reply_event,
                            }
                        }
                        self.process_envelope(reply_envelope)
                        self._dispatch_polled_command(reply_envelope)
        self.check_silent_failures()
        print("slack_watcher: polling fallback cycle complete process_alive=true", flush=True)

    def _dispatch_polled_command(self, envelope: dict[str, Any]) -> None:
        payload = envelope.get("payload")
        event = payload.get("event") if isinstance(payload, dict) else None
        if not isinstance(event, dict) or event.get("channel") != self.bridge.channel_id:
            return
        if not event.get("thread_ts"):
            mentions = set(MENTION_RE.findall(str(event.get("text", ""))))
            if self.config.codex_recipient_id not in mentions:
                return
            event["type"] = "app_mention"
        command = self.bridge.command_from_envelope(envelope)
        if command is not None:
            self._enqueue_command(command)

    async def run_forever(self) -> None:
        self.bridge.bot_user_id = await asyncio.to_thread(self.bridge._resolve_bot_user_id)
        self._start_command_worker()
        while not self.stopped():
            try:
                listener = asyncio.create_task(
                    self.bridge.listen(
                        self._enqueue_command,
                        envelope_handler=self.process_envelope,
                        fallback_handler=self.poll_fallback,
                        stop_requested=self.stopped,
                    )
                )
                maintenance = asyncio.create_task(self._maintenance())
                done, pending = await asyncio.wait(
                    {listener, maintenance}, return_when=asyncio.FIRST_COMPLETED
                )
                for task in pending:
                    task.cancel()
                for task in done:
                    await task
            except Exception as exc:
                print(f"slack_watcher: service cycle failed: {type(exc).__name__}: {exc}", file=sys.stderr)
                try:
                    await asyncio.to_thread(self.poll_fallback)
                except Exception as poll_exc:
                    print(f"slack_watcher: fallback failed: {type(poll_exc).__name__}: {poll_exc}", file=sys.stderr)
                await asyncio.sleep(self.config.poll_interval_seconds)

    async def _maintenance(self) -> None:
        interval = max(1, min(10, self.config.receipt_timeout_seconds // 3))
        while not self.stopped():
            await asyncio.sleep(interval)
            await asyncio.to_thread(self.check_silent_failures)


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true", help="validate configuration without Slack calls")
    parser.add_argument("--poll-once", action="store_true", help="run the backup polling path once")
    parser.add_argument("--test-timeout", type=int, default=900)
    parser.add_argument("--agent-timeout", type=int, default=DEFAULT_CODEX_TIMEOUT_SECONDS)
    return parser.parse_args(argv)


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    config = WatchConfig.from_environment()
    bridge = SlackSocketBridge.from_environment()
    watcher = SlackWatcher(
        config,
        bridge,
        command_handler=lambda command: handle_slack_command(
            command,
            max_iterations=1,
            test_timeout=args.test_timeout,
            agent_timeout=args.agent_timeout,
        ),
    )
    if args.check:
        print(
            json.dumps(
                {
                    "status": "ready",
                    "watchChannelCount": len(config.channel_ids),
                    "brainshowerChannelCount": len(config.brainshower_channel_ids),
                    "dmWatch": True,
                    "socketPrimary": True,
                    "pollingFallbackOnly": True,
                    "stateFile": str(config.state_file),
                },
                ensure_ascii=False,
            )
        )
        return 0
    if args.poll_once:
        watcher.poll_fallback()
        return 0
    asyncio.run(watcher.run_forever())
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except AgentLoopError as exc:
        print(f"slack_watcher: {exc}", file=sys.stderr)
        raise SystemExit(2)
