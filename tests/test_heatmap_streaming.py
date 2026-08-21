from __future__ import annotations

import tactical_ratio


def test_detail_heatmap_lookup_reads_only_the_requested_key(tmp_path, monkeypatch) -> None:
    snapshot = tmp_path / "heatmap.json"
    snapshot.write_text('{"other":[[1,2]],"194165:35:77333":[[50,50],[80,30]]}', encoding="utf-8")
    monkeypatch.setattr(tactical_ratio, "HEATMAP_POINTS_PATH", snapshot)
    tactical_ratio._load_heatmap_points_for_key.cache_clear()

    def fail_full_snapshot() -> dict[str, list[list[float]]]:
        raise AssertionError("detail lookup must not materialise the complete heatmap store")

    monkeypatch.setattr(tactical_ratio, "load_heatmap_points", fail_full_snapshot)
    assert tactical_ratio.get_heatmap_points(194165, "194165:35:77333") == [[50, 50], [80, 30]]
