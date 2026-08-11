"""Source-level regression proof for the early legacy/Vite handoff guard.

This deliberately does not import app.py, which would require Streamlit and
its application runtime during collection.
"""

from pathlib import Path


def test_legacy_handoff_guard_keeps_page_values_exact() -> None:
    source = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    guard = source.split("def _requested_legacy_page() -> bool:", 1)[1].split("def render_frontend_handoff", 1)[0]
    assert "isinstance(page, str) and page in LEGACY_HANDOFF_PAGES" in guard
    assert ".strip().lower()" not in guard
