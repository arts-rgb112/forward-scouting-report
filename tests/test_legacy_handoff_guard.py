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
def test_legacy_compare_supports_contextual_watchlist_handoff_without_url_names() -> None:
    source = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    helper = source.split("def _legacy_compare_query_filters()", 1)[1].split("def _route", 1)[0]
    assert 'f"{side}_season"' in helper
    assert 'f"{side}_mode"' in helper
    assert 'f"{side}_scope"' in helper
    assert 'f"{side}_competition"' in helper
    assert "_contextual_static_candidate(*contexts" in helper
    assert '"auto_context": True' in helper
    assert 'html.escape(name)' in source


def test_legacy_detail_consumes_validated_contextual_watchlist_handoff() -> None:
    source = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    helper = source.split("def _legacy_detail_query_context()", 1)[1].split("def _legacy_compare_query_filters", 1)[0]
    assert 'mode == "europe"' in helper
    assert 'competition in LEGACY_EUROPE_COMPETITIONS' in helper
    assert 'raw_scope in {"", "null"}' in helper
    detail = source.split("def render_player_detail_page()", 1)[1].split("def render_head_to_head_page", 1)[0]
    assert "detail_context = _legacy_detail_query_context()" in detail
    assert "selected_stats = detail_context[1]" in detail


def test_streamlit_leaderboard_detail_links_bypass_the_legacy_share_redirector() -> None:
    source = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    detail_url = source.split("def detail_url(row: pd.Series) -> str:", 1)[1].split('display["선수"]', 1)[0]
    assert "LEGACY_APP_URL" in detail_url
    assert 'f"?page=detail' not in detail_url


def test_streamlit_root_handoff_never_embeds_the_vercel_app_in_an_iframe() -> None:
    source = (Path(__file__).resolve().parents[1] / "app.py").read_text(encoding="utf-8")
    handoff = source.split("def render_frontend_handoff() -> None:", 1)[1].split("if not _requested_legacy_page", 1)[0]
    assert "st.link_button" in handoff
    assert "window.location.replace" not in handoff
