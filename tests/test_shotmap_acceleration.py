from __future__ import annotations

import json
from datetime import datetime, timezone
from email.message import Message
from pathlib import Path
import threading
from unittest.mock import MagicMock, patch
from urllib.error import HTTPError

import pytest

import fotmob_client
from fotmob_client import RequestStartLimiter
from scripts.build_shotmap_points import (
    ShotmapBackfillError,
    _write_snapshot_atomic,
    build,
)


class FakeClock:
    def __init__(self) -> None:
        self.now = 0.0
        self.sleeps: list[float] = []

    def clock(self) -> float:
        return self.now

    def sleep(self, seconds: float) -> None:
        self.sleeps.append(seconds)
        self.now += seconds


def row(key: str, competition: str = "Bundesliga") -> dict[str, str]:
    return {"heatmap_key": key, "competition_name": competition}


def payload(shotmap: object, competition: str = "Bundesliga") -> dict[str, object]:
    return {"season_records": [{
        "league_name": competition,
        "stats": {"shotmap": shotmap},
    }]}


def source_shot(x: float) -> dict[str, object]:
    return {
        "x": x, "y": 34, "eventType": "Goal",
        "goalCrossedY": 34, "goalCrossedZ": 1,
    }


def test_process_limiter_spaces_starts_and_extends_shared_cooldown() -> None:
    fake = FakeClock()
    limiter = RequestStartLimiter(
        0.65, clock=fake.clock, sleeper=fake.sleep,
    )

    limiter.wait()
    limiter.wait()
    limiter.defer(2.0)
    limiter.wait()

    assert fake.sleeps == pytest.approx([0.65, 2.0])
    assert fake.now == pytest.approx(2.65)


def test_429_retry_after_defers_every_request_worker() -> None:
    headers = Message()
    headers["Retry-After"] = "4"
    throttled = HTTPError(
        "https://example.test", 429, "slow down", headers, None,
    )
    response = MagicMock()
    response.__enter__.return_value.read.return_value = b'{"ok":true}'
    limiter = MagicMock()

    with (
        patch("fotmob_client.urlopen", side_effect=[throttled, response]),
        patch("fotmob_client._REQUEST_START_LIMITER", limiter),
        patch("fotmob_client.random.uniform", return_value=0.1),
    ):
        assert fotmob_client._get("https://example.test") == '{"ok":true}'

    assert limiter.wait.call_count == 2
    limiter.defer.assert_called_once_with(4.1)


def test_retry_after_http_date_is_honored_deterministically() -> None:
    headers = Message()
    headers["Retry-After"] = "Fri, 01 Jan 2038 00:00:10 GMT"
    error = HTTPError("https://example.test", 429, "slow", headers, None)

    class FixedDatetime:
        @classmethod
        def now(cls, tz: object = None) -> datetime:
            return datetime(2038, 1, 1, tzinfo=timezone.utc)

    with patch("fotmob_client.datetime", FixedDatetime):
        assert fotmob_client._retry_after_seconds(error) == 10.0


def test_final_429_still_extends_shared_cooldown() -> None:
    headers = Message()
    throttled = HTTPError(
        "https://example.test", 429, "slow down", headers, None,
    )
    limiter = MagicMock()

    with (
        patch("fotmob_client.urlopen", side_effect=[throttled] * 3),
        patch("fotmob_client._REQUEST_START_LIMITER", limiter),
        patch("fotmob_client.random.uniform", return_value=0.0),
        pytest.raises(fotmob_client.FotMobError, match="HTTP 429"),
    ):
        fotmob_client._get("https://example.test")

    assert limiter.wait.call_count == 3
    assert [call.args[0] for call in limiter.defer.call_args_list] == [1.5, 3.0, 4.5]


def test_parallel_results_are_merged_in_original_target_order(tmp_path: Path) -> None:
    output = tmp_path / "snapshot.json"
    output.write_text("{}", encoding="utf-8")
    release_first = threading.Event()
    targets = {
        ("p1", "2025/2026"): [row("key-1")],
        ("p2", "2025/2026"): [row("key-2")],
        ("p3", "2025/2026"): [row("key-3")],
    }

    def fetch(player_id: str, *, target_season: str) -> dict[str, object]:
        if player_id == "p1":
            assert release_first.wait(timeout=2)
        if player_id == "p3":
            release_first.set()
        return payload([source_shot(90 + int(player_id[-1]))])

    with (
        patch("scripts.build_shotmap_points._output_path", return_value=output),
        patch("scripts.build_shotmap_points._targets", return_value=targets),
        patch("scripts.build_shotmap_points.fetch_player_multi_season_data", side_effect=fetch),
        patch("scripts.build_shotmap_points.configure_request_start_interval", return_value=0.0),
    ):
        assert build("2025/2026", refresh_existing=True, workers=3) == (3, 3)

    stored = json.loads(output.read_text(encoding="utf-8"))
    assert list(stored) == ["key-1", "key-2", "key-3"]


def test_parallel_fetch_never_exceeds_three_active_workers(tmp_path: Path) -> None:
    output = tmp_path / "snapshot.json"
    output.write_text("{}", encoding="utf-8")
    targets = {
        (f"p{index}", "2025/2026"): [row(f"key-{index}")]
        for index in range(6)
    }
    lock = threading.Lock()
    first_wave_ready = threading.Event()
    active = 0
    peak = 0

    def fetch(player_id: str, *, target_season: str) -> dict[str, object]:
        nonlocal active, peak
        with lock:
            active += 1
            peak = max(peak, active)
            if active == 3:
                first_wave_ready.set()
        assert first_wave_ready.wait(timeout=2)
        with lock:
            active -= 1
        return payload([source_shot(90)])

    with (
        patch("scripts.build_shotmap_points._output_path", return_value=output),
        patch("scripts.build_shotmap_points._targets", return_value=targets),
        patch("scripts.build_shotmap_points.fetch_player_multi_season_data", side_effect=fetch),
        patch("scripts.build_shotmap_points.configure_request_start_interval", return_value=0.0),
    ):
        assert build("2025/2026", refresh_existing=True, workers=3) == (6, 6)

    assert peak == 3


def test_atomic_checkpoint_never_replaces_valid_file_on_failure(tmp_path: Path) -> None:
    output = tmp_path / "snapshot.json"
    original = {"existing": [{"outcome": "goal"}]}
    output.write_text(json.dumps(original), encoding="utf-8")

    with patch("scripts.build_shotmap_points.os.replace", side_effect=OSError("disk")):
        with pytest.raises(OSError, match="disk"):
            _write_snapshot_atomic(output, {"replacement": []})

    assert json.loads(output.read_text(encoding="utf-8")) == original
    assert not list(tmp_path.glob(".*.tmp"))


def test_unexpected_worker_failure_preserves_other_results_then_fails(
    tmp_path: Path,
) -> None:
    output = tmp_path / "snapshot.json"
    output.write_text(json.dumps({"baseline": []}), encoding="utf-8")
    targets = {
        ("bad", "2025/2026"): [row("bad-key")],
        ("good", "2025/2026"): [row("good-key")],
    }

    def fetch(player_id: str, *, target_season: str) -> dict[str, object]:
        if player_id == "bad":
            raise ValueError("unexpected source shape")
        return payload([source_shot(90)])

    with (
        patch("scripts.build_shotmap_points._output_path", return_value=output),
        patch("scripts.build_shotmap_points._targets", return_value=targets),
        patch("scripts.build_shotmap_points.fetch_player_multi_season_data", side_effect=fetch),
        patch("scripts.build_shotmap_points.configure_request_start_interval", return_value=0.0),
    ):
        with pytest.raises(ShotmapBackfillError, match="target 1"):
            build("2025/2026", refresh_existing=True, workers=3)

    stored = json.loads(output.read_text(encoding="utf-8"))
    assert set(stored) == {"baseline", "good-key"}
    assert "bad-key" not in stored


def test_parallel_refresh_preserves_malformed_and_accepts_explicit_zero(
    tmp_path: Path,
) -> None:
    output = tmp_path / "snapshot.json"
    populated = [{
        "x": 90, "y": 50, "outcome": "goal", "xg": 0.4, "xgot": 0.7,
    }]
    output.write_text(json.dumps({
        "baseline": populated,
        "malformed": populated,
        "verified-zero": populated,
    }), encoding="utf-8")
    targets = {
        ("bad", "2025/2026"): [row("malformed")],
        ("zero", "2025/2026"): [row("verified-zero")],
    }

    def fetch(player_id: str, *, target_season: str) -> dict[str, object]:
        return payload(None if player_id == "bad" else [])

    with (
        patch("scripts.build_shotmap_points._output_path", return_value=output),
        patch("scripts.build_shotmap_points._targets", return_value=targets),
        patch("scripts.build_shotmap_points.fetch_player_multi_season_data", side_effect=fetch),
        patch("scripts.build_shotmap_points.configure_request_start_interval", return_value=0.0),
    ):
        with pytest.raises(ShotmapBackfillError, match="source anomalies=1"):
            build("2025/2026", refresh_existing=True, workers=3)

    stored = json.loads(output.read_text(encoding="utf-8"))
    assert set(stored) == {"baseline", "malformed", "verified-zero"}
    assert stored["malformed"] == populated
    assert stored["verified-zero"] == []


@pytest.mark.parametrize("workers", [0, 2, 4, 5])
def test_worker_count_is_bounded(workers: int, tmp_path: Path) -> None:
    with (
        patch("scripts.build_shotmap_points._output_path", return_value=tmp_path / "x.json"),
        pytest.raises(ValueError, match="workers must be 1 or 3"),
    ):
        build(workers=workers)


def test_backfill_rejects_request_interval_below_safety_floor() -> None:
    with pytest.raises(ValueError, match=">= 0.65"):
        build(request_interval_seconds=0.649)


def test_workflow_serializes_backfills_and_defaults_to_three_workers() -> None:
    workflow = (
        Path(__file__).resolve().parents[1]
        / ".github" / "workflows" / "refresh-shotmap-points.yml"
    ).read_text(encoding="utf-8")

    assert "group: shotmap-refresh" in workflow
    assert "cancel-in-progress: false" in workflow
    assert 'default: "3"' in workflow
    assert '--workers "${{ inputs.workers }}"' in workflow
    assert "pip install -r requirements.txt -r requirements-api.txt" in workflow
    assert "continue-on-error: true" not in workflow
    assert "if: always()" not in workflow
    assert workflow.count("if: success()") == 2
