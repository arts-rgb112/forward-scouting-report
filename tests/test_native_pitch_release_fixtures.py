"""Mandatory self-contained production regression; missing shipped artifacts fail."""
import importlib.util
import hashlib
import json
import subprocess
from pathlib import Path


def test_snapshot_mapping_pin_matches_git_deployment_bytes():
    root = Path(__file__).resolve().parents[1]
    committed = subprocess.run(
        ["git", "-c", f"safe.directory={root.as_posix()}", "show", "HEAD:data/tactical_3zone_ratio.csv"],
        cwd=root, check=True, capture_output=True,
    ).stdout
    actual = (root / "data/tactical_3zone_ratio.csv").read_bytes()
    assert b"\r" not in committed
    assert actual == committed, "Checkout bytes must equal deployment bytes"
    index = json.loads((root / "data/pitch-native-v2/index.json").read_bytes())
    assert index["mappingCsvSha256"] == hashlib.sha256(committed).hexdigest()


def test_shipped_v2_production_pitch_matches_pinned_release_fixtures():
    path = Path(__file__).resolve().parents[1] / "docs/fixtures/native_pitch_release_v1/validate.py"
    spec = importlib.util.spec_from_file_location("native_pitch_release_fixture_validation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    metadata = module.verify()
    assert len(metadata["files"]) == 5
    assert metadata["query"] == {"season": "2025/2026", "mode": "league", "scope": "8", "competition": "all"}
