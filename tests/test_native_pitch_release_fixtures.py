"""Mandatory self-contained production regression; missing shipped artifacts fail."""
import importlib.util
from pathlib import Path


def test_shipped_v2_production_pitch_matches_pinned_release_fixtures():
    path = Path(__file__).resolve().parents[1] / "docs/fixtures/native_pitch_release_v1/validate.py"
    spec = importlib.util.spec_from_file_location("native_pitch_release_fixture_validation", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    metadata = module.verify()
    assert len(metadata["files"]) == 5
    assert metadata["query"] == {"season": "2025/2026", "mode": "league", "scope": "8", "competition": "all"}
