import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import numpy as np
import math
import itertools
import html
import json
from urllib.parse import quote

from fotmob_client import FotMobError, PlayerCandidate, fetch_player_multi_season_data, search_players
from metrics import DecisionMetrics, extract_multi_season_metrics
from rankings import (
    EUROPEAN_LEADERBOARD_ID,
    calculate_league_percentiles,
    get_league_metric_medians,
    get_spear_leaderboard,
    get_tactical_matrix,
    get_top_leagues_shot_quality,
)
from spear_cohort import load_spear_cohort
from tactical_ratio import get_heatmap_points, get_tactical_ratio, get_tactical_ratio_by_name, get_tactical_ratio_for_session


_UNIFIED_BAR_COUNTER = itertools.count()

# A GA4 measurement ID is public by design: it is delivered to the browser
# with the Google tag.  A Streamlit secret can override this default later
# (for example, when messi.kr uses a separate production data stream).
DEFAULT_GA_MEASUREMENT_ID = "G-8ZFS0ZM3NS"

st.set_page_config(page_title="Striker Decision Quality", page_icon="⚽", layout="wide")


def _ga_measurement_id() -> str:
    """Return a validated GA4 measurement ID without exposing any secret."""
    try:
        configured = str(st.secrets.get("GA_MEASUREMENT_ID", DEFAULT_GA_MEASUREMENT_ID)).strip()
    except Exception:
        configured = DEFAULT_GA_MEASUREMENT_ID
    return configured if configured.startswith("G-") else ""


def _render_ga_javascript(script: str) -> None:
    """Run trusted GA JavaScript in Streamlit's app document, not an iframe."""
    if not hasattr(st, "html"):
        return
    st.html(f"<script>{script}</script>", unsafe_allow_javascript=True)


def initialize_ga4_tracking() -> None:
    """Load GA4 once and emit one page view for each URL-level app page."""
    measurement_id = _ga_measurement_id()
    if not measurement_id:
        return
    measurement_json = json.dumps(measurement_id)
    _render_ga_javascript(
        "(() => {"
        f"const measurementId = {measurement_json};"
        "window.dataLayer = window.dataLayer || [];"
        "window.gtag = window.gtag || function(){ window.dataLayer.push(arguments); };"
        "if (!window.__messiGa4Loaded) {"
        "  const tag = document.createElement('script');"
        "  tag.async = true;"
        "  tag.src = 'https://www.googletagmanager.com/gtag/js?id=' + measurementId;"
        "  document.head.appendChild(tag);"
        "  window.gtag('js', new Date());"
        "  window.gtag('config', measurementId, {send_page_view: false});"
        "  window.__messiGa4Loaded = true;"
        "}"
        "const pagePath = window.location.pathname + window.location.search;"
        "if (window.__messiGa4LastPath !== pagePath) {"
        "  window.gtag('event', 'page_view', {page_path: pagePath, page_title: document.title});"
        "  window.__messiGa4LastPath = pagePath;"
        "}"
        "})();"
    )


def queue_ga_event(event_name: str, **params: object) -> None:
    """Persist one non-PII interaction event across the following rerun."""
    st.session_state["_pending_ga_event"] = {
        "name": event_name,
        "params": {key: str(value) for key, value in params.items() if value not in (None, "")},
    }


def emit_ga_event(event_name: str, **params: object) -> None:
    """Send one trusted, non-PII GA4 interaction event."""
    if not event_name or not _ga_measurement_id():
        return
    event_params = {key: str(value) for key, value in params.items() if value not in (None, "")}
    _render_ga_javascript(
        "(() => {"
        "window.dataLayer = window.dataLayer || [];"
        "window.gtag = window.gtag || function(){ window.dataLayer.push(arguments); };"
        f"window.gtag('event', {json.dumps(event_name)}, {json.dumps(event_params)});"
        "})();"
    )


def emit_ga_event_once(event_name: str, fingerprint: str, **params: object) -> None:
    """Avoid duplicate detail events caused by harmless Streamlit reruns."""
    state_key = f"_ga_event_once_{event_name}"
    if st.session_state.get(state_key) == fingerprint:
        return
    st.session_state[state_key] = fingerprint
    emit_ga_event(event_name, **params)


def emit_queued_ga_event() -> None:
    """Send the interaction queued before a Streamlit rerun or URL change."""
    pending = st.session_state.pop("_pending_ga_event", None)
    if not pending or not _ga_measurement_id():
        return
    event_name = str(pending.get("name", ""))
    event_params = pending.get("params", {})
    if not event_name or not isinstance(event_params, dict):
        return
    emit_ga_event(event_name, **event_params)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_search(term: str):
    return search_players(term)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_player_data(player_id: str):
    return fetch_player_multi_season_data(player_id)


def _long_season_name(season: str) -> str:
    """Turn the UI season key (``21/22``) into the static-cache key."""
    season = str(season).strip()
    if len(season) == 5 and "/" in season:
        return f"20{season[:2]}/20{season[3:]}"
    return season


def _static_session_rows(player_id: str, season: str) -> list[tuple[str, DecisionMetrics]]:
    """Recover archived records when the mutable player-history API drops them."""
    target_season = _long_season_name(season)
    rows: list[tuple[str, DecisionMetrics]] = []
    for (league_id, cohort_season), cohort in load_spear_cohort().items():
        if cohort_season != target_season:
            continue
        item = cohort.get(str(player_id))
        if item is None:
            continue
        _, metric = item
        rows.append((f"{season}_{league_id}", metric))
    return sorted(rows, key=lambda item: ((item[1].league_name or ""), item[1].league_id or 0))


def _resolve_static_player(player: PlayerCandidate, season: str) -> PlayerCandidate:
    """Use a season-local cached ID when search returns a stale replacement ID."""
    target_season = _long_season_name(season)
    cohorts = [
        cohort for (_, cohort_season), cohort in load_spear_cohort().items()
        if cohort_season == target_season
    ]
    if any(str(player.player_id) in cohort for cohort in cohorts) or not player.name.strip():
        return player
    normalise = lambda value: "".join(char for char in str(value).casefold() if char.isalnum())
    target_name = normalise(player.name)
    matches: dict[str, tuple[str, DecisionMetrics]] = {}
    for cohort in cohorts:
        for cached_id, (cached_name, metric) in cohort.items():
            if normalise(cached_name) == target_name:
                matches[str(cached_id)] = (cached_name, metric)
    if len(matches) != 1:
        return player
    cached_id, (cached_name, metric) = next(iter(matches.items()))
    return PlayerCandidate(cached_id, cached_name or player.name, metric.team_name or player.team_name)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_percentiles(
    player_id: str, season: str, metrics: DecisionMetrics, min_xg: float,
    restrict_to_forwards: bool, minimum_final_third_ratio: int, comparison_scope: int = 0,
    role_override: str = "auto",
):
    return calculate_league_percentiles(
        player_id, season, metrics, minimum_xg=min_xg,
        restrict_to_forwards=restrict_to_forwards,
        minimum_final_third_ratio=minimum_final_third_ratio,
        comparison_scope=comparison_scope,
        role_override=role_override,
    )


@st.cache_data(ttl=3600, show_spinner=False)
def cached_spear_leaderboard(league_id: int, season: str, comparison_scope: int) -> pd.DataFrame:
    season_name = f"20{season[:2]}/20{season[3:]}" if len(season) == 5 and "/" in season else season
    return get_spear_leaderboard(league_id, season_name, comparison_scope)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_top20(minimum_final_third_ratio: int):
    return get_top_leagues_shot_quality("25/26", minimum_final_third_ratio)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_league_medians(
    league_id: int, season_name: str, restrict_to_forwards: bool, minimum_final_third_ratio: int,
) -> dict[str, float | None]:
    return get_league_metric_medians(league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_tactical_matrix(
    league_id: int, season_name: str, restrict_to_forwards: bool, minimum_final_third_ratio: int,
    comparison_scope: int,
) -> pd.DataFrame:
    return get_tactical_matrix(
        league_id, season_name, restrict_to_forwards,
        minimum_final_third_ratio, comparison_scope,
    )


RADAR_AXES = [
    ("박스 안 결정력", "in_box_finishing_top_percent"),
    ("박스 밖 위협도", "out_box_shot_quality_top_percent"),
    ("공중볼 장악", "aerial_margin_per90_top_percent"),
    ("지상 버티기", "duel_margin_per90_top_percent"),
    ("드리블 돌파", "dribble_margin_per90_top_percent"),
    ("득점 볼륨 (xG/90)", "xg_per90_top_percent"),
]


def _radar_score(top_percent: float | None) -> float:
    """Map rank notation to a stable 0–100 radar score.

    Rank data labels the best player as the lowest top-percent value, hence the
    inversion. Missing values intentionally render at the neutral midpoint.
    """
    if top_percent is None:
        return 50.0
    return max(0.0, min(100.0, 100.0 - float(top_percent)))


IMPUTED_LOW_TIER_SCORE = 20.0


def _imputed_axis_attrs(rank, *, volume: bool) -> tuple[str, ...]:
    """Return axes that use the conservative missing-data D-tier floor."""
    field = "spear_imputed_volume_attrs" if volume else "spear_imputed_ratio_attrs"
    values = getattr(rank, field, ()) if rank else ()
    return tuple(values) if isinstance(values, (list, tuple)) else ()


def _axis_score(rank, percentile_attr: str, *, volume: bool) -> tuple[float, bool]:
    """Resolve a radar score without ever presenting a missing value as average."""
    if percentile_attr in _imputed_axis_attrs(rank, volume=volume):
        return IMPUTED_LOW_TIER_SCORE, True
    return _radar_score(getattr(rank, percentile_attr, None) if rank else None), False


def make_radar_profile(name: str, rank) -> dict[str, object]:
    return {
        "name": name,
        "labels": [label for label, _ in RADAR_AXES],
        "scores": [_radar_score(getattr(rank, attr, None) if rank else None) for _, attr in RADAR_AXES],
    }


def render_radar_chart(profiles: list[dict[str, object]], title: str) -> None:
    if not profiles:
        return
    figure = go.Figure()
    colors = [("#3B82F6", "rgba(59, 130, 246, 0.28)"), ("#EF4444", "rgba(239, 68, 68, 0.24)")]
    for index, profile in enumerate(profiles[:2]):
        labels = list(profile["labels"])
        scores = list(profile["scores"])
        color, fill = colors[index]
        figure.add_trace(go.Scatterpolar(
            r=scores + [scores[0]], theta=labels + [labels[0]],
            mode="lines+markers", name=str(profile["name"]), fill="toself",
            fillcolor=fill, line={"color": color, "width": 3},
            marker={"color": color, "size": 6},
            hovertemplate="%{theta}: %{r:.0f}점<extra>%{fullData.name}</extra>",
        ))
    figure.update_layout(
        title=title, height=440, margin={"l": 55, "r": 55, "t": 55, "b": 35},
        paper_bgcolor="rgba(0,0,0,0)",
        polar={
            "bgcolor": "rgba(0,0,0,0)",
            "radialaxis": {
                "range": [0, 100], "tickvals": [0, 25, 50, 75, 100],
                "gridcolor": "#64748B", "linecolor": "#94A3B8",
                "tickfont": {"color": "#CBD5E1"},
            },
            "angularaxis": {
                "gridcolor": "#64748B", "linecolor": "#94A3B8",
                "tickfont": {"color": "#F8FAFC", "size": 13},
            },
        },
        # ``theme.base`` is not guaranteed to be populated on Streamlit Cloud;
        # use explicit high-contrast polar labels for this dark dashboard.
        font={"color": "#F8FAFC"},
        showlegend=len(profiles) > 1,
        legend={"orientation": "h", "y": -0.08, "x": 0.5, "xanchor": "center"},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})


SPEAR_FACTOR_AXES = [
    ("박스 밖 킥 순도", "out_box_shot_quality_top_percent"),
    ("박스 타격 효율", "micro_zoning_finishing_top_percent"),
    ("위험 구역 파괴력", "danger_zone_progression_top_percent"),
    ("공중볼 장악력", "aerial_margin_per90_top_percent"),
    ("지상 경합 능력", "duel_margin_per90_top_percent"),
    ("공간 장악 효율", "danger_zone_density_top_percent"),
]

MESSI_FRAMEWORK = """
**M (Micro-zoning)** — 마이크로 조닝 기반 공간 분석

**E (Efficiency)** — 박스 타격 및 득점 효율

**S (Space)** — 공간 장악 및 5-Lane 활용

**S (Striking)** — 위험 구역 붕괴 및 박스 밖 타격력

**I (Intensity)** — 지상·공중 경합 및 물리적 강도
"""

VOLUME_FACTOR_AXES = [
    ("박스 밖 슈팅 시도", "outside_box_shots_attempts_top_percent", "out_box_shots", "outside_box_shots_attempts_rank"),
    ("박스 안 타격", "box_shots_volume_top_percent", "in_box_shots", "box_shots_volume_rank"),
    ("드리블 돌파 시도", "dribble_attempts_volume_top_percent", "dribble_attempts", "dribble_attempts_volume_rank"),
    ("공중볼 경합 시도", "aerial_duel_attempts_volume_top_percent", "aerial_duel_attempts", "aerial_duel_attempts_volume_rank"),
    ("지상 경합 시도", "ground_duel_attempts_volume_top_percent", "ground_duel_attempts", "ground_duel_attempts_volume_rank"),
    ("핵심 활동 반경", "cca_area_top_percent", "tactical:cca_area_pct", "cca_area_rank"),
]

# Every sector deliberately keeps a full 5×5 lookup: volume describes how
# often a player enters the situation, while ratio describes its efficiency.
# The wording is rendered only from the two synchronized radar tier results.
_LEGACY_TWIN_SECTOR_MATRIX = {
    "shooting": {
        "title": "🎯 슈팅",
        "volume": "total_shots_volume_top_percent",
        "ratio": "shot_quality_top_percent",
        "rows": {
            "S": {"S": "숨만 쉬어도 득점 찬스를 창출하고 닥치는 대로 꽂아 넣는 전천후 폭격기", "A": "압도적인 타격 볼륨으로 수비진을 끊임없이 두드리며 기어코 득점을 만들어내는 무자비한 머신", "B": "슈팅을 다소 난사하는 경향이 있으나 적극성으로 유효타를 챙기는 볼륨형 피니셔", "C": "찬스는 기가 막히게 많이 잡지만 결정적인 한 방이 부족한 주사위형 포워드", "D": "팀의 공격 기회를 독식하고도 영점이 흔들리는 탐욕형 난사꾼"},
            "A": {"S": "적극적으로 슈팅을 가져가며 정확도까지 끌어올린 고효율 스나이퍼", "A": "찾아온 찬스를 확실히 슈팅으로 연결하는 순도 높은 해결사", "B": "왕성한 의욕으로 슈팅을 시도하며 준수한 파괴력을 유지하는 실속형 포워드", "C": "시도 자체는 훌륭하나 결정력이 아쉬워 득점으로 잘 이어지지 않는 자원", "D": "기회는 자주 잡지만 영점 조절이 안 되어 흐름을 끊는 유형"},
            "B": {"S": "많은 슈팅을 때리지 않아도 찾아온 기회를 완벽하게 승화시키는 암살자", "A": "적절한 빈도로 슈팅을 시도하며 쏠쏠하게 골문을 위협하는 알짜배기 자원", "B": "주어진 기회만큼은 정직하게 살려내는 무난한 공격수", "C": "볼륨과 파괴력 모두 이도 저도 아닌 무색무취의 포워드", "D": "어쩌다 찾아오는 밥상마저 엎어버리는 고문관"},
            "C": {"S": "슈팅 기회는 적지만 한 번 때리면 치명타를 만드는 극단적 순도형", "A": "시도는 적지만 간결한 타격으로 유효슈팅을 건져내는 실속파", "B": "슈팅 관여는 적지만 가끔 한 방을 보여주는 스타일", "C": "찬스에서도 주저하다 기회를 날려먹는 소극적 성향", "D": "슈팅 시도도 파괴력도 낮아 수비수가 경계하지 않는 자원"},
            "D": {"S": "슈팅을 아끼지만 완벽한 찬스에는 기가 막히게 마무리하는 은둔형 고수", "A": "슈팅을 자제하고 패스 연계에 집중하는 도우미 성향", "B": "과감한 슈팅 시도가 전무해 공격수로서의 파괴력이 떨어지는 자원", "C": "슈팅 타이밍을 놓치고 뒤로 돌리기 바쁜 답답이", "D": "90분 내내 슈팅 한 번 제대로 못 때리는 그라운드의 VIP 관전자"},
        },
    },
    "box": {
        "title": "🥊 박스 안",
        "volume": "box_shots_volume_top_percent",
        "ratio": "in_box_finishing_top_percent",
        "rows": {
            "S": {"S": "박스 안을 지옥으로 만들며 닿는 족족 골망을 찢어버리는 생태계 파괴종", "A": "박스 안에 상주하며 위협과 득점을 생산하는 박스 안의 지배자", "B": "박스 안에서 쉴 새 없이 비비며 득점에 기여하는 끈질긴 알박기 포워드", "C": "박스 안에서 공은 많이 만지지만 골대 앞에서 얼타는 새가슴", "D": "박스 안에서 턴오버만 양산하는 공격의 블랙홀"},
            "A": {"S": "적극적인 박스 침투를 바탕으로 날카로운 한 방을 꽂는 침투형 골잡이", "A": "필요한 순간 박스 안으로 진입해 확실한 마침표를 찍는 해결사", "B": "박스 진입 빈도가 높아 동료에게 공간과 기회를 열어주는 자원", "C": "열심히 파고들지만 마무리에서 집중력이 흐트러지는 유형", "D": "박스 진입은 잦지만 실질적 영양가가 없는 공갈포"},
            "B": {"S": "틈이 보이면 여지없이 치명타를 꽂는 냄새 맡는 여우", "A": "적절한 타이밍에 박스를 타격하는 밸런스형", "B": "주어진 롤에 맞춰 박스 안에서 비벼주는 국밥형 공격수", "C": "박스 진입 타이밍과 결정력이 모두 애매한 반쪽짜리 피니셔", "D": "어쩌다 박스 안에 들어와도 기회를 날려먹는 허수아비"},
            "C": {"S": "기습 침투 한 번으로 완벽한 골을 훔쳐내는 하이재킹 장인", "A": "진입 빈도는 낮지만 찬스가 오면 침착하게 밀어 넣는 실속파", "B": "박스 안 싸움을 꺼려 외곽에 머무는 성향", "C": "박스 안으로 들어가는 움직임이 부족해 고립되기 쉬운 자원", "D": "몸싸움이 두려워 외곽만 도는 회피형 피니셔"},
            "D": {"S": "박스엔 거의 안 들어가지만 외곽 한 방으로 경기를 끝내는 이단아", "A": "2선에서 플레이메이킹과 슈팅을 노리는 변칙형 포워드", "B": "박스 안 타격이 전무해 텐사이드 전술에 도움이 적은 선수", "C": "박스 안으로 안 들어가면서 득점만 바라는 논리주의자", "D": "페널티 박스 근처 공포증처럼 외곽으로만 도는 투명인간"},
        },
    },
}

TWIN_SECTOR_MATRIX = {
    "outside_box_shooting": {
        "title": "\U0001f680 \ubc15\uc2a4 \ubc16 \uc288\ud305\ub825",
        "volume": "outside_box_shots_attempts_top_percent",
        "ratio": "out_box_shot_quality_top_percent",
        "rows": {
            "S": {
                "S": "\uc228\ub9cc \uc26c\uc5b4\ub3c4 \ub4dd\uc810 \ucc2c\uc2a4\ub97c \ucc3d\ucd9c\ud558\uace0 \ub2e5\uce58\ub294 \ub300\ub85c \uaf42\uc544 \ub123\ub294 \uc804\ucc9c\ud6c4 \ud3ed\uaca9\uae30",
                "A": "\uc555\ub3c4\uc801\uc778 \ud0c0\uaca9 \ubcfc\ub968\uc73c\ub85c \uc218\ube44\uc9c4\uc744 \ub04a\uc784\uc5c6\uc774 \ub450\ub4dc\ub9ac\uba70 \uae30\uc5b4\ucf54 \ub4dd\uc810\uc744 \ub9cc\ub4e4\uc5b4\ub0b4\ub294 \ubb34\uc790\ube44\ud55c \uba38\uc2e0",
                "B": "\uc288\ud305\uc744 \ub2e4\uc18c \ub09c\uc0ac\ud558\ub294 \uacbd\ud5a5\uc774 \uc788\uc73c\ub098 \ud2b9\uc720\uc758 \uc801\uadf9\uc131\uc73c\ub85c 1\uc778\ubd84 \uc720\ud6a8\ud0c0\ub97c \ucc59\uae30\ub294 \ubcfc\ub968\ud615 \ud53c\ub2c8\uc154",
                "C": "\ucc2c\uc2a4\ub294 \uae30\uac00 \ub9c9\ud788\uac8c \ub9ce\uc774 \uc7a1\uc9c0\ub9cc \uacb0\uc815\uc801\uc778 \ud55c \ubc29\uc774 \ubd80\uc871\ud574 \ud32c\ub4e4\uc758 \ud608\uc555\uc744 \uc62c\ub9ac\ub294 \uc8fc\uc0ac\uc704\ud615 \ud3ec\uc6cc\ub4dc",
                "D": "\ud300\uc758 \ubaa8\ub4e0 \uacf5\uaca9 \uae30\ud68c\ub97c \ub3c5\uc2dd\ud558\uace0\ub3c4 \ud5c8\uacf5\uc5d0 \ub625\ubcfc\ub9cc \ub0a0\ub824\ub300\ub294 \ubca4\uce58\ud589\uc774 \uc2dc\uae09\ud55c \ud0d0\uc695\ud615 \ub09c\uc0ac\uafbc"
            },
            "A": {
                "S": "\uc801\uadf9\uc801\uc73c\ub85c \uc288\ud305\uc744 \uac00\uc838\uac00\uba70 \uc815\ud655\ub3c4\uae4c\uc9c0 \uadf9\ub3c4\ub85c \ub04c\uc5b4\uc62c\ub9b0 \uace0\ud6a8\uc728 \uc2a4\ub098\uc774\ud37c",
                "A": "\ucc3e\uc544\uc628 \ucc2c\uc2a4\ub97c \ud655\uc2e4\ud558\uac8c \uc288\ud305\uc73c\ub85c \uc5f0\uacb0\ud558\uba70 \uc21c\ub3c4 \ub192\uc740 \uacb0\uc815\ub825\uc744 \ubcf4\uc5ec\uc8fc\ub294 \ud574\uacb0\uc0ac",
                "B": "\uc655\uc131\ud55c \uc758\uc695\uc73c\ub85c \uc288\ud305\uc744 \uc2dc\ub3c4\ud558\uba70 \uc900\uc218\ud55c \ud30c\uad34\ub825\uc744 \uc720\uc9c0\ud558\ub294 \uc2e4\uc18d\ud615 \ud3ec\uc6cc\ub4dc",
                "C": "\uc2dc\ub3c4 \uc790\uccb4\ub294 \ud6cc\ub96d\ud558\ub098 \uacb0\uc815\ub825\uc774 \uc544\uc26c\uc6cc \ub4dd\uc810\uc73c\ub85c \uc798 \uc774\uc5b4\uc9c0\uc9c0 \uc54a\ub294 \uc790\uc6d0",
                "D": "\uae30\ud68c\ub294 \uc790\uc8fc \uc7a1\uc73c\uba74\uc11c \uc601\uc810 \uc870\uc808\uc740 \uc804\ud600 \uc548 \ub418\uc5b4 \ud300\uc758 \ud750\ub984\uc744 \ub04a\uc5b4\uba39\ub294 \ub9c8\uc774\ub108\uc2a4\uc758 \uc190"
            },
            "B": {
                "S": "\ub9ce\uc740 \uc288\ud305\uc744 \ub54c\ub9ac\uc9c0 \uc54a\uc544\ub3c4 \ucc3e\uc544\uc628 \uae30\ud68c\ub97c \uc644\ubcbd\ud558\uac8c \ub4dd\uc810\uc73c\ub85c \uc2b9\ud654\uc2dc\ud0a4\ub294 \uc554\uc0b4\uc790",
                "A": "\uc801\uc808\ud55c \ube48\ub3c4\ub85c \uc288\ud305\uc744 \uc2dc\ub3c4\ud558\uba70 \uc3e0\uc3e0\ud558\uac8c \uace8\ubb38\uc744 \uc704\ud611\ud558\ub294 \uc54c\uc9dc\ubc30\uae30 \uc790\uc6d0",
                "B": "\uc8fc\uc5b4\uc9c4 \uae30\ud68c\ub9cc\ud07c\uc740 \uc815\uc9c1\ud558\uac8c \uc0b4\ub824\ub0b4\uba70 \ubc25\uac12\uc740 \uac70\ub72c\ud788 \ud574\ub0b4\ub294 \ubb34\ub09c\ud55c \uacf5\uaca9\uc218",
                "C": "\ubcfc\ub968\uacfc \ud30c\uad34\ub825 \ubaa8\ub450 \uc774\ub3c4 \uc800\ub3c4 \uc544\ub2cc, \ub69c\ub837\ud55c \ubb34\uae30\uac00 \uc5c6\ub294 \ubb34\uc0c9\ubb34\ucde8\uc758 \ud3ec\uc6cc\ub4dc",
                "D": "\uc5b4\uca4c\ub2e4 \ucc3e\uc544\uc624\ub294 \uc644\ubcbd\ud55c \ubc25\uc0c1\ub9c8\uc800 \uc5ce\uc5b4\ubc84\ub9ac\uba70 \uacf5\uaca9\uc758 \ud608\uc744 \ub9c9\uc544\ubc84\ub9ac\ub294 \uace0\ubb38\uad00"
            },
            "C": {
                "S": "\uc288\ud305 \uae30\ud68c\ub97c \uc880\ucc98\ub7fc \uc548 \ub9cc\ub4e4\uc9c0\ub9cc \ud55c \ubc88 \ub54c\ub9ac\uba74 \ubb34\uc870\uac74 \uace8\ub85c \uc5f0\uacb0\ud558\ub294 \uadf9\ub2e8\uc801 \uc21c\ub3c4 100%\ud615",
                "A": "\uc2dc\ub3c4\ub294 \uc801\uc9c0\ub9cc \uac04\uacb0\ud55c \ud0c0\uaca9\uc73c\ub85c \ud655\uc2e4\ud55c \uc720\ud6a8\uc288\ud305\uc744 \uac74\uc838\ub0b4\ub294 \uc2e4\uc18d\ud30c",
                "B": "\uc804\uccb4\uc801\uc73c\ub85c \uc288\ud305 \uad00\uc5ec\uac00 \uc801\uc5b4 \uc874\uc7ac\uac10\uc774 \ud76c\ubbf8\ud558\uc9c0\ub9cc \uac00\ub054 \ud55c \ubc29\uc744 \ubcf4\uc5ec\uc8fc\ub294 \uc2a4\ud0c0\uc77c",
                "C": "\uacbd\uae30 \ub0b4\ub0b4 \uc288\ud305\uc744 \uac70\uc758 \uc544\ub07c\uba70 \ucc2c\uc2a4\uc5d0\uc11c\ub3c4 \uc8fc\uc800\ud558\ub2e4 \uae30\ud68c\ub97c \ub0a0\ub824\uba39\ub294 \uc18c\uadf9\uc801 \uc131\ud5a5",
                "D": "\uc288\ud305 \uc2dc\ub3c4 \uc790\uccb4\uac00 \uadf9\ub3c4\ub85c \uc801\uace0 \ud30c\uad34\ub825\ub3c4 \ubc14\ub2e5\uc774\ub77c \uc0c1\ub300 \uc218\ube44\uc218\uac00 \uc804\ud600 \uacbd\uacc4\ud558\uc9c0 \uc54a\ub294 \uc790\uc6d0"
            },
            "D": {
                "S": "\uc288\ud305\uc744 \uc544\uc608 \uc548 \ub54c\ub9ac\ub824 \ub4e4\uc9c0\ub9cc \ubc15\uc2a4 \uc548\uc5d0\uc11c \uc644\ubcbd\ud55c \ucc2c\uc2a4\uc5d4 \uae30\uac00 \ub9c9\ud788\uac8c \uc9d1\uc5b4\ub123\ub294 \uc740\ub454\ud615 \uace0\uc218",
                "A": "\uc790\uc2e0\uc758 \ud55c\uacc4\ub97c \uc54c\uc544\uc11c \uc288\ud305\uc744 \uc790\uc81c\ud558\uace0 \ud328\uc2a4 \uc5f0\uacc4\uc5d0\ub9cc \uc9d1\uc911\ud558\ub294 \ub3c4\uc6b0\ubbf8 \uc131\ud5a5",
                "B": "\uacfc\uac10\ud55c \uc288\ud305 \uc2dc\ub3c4\uac00 \uc804\ubb34\ud558\uc5ec \uacf5\uaca9\uc218\ub85c\uc11c\uc758 \ud30c\uad34\ub825\uc774 \ub208\uc5d0 \ub744\uac8c \ub5a8\uc5b4\uc9c0\ub294 \uc790\uc6d0",
                "C": "\uc288\ud305 \ud0c0\uc774\ubc0d\uc744 \ub9e4\ubc88 \ub193\uce58\uace0 \ub4a4\ub85c \ub3cc\ub9ac\uae30 \ubc14\ube60 \uad00\uc911\ub4e4\uc758 \ud0c4\uc2dd\uc744 \uc790\uc544\ub0b4\ub294 \ub2f5\ub2f5\uc774",
                "D": "90\ubd84 \ub0b4\ub0b4 \uc288\ud305 \ud55c \ubc88 \uc81c\ub300\ub85c \ubabb \ub54c\ub824\ubcf4\uace0 \ud544\ub4dc\ub97c \uc0b0\ucc45\ub9cc \ud558\ub2e4 \ub05d\ub098\ub294 \uadf8\ub77c\uc6b4\ub4dc\uc758 VIP \uad00\uc804\uc790"
            }
        },
    },
    "deep_box_lethality": {
        "title": "\U0001f94a \ubc15\uc2a4 \ud0c0\uaca9 \ud6a8\uc728",
        "volume": "box_shots_volume_top_percent",
        "ratio": "micro_zoning_finishing_top_percent",
        "rows": {
            "S": {
                "S": "\ubc15\uc2a4 \uc548\uc744 \uc9c0\uc625\uc73c\ub85c \ub9cc\ub4e4\uba70 \ub2ff\ub294 \uc871\uc871 \uace8\ub9dd\uc744 \ucc22\uc5b4\ubc84\ub9ac\ub294 \uc0dd\ud0dc\uacc4 \ud30c\uad34\uc885",
                "A": "\ubc15\uc2a4 \uc548\uc5d0 \uc0c1\uc8fc\ud558\uba70 \ub04a\uc784\uc5c6\ub294 \uc704\ud611\uacfc \ub4dd\uc810\uc744 \uc0dd\uc0b0\ud574 \ub0b4\ub294 \ubc15\uc2a4 \uc548\uc758 \uc9c0\ubc30\uc790",
                "B": "\ubc15\uc2a4 \uc548\uc5d0\uc11c \uc274 \uc0c8 \uc5c6\uc774 \ube44\ube44\uba70 \uc5b4\ub5bb\uac8c\ub4e0 \ub4dd\uc810\uc5d0 \uae30\uc5ec\ud558\ub294 \ub048\uc9c8\uae34 \uc54c\ubc15\uae30 \ud3ec\uc6cc\ub4dc",
                "C": "\ubc15\uc2a4 \uc548\uc5d0\uc11c \uacf5\uc740 \uc81c\uc77c \ub9ce\uc774 \ub9cc\uc9c0\ub294\ub370 \uc815\uc791 \uace8\ub300 \uc55e\uc5d0\uc11c\ub294 \uc5bc\ud0c0\ub294 \uc0c8\uac00\uc2b4",
                "D": "\uc218\ube44\uc218\ub4e4\uc5d0\uac8c \uc644\uc804\ud788 \ub458\ub7ec\uc2f8\uc778 \ucc44 \ubc15\uc2a4 \uc548\uc5d0\uc11c \ud134\uc624\ubc84\ub9cc \uc591\uc0b0\ud558\ub294 \uacf5\uaca9\uc758 \ube14\ub799\ud640"
            },
            "A": {
                "S": "\uc801\uadf9\uc801\uc778 \ubc15\uc2a4 \uce68\ud22c\ub97c \ubc14\ud0d5\uc73c\ub85c \ub0a0\uce74\ub85c\uc6b4 \ud55c \ubc29\uc744 \uaf42\uc544 \ub123\ub294 \uce68\ud22c\ud615 \uace8\uc7a1\uc774",
                "A": "\ud544\uc694\ud55c \uc21c\uac04 \ubc15\uc2a4 \uc548\uc73c\ub85c \uc9c4\uc785\ud574 \ud655\uc2e4\ud55c \ub9c8\uce68\ud45c\ub97c \ucc0d\uc5b4\uc8fc\ub294 \ud574\uacb0\uc0ac",
                "B": "\ubc15\uc2a4 \uc548 \uc9c4\uc785 \ube48\ub3c4\uac00 \ub192\uc544 \ub3d9\ub8cc\ub4e4\uc5d0\uac8c \uacf5\uac04\uacfc \uae30\ud68c\ub97c \ud568\uaed8 \uc5f4\uc5b4\uc8fc\ub294 \uc790\uc6d0",
                "C": "\uc5f4\uc2ec\ud788 \ubc15\uc2a4 \uc548\uc73c\ub85c \ud30c\uace0\ub4e4\uc9c0\ub9cc \ub9c8\uc9c0\ub9c9 \ub9c8\ubb34\ub9ac \uacfc\uc815\uc5d0\uc11c \uc9d1\uc911\ub825\uc774 \ud750\ud2b8\ub7ec\uc9c0\ub294 \uc720\ud615",
                "D": "\ubc15\uc2a4 \uc9c4\uc785\uc740 \uc7a6\uc73c\ub098 \uc218\ube44 \ubab8\uc2f8\uc6c0\uc5d0 \ubc00\ub824 \uc2e4\uc9c8\uc801\uc778 \uc601\uc591\uac00\uac00 \uc804\ud600 \uc5c6\ub294 \uacf5\uac08\ud3ec"
            },
            "B": {
                "S": "\ubc15\uc2a4 \uadfc\ucc98\ub97c \ubc30\ud68c\ud558\ub2e4 \ud2c8\uc774 \ubcf4\uc774\uba74 \uc5ec\uc9c0\uc5c6\uc774 \uce58\uba85\ud0c0\ub97c \uaf42\ub294 \ub0c4\uc0c8 \ub9e1\ub294 \uc5ec\uc6b0",
                "A": "\uc801\uc808\ud55c \ud0c0\uc774\ubc0d\uc5d0 \ubc15\uc2a4\ub97c \ud0c0\uaca9\ud558\uba70 \uc900\uc218\ud55c \uacb0\uc815\ub825\uc744 \ubcf4\uc5ec\uc8fc\ub294 \ubc38\ub7f0\uc2a4\ud615",
                "B": "\uc8fc\uc5b4\uc9c4 \ub864\uc5d0 \ub9de\ucdb0 \ubc15\uc2a4 \uc548\uc5d0\uc11c \uc801\ub2f9\ud788 \ube44\ubcbc\uc8fc\uace0 \ub9c8\ubb34\ub9ac\ud558\ub294 \uad6d\ubc25\ud615 \uacf5\uaca9\uc218",
                "C": "\ubc15\uc2a4 \uc9c4\uc785 \ud0c0\uc774\ubc0d\ub3c4, \uacb0\uc815\ub825\ub3c4 \ubaa8\ub450 \uc560\ub9e4\ubaa8\ud638\ud55c \ubc18\ucabd\uc9dc\ub9ac \ud53c\ub2c8\uc154",
                "D": "\uc5b4\uca4c\ub2e4 \ubc15\uc2a4 \uc548\uc5d0 \ub4e4\uc5b4\uc640\ub3c4 \uc218\ube44\uc218 \ud551\uacc4\ub9cc \ub300\ub2e4 \uae30\ud68c\ub97c \ub0a0\ub824\uba39\ub294 \ud5c8\uc218\uc544\ube44"
            },
            "C": {
                "S": "\ubc15\uc2a4 \ubc14\uae65\uc5d0 \uba38\ubb3c\ub2e4 \uae30\uc2b5\uc801\uc778 \uce68\ud22c \ud55c \ubc88\uc73c\ub85c \uc644\ubcbd\ud55c \uace8\uc744 \ud6d4\uccd0\ub0b4\ub294 \ud558\uc774\uc7ac\ud0b9 \uc7a5\uc778",
                "A": "\uc9c4\uc785 \ube48\ub3c4\ub294 \ub0ae\uc9c0\ub9cc \ubcf8\uc778\uc5d0\uac8c \ucc2c\uc2a4\uac00 \uc624\uba74 \uce68\ucc29\ud558\uac8c \ubc00\uc5b4 \ub123\ub294 \uc2e4\uc18d\ud30c",
                "B": "\ubc15\uc2a4 \uc548 \uc2f8\uc6c0\uc744 \uaebc\ub824 \uc678\uacfd\uc5d0\uc11c \uc8fc\ub85c \uba38\ubb3c\uba70 \uac89\ub3c4\ub294 \ud50c\ub808\uc774\ub97c \ud558\ub294 \uc131\ud5a5",
                "C": "\ubc15\uc2a4 \uc548\uc73c\ub85c \ub4e4\uc5b4\uac00\ub294 \uc6c0\uc9c1\uc784 \uc790\uccb4\uac00 \ub208\uc5d0 \ub744\uac8c \ubd80\uc871\ud574 \uace0\ub9bd\ub418\uae30 \uc26c\uc6b4 \uc790\uc6d0",
                "D": "\ubab8\uc2f8\uc6c0\uc774 \ub450\ub824\uc6cc \ubc15\uc2a4 \uc678\uacfd\uc73c\ub85c\ub9cc \ube59\ube59 \ub3c4\ub294 \uc18c\uadf9\uc801\uc778 \ud68c\ud53c\ud615 \ud53c\ub2c8\uc154"
            },
            "D": {
                "S": "\ubc15\uc2a4 \uc548\uc5d4 \uac70\uc758 \uc548 \ub4e4\uc5b4\uac00\uc9c0\ub9cc \uc678\uacfd \uc911\uac70\ub9ac\ub098 \uc6d0\ud130\uce58\ub85c \uacbd\uae30\ub97c \ub05d\ub0b4\ubc84\ub9ac\ub294 \uc774\ub2e8\uc544",
                "A": "\ubc15\uc2a4 \uc9c4\uc785\uc744 \uac70\ubd80\ud558\uace0 2\uc120\uc5d0\uc11c \ud50c\ub808\uc774\uba54\uc774\ud0b9\uacfc \uc288\ud305\uc744 \ub178\ub9ac\ub294 \ubcc0\uce59\ud615 \ud3ec\uc6cc\ub4dc",
                "B": "\ubc15\uc2a4 \uc548 \ud0c0\uaca9\uc774 \uc804\ubb34\ud558\uc5ec \ud300\uc758 \ud150\uc0ac\uc774\ub4dc \uc804\uc220\uc5d0 \ud070 \ub3c4\uc6c0\uc744 \uc8fc\uc9c0 \ubabb\ud558\ub294 \uc120\uc218",
                "C": "\ubc15\uc2a4 \uc548\uc73c\ub85c \uc808\ub300 \uc548 \ub4e4\uc5b4\uac00\uba74\uc11c \ub4dd\uc810\uc740 \ubc14\ub77c\ub294 \uae30\uc801\uc758 \ub17c\ub9ac\uc8fc\uc758\uc790",
                "D": "\ud398\ub110\ud2f0 \ubc15\uc2a4 \uadfc\ucc98 \uacf5\ud3ec\uc99d\uc774\ub77c\ub3c4 \uc788\ub294 \ub4ef \ucca0\uc800\ud558\uac8c \uc678\uacfd\uc73c\ub85c\ub9cc \ub3c4\ub9dd \ub2e4\ub2c8\ub294 \ud22c\uba85\uc778\uac04"
            }
        },
    },
    "danger_zone_progression": {
        "title": "\u26a1 \uc704\ud5d8 \uad6c\uc5ed \ud30c\uad34\ub825",
        "volume": "dribble_attempts_volume_top_percent",
        "ratio": "danger_zone_progression_top_percent",
        "rows": {
            "S": {
                "S": "\uacf5\uc744 \uc7a1\uc73c\uba74 \uc0c1\ub300 \uc218\ube44\uc9c4\uc744 \ucc22\uc5b4\ubc1c\uae30\uba70 \ubb34\uc5d0\uc11c \uc720\ub97c \ucc3d\uc870\ud558\ub294 \uc5b8\ud130\ucc98\ube14 \ud06c\ub799",
                "A": "\ub04a\uc784\uc5c6\ub294 \uc800\ub3cc\uc801 \ub3cc\ud30c\ub85c \uc218\ube44\uc9c4\uc5d0 \uc2ec\uac01\ud55c \uade0\uc5f4\uc744 \ub0b4\ub294 \ud30c\uad34\uc801 \uc804\uc9c4\uae30\uae30",
                "B": "\ud134\uc624\ubc84 \ub9ac\uc2a4\ud06c\uac00 \ub2e4\uc18c \uc788\uc73c\ub098, \ud2b9\uc720\uc758 \uc804\uc9c4\uc131\uc73c\ub85c \ud300\uc758 \ud65c\ub85c\ub97c \ub6ab\uc5b4\uc8fc\ub294 \ubd88\ub3c4\uc800",
                "C": "\uc5b4\uc124\ud508 \uac1c\uc778\uae30\ub85c \ubb34\ub9ac\ud55c \ub3cc\ud30c\ub9cc \uc2dc\ub3c4\ud558\ub2e4 \ud300\uc758 \uacf5\uaca9 \ud15c\ud3ec\ub97c \ub2e4 \uc7a1\uc544\uba39\ub294 \ube0c\ub808\uc774\ud06c",
                "D": "\uace0\uac1c \ud479 \uc219\uc774\uace0 \ubb34\uc9c0\uc131 \ub4dc\ub9ac\ube14\ub9cc \uce58\ub2e4 \uacf5\uc744 \ud5cc\ub0a9\ud558\ub294 \uadf8\ub77c\uc6b4\ub4dc\uc758 \ud15c\ud3ec \ubc40\ud30c\uc774\uc5b4"
            },
            "A": {
                "S": "\ud655\uc2e4\ud560 \ub54c\ub9cc \uc2dc\ub3c4\ud558\uc5ec \uc131\uacf5\ub960\uc744 \uadf9\ub300\ud654\ud558\ub294 \uace0\ud6a8\uc728 \ub4dc\ub9ac\ube14\ub7ec",
                "A": "\ub0a0\uce74\ub85c\uc6b4 \uc804\uc9c4 \ub4dc\ub9ac\ube14\ub85c \uce21\uba74\uc774\ub098 \uc911\uc559\uc744 \ud5e4\uc9d1\uc5b4\ub193\ub294 \uc704\ud611\uc801\uc778 \uc790\uc6d0",
                "B": "\uc801\ub2f9\ud55c \ud0c0\uc774\ubc0d\uc5d0 \ubcfc\uc744 \uc6b4\ubc18\ud574\uc8fc\uba70 \uacf5\uaca9\uc758 \uc228\ud1b5\uc744 \ud2b8\uc5ec\uc8fc\ub294 \ud14c\ud06c\ub2c8\uc158",
                "C": "\ub4dc\ub9ac\ube14 \uc2dc\ub3c4\uc5d0 \ube44\ud574 \uc131\uacf5\ub960\uc774 \ub5a8\uc5b4\uc838 \uacf5\uaca9\uc758 \ud750\ub984\uc744 \uc790\uc8fc \ub04a\uc5b4\uba39\ub294 \uc720\ud615",
                "D": "\ud15c\ud3ec\ub97c \uc0b4\ub9ac\uc9c0 \ubabb\ud558\uace0 \uac1c\uc778\uae30 \uc695\uc2ec\uc744 \ubd80\ub9ac\ub2e4 \uace0\ub9bd\ub418\ub294 \uace0\uc9d1\uc7c1\uc774"
            },
            "B": {
                "S": "\ubd88\ud544\uc694\ud55c \ud130\uce58\ub97c \ubc30\uc81c\ud558\uace0 \uac00\uc7a5 \uc644\ubcbd\ud55c \ud0c0\uc774\ubc0d\uc5d0\ub9cc \ub3cc\ud30c\ub97c \uc131\uacf5\uc2dc\ud0a4\ub294 \uc9c0\ub2a5\ud615 \ud50c\ub808\uc774\uc5b4",
                "A": "\uac04\uacb0\ud55c \uc804\uc9c4 \ud328\uc2a4\uc640 \ub4dc\ub9ac\ube14\uc744 \uc11e\uc5b4 \uc4f0\uba70 \uc724\ud65c\uc720 \uc5ed\ud560\uc744 \ud558\ub294 \uc790\uc6d0",
                "B": "\ubb34\ub9ac\ud558\uc9c0 \uc54a\uace0 \uc801\uc7ac\uc801\uc18c\uc5d0 \ud544\uc694\ud55c \ub9cc\ud07c\uc758 \uc804\uc9c4\uc744 \ubcf4\uc5ec\uc8fc\ub294 \ubc38\ub7f0\uc2a4\ud615",
                "C": "\ub3cc\ud30c \uc2dc\ub3c4 \uc790\uccb4\ub3c4 \uc5b4\uc911\uac04\ud558\uace0 \uc131\uacf5\ub960\ub3c4 \ud3c9\uc774\ud558\uc5ec \ud070 \uc784\ud329\ud2b8\uac00 \uc5c6\ub294 \uc790\uc6d0",
                "D": "\uc0c1\ub300\uc758 \uac15\ud55c \uc555\ubc15\uc5d0 \ubd80\ub52a\ud788\uba74 \ub4dc\ub9ac\ube14\ub85c \ud480\uc5b4\ub098\uac00\uc9c0 \ubabb\ud558\uace0 \ud5c8\ub465\ub300\ub294 \uc2a4\ud0c0\uc77c"
            },
            "C": {
                "S": "\ub4dc\ub9ac\ube14\uc744 \uac70\uc758 \uc548 \ud558\uc9c0\ub9cc \uac00\ub054 \uc2dc\ub3c4\ud560 \ub54c\ub9c8\ub2e4 \uc0c1\ub300\ub97c \uc644\uc804\ud788 \ubb34\ub825\ud654\ud558\ub294 \ud0c0\uc774\ubc0d\uc758 \ub9c8\ubc95\uc0ac",
                "A": "\uacf5\uc744 \uc624\ub798 \ub04c\uc9c0 \uc54a\uace0 \uac04\uacb0\ud55c \uc6d0\ud130\uce58 \uc704\uc8fc\ub85c \uc804\uc9c4\uc744 \ub3c4\ubaa8\ud558\ub294 \uc2e4\uc18d\ud30c",
                "B": "\uc790\ub825 \ub3cc\ud30c\ubcf4\ub2e4\ub294 \ub3d9\ub8cc\ub97c \uc774\uc6a9\ud55c \uc5f0\uacc4 \ud50c\ub808\uc774\ub97c \uc120\ud638\ud558\ub294 \ud0c0\uc785",
                "C": "\ub300\uc778 \ub3cc\ud30c \ub2a5\ub825\uc774 \ubd80\uc871\ud574 \uc218\ube44\uc218\uac00 \ubd99\uc73c\uba74 \uace7\ubc14\ub85c \uacf5\uc744 \ub0b4\uc8fc\ub294 \uc790\uc6d0",
                "D": "\ubc1c\ubc11 \uc555\ubc15\uc5d0 \ub9e4\uc6b0 \ucde8\uc57d\ud558\uc5ec \ub4dc\ub9ac\ube14 \uc2dc\ub3c4\ub9c8\ub2e4 \ube8f\uae30\uae30 \ubc14\uc05c \ud5c8\uc57d \uccb4\uc9c8"
            },
            "D": {
                "S": "\ub4dc\ub9ac\ube14 \uc5c6\uc774\ub3c4 \ucc9c\uc7ac\uc801\uc778 \uacf5\uac04 \uc774\ud574\uc640 \ud328\uc2a4\ub85c \uc218\ube44\uc9c4\uc744 \ubc14\ubcf4\ub85c \ub9cc\ub4dc\ub294 \ub3c4\uc6b0\ubbf8",
                "A": "\ubcfc\uc744 \uc18c\uc720\ud558\uc9c0 \uc54a\uace0 \uac04\uacb0\ud55c \uc5f0\uacc4\ub85c\ub9cc \uc804\uc9c4\uc744 \uc774\ub04c\uc5b4\ub0b4\ub294 \ubb34\uacb0\uc810 \uc628\ub354\ubcfc \uae30\ud53c\ud615",
                "B": "\uc2a4\uc2a4\ub85c \ub6ab\uc5b4\ub0b4\ub294 \ub2a5\ub825\uc774 \uac70\uc138\ub418\uc5b4 \ud300\uc758 \ub2e8\uc870\ub85c\uc6c0\uc744 \uc720\ubc1c\ud558\ub294 \ubc18\ucabd\uc9dc\ub9ac",
                "C": "\uacf5\ub9cc \uc7a1\uc73c\uba74 \ubd88\uc548\ud574\ud558\uba70 \uc8fc\uc704 \ub3d9\ub8cc\uc5d0\uac8c \ud3ed\ud0c4 \ub3cc\ub9ac\uae30\ub97c \uc2dc\uc804\ud558\ub294 \uc120\uc218",
                "D": "\ubc1c\ubc11\uc774 \ub450\ub824\uc6cc \uacf5\ub9cc \uc624\uba74 \ubc31\ud328\uc2a4\ub85c \uc77c\uad00\ud558\ub294 \ucd5c\uc545\uc758 \ud15c\ud3ec \ube0c\ub808\uc774\ucee4"
            }
        },
    },
    "aerial": {
        "title": "\U0001f985 \uacf5\uc911\ubcfc",
        "volume": "aerial_duel_attempts_volume_top_percent",
        "ratio": "aerial_margin_per90_top_percent",
        "rows": {
            "S": {
                "S": "\uacf5\uc911\uc744 \uc644\ubcbd\ud788 \uc9c0\ubc30\ud558\uba70 \uc0c1\ub300 \uc13c\ud130\ubc31\uc758 \ub69d\ubc30\uae30\ub97c \ubaa8\uc870\ub9ac \uae68\ubc84\ub9ac\ub294 \ud3ed\uaca9\uae30",
                "A": "\uc555\ub3c4\uc801\uc778 \ud69f\uc218\uc640 \ud6cc\ub96d\ud55c \ud0c0\uc810\uc73c\ub85c \ud300\uc758 \ub871\ubcfc \uc804\uc220\uc744 \ub4e0\ub4e0\ud788 \ucc45\uc784\uc9c0\ub294 \ud0c0\uac9f\ub9e8",
                "B": "\uc2b9\ub960\uc740 \uc555\ub3c4\uc801\uc774\uc9c0 \uc54a\uc73c\ub098, \uc27c \uc5c6\uc774 \uacf5\uc911\uc5d0\uc11c \ube44\ubcbc\uc8fc\uba70 \uc0c1\ub300\uc640 \uc9c4\ud759\ud0d5 \uc2f8\uc6c0\uc744 \ud574\uc8fc\ub294 \ud22c\uc0ac",
                "C": "\ud5c8\uad6c\ud55c \ub0a0 \uc810\ud504\ub9cc \ub6f0\uace0 \uacf5\uc740 \ub2e4 \ube8f\uae30\uba70 \uc0c1\ub300\uc5d0\uac8c \ubcfc \uc18c\uc720\uad8c\ub9cc \ub118\uaca8\uc8fc\ub294 \uc790\ud310\uae30",
                "D": "\ud0a4\ub9cc \ucef8\uc9c0 \uc810\ud504 \ud0c0\uc774\ubc0d\ub3c4 \ubabb \ub9de\ucd94\uba74\uc11c \ub871\ubcfc\ub9cc \uace0\uc9d1\ud558\ub294 \uc758\ubbf8 \uc5c6\ub294 \uc810\ud504 \uba38\uc2e0"
            },
            "A": {
                "S": "\uacbd\ud569 \ube48\ub3c4\uac00 \ub192\uc73c\uba74\uc11c\ub3c4 \ud0c0\uc810\uc774 \ub9e4\uc6b0 \uc815\ud655\ud574 \uacf5\uc911\uc804\uc758 \uc2b9\ub9ac \ubcf4\uc99d\uc218\ud45c\uac00 \ub418\ub294 \uc5d0\uc774\uc2a4",
                "A": "\ud544\uc694\ud55c \uc21c\uac04\ub9c8\ub2e4 \uc801\uadf9\uc801\uc73c\ub85c \uacf5\uc911\ubcfc\uc744 \ub2e4\ud22c\uba70 \ud300\uc5d0 \uc81c\uacf5\uad8c \uc6b0\uc704\ub97c \uc548\uaca8\uc8fc\ub294 \uc790\uc6d0",
                "B": "\ubab8\uc744 \uc544\ub07c\uc9c0 \uc54a\uace0 \uacf5\uc911\ubcfc\uc5d0 \ub6f0\uc5b4\ub4e4\uba70 \uad82\uc740\uc77c\uc744 \ud574\ub0b4\ub294 \uc131\uc2e4\ud55c \ud0c0\uac9f\ud615",
                "C": "\uc5f4\uc2ec\ud788 \uacbd\ud569\uc5d0 \uac00\ub2f4\ud558\uc9c0\ub9cc \uc0c1\ub300 \uc218\ube44\uc758 \uacac\uc81c\uc5d0 \ubc00\ub824 \ud074\ub9b0 \uce90\uce58\uac00 \uc548 \ub418\ub294 \uc720\ud615",
                "D": "\ud0a4\ub97c \ud65c\uc6a9\ud558\uc9c0 \ubabb\ud558\uace0 \uacf5\uc911\ubcfc \ub2e4\ud23c\ub9c8\ub2e4 \ubb34\uae30\ub825\ud558\uac8c \ubc00\ub824\ub098\ub294 \uacf5\uac08\ud3ec"
            },
            "B": {
                "S": "\ub9ce\uc774 \ub6f0\uc9c4 \uc54a\uc9c0\ub9cc \uc644\ubcbd\ud55c \ud0c0\uc810\uacfc \uccb4\uacf5 \uc2dc\uac04\uc73c\ub85c \ud575\uc2ec \uacf5\uc911\ubcfc\uc740 \ubb34\uc870\uac74 \ub530\ub0b4\ub294 \uad6d\ubc25\ud615",
                "A": "\ud544\uc694\ud560 \ub54c \uacf5\uc911\ubcfc\uc744 \ud655\uc2e4\ud788 \ub530\ub0b4\uc5b4 \ub3d9\ub8cc\uc5d0\uac8c \ub5a8\uad88\uc8fc\ub294 \uc54c\uc9dc\ubc30\uae30 \uc5f0\uacc4\ub7ec",
                "B": "\uacf5\uc911\ubcfc \uacbd\ud569 \uc0c1\ud669\uc5d0\uc11c 1\uc778\ubd84\uc740 \uac70\ub72c\ud788 \ubc84\ud168\uc8fc\ub294 \uc2a4\ud0e0\ub2e4\ub4dc \ud3ec\uc6cc\ub4dc",
                "C": "\uc560\ub9e4\ud55c \uc704\uce58 \uc120\uc815\uc73c\ub85c \uacf5\uc911\ubcfc \ub2e4\ud23c\uc5d0\uc11c \ubc88\ubc88\uc774 \ud310\uc815\ud328\ub97c \ub2f9\ud558\ub294 \uc790\uc6d0",
                "D": "\uacf5\ub9cc \ub728\uba74 \uacf5\uc911\ubcfc \ud0c0\uc774\ubc0d\uc744 \uc804\ud600 \uc7a1\uc9c0 \ubabb\ud558\uace0 \ud5c8\uacf5\ub9cc \ud718\uc813\ub294 \uc120\uc218"
            },
            "C": {
                "S": "\uacbd\ud569\uc744 \uc798 \uc548 \ud558\uc9c0\ub9cc \ubcf8\uc778\uc5d0\uac8c \uc624\ub294 \ud06c\ub85c\uc2a4\ub294 \uc808\ub300 \ub193\uce58\uc9c0 \uc54a\ub294 \ud5e4\ub529 \uc7a5\uc778",
                "A": "\uc2dc\ub3c4 \uc790\uccb4\ub294 \uc801\uc5b4\ub3c4 \ud655\uc2e4\ud55c \ucc2c\uc2a4\uc5d0\uc11c \ud0c0\uc810\uc744 \uc7a1\uc544 \uace8\ub85c \uc5f0\uacb0\ud558\ub294 \ud53c\ub2c8\uc154",
                "B": "\uc81c\uacf5\uad8c \uc2f8\uc6c0\uc744 \uc801\uadf9\uc801\uc73c\ub85c \ud53c\ud558\uba70 \ubc1c\ubc11 \uc704\uc8fc\uc758 \ud50c\ub808\uc774\ub97c \ub3c4\ubaa8\ud558\ub294 \uc2a4\ud0c0\uc77c",
                "C": "\uacf5\uc911\ubcfc \ub2e4\ud23c\uc744 \uc740\uadfc\ud788 \uae30\ud53c\ud558\uc5ec \uc0c1\ub300 \uc13c\ud130\ubc31\uc5d0\uac8c \ud3b8\uc548\ud55c \uc218\ube44\ub97c \ud5c8\uc6a9\ud558\ub294 \uc8fc\ubc94",
                "D": "\uacf5\uc911\ubcfc\uc774 \uc624\uba74 \uba38\ub9ac\ubd80\ud130 \uc6c0\uce20\ub7ec\ub4e4\uace0 \uc218\ube44\uc218 \ub4a4\ub85c \uc228\uc5b4\ubc84\ub9ac\ub294 \ucac4\ubcf4\ud615 \ud3ec\uc6cc\ub4dc"
            },
            "D": {
                "S": "\uacf5\uc911\ubcfc \uacbd\ud569\uc774 0\uc5d0 \uc218\ub834\ud558\uc9c0\ub9cc \uc9c0\uc0c1 \uc2a4\ud53c\ub4dc\ub85c \ubaa8\ub4e0 \uac78 \uc555\uc0b4\ud558\ub294 \uc9c0\uc0c1\uacc4 \ud2b9\uae09",
                "A": "\uc81c\uacf5\uad8c\uc744 \ud3ec\uae30\ud55c \ub300\uc2e0 \ucca0\uc800\ud55c \ub85c\ube59 \ud328\uc2a4\uc640 \uce68\ud22c\ub85c\ub9cc \uc2b9\ubd80\ud558\ub294 \ubcc0\uce59\ud615 \uacf5\uaca9\uc218",
                "B": "\ud0a4\uac00 \uc544\uae4c\uc6b8 \uc815\ub3c4\ub85c \ud5e4\ub529 \uacbd\ud569\uc5d0 \uc544\uc608 \uac00\ub2f4\ud558\uc9c0 \uc54a\uc544 \uc804\uc220\uc801 \ub2e4\uc591\uc131\uc744 \uae4e\uc544\uba39\ub294 \uc790\uc6d0",
                "C": "\uacf5\uc911\ubcfc \uc0c1\ud669\uc5d0\uc11c \ud30c\uc6b8\ub9cc \ubc94\ud558\uac70\ub098 \uc644\uc804\ud788 \uc9c0\uc6cc\uc838 \ud300\uc5d0 \ub3c4\uc6c0\uc774 \uc548 \ub418\ub294 \uc120\uc218",
                "D": "\uadf8\ub77c\uc6b4\ub4dc\uc5d0 \ub099\uc5fd\ub9cc \ub5a8\uc5b4\uc838\ub3c4 \uba38\ub9ac\ub97c \uac10\uc2f8\uc950\uba70 \uacf5\uc911\ubcfc\uc744 \ucca0\uc800\ud788 \ud68c\ud53c\ud558\ub294 \ucd5c\uc57d\uccb4"
            }
        },
    },
    "ground": {
        "title": "\U0001faa8 \uc9c0\uc0c1 \uacbd\ud569",
        "volume": "ground_duel_attempts_volume_top_percent",
        "ratio": "duel_margin_per90_top_percent",
        "rows": {
            "S": {
                "S": "\ubaa8\ub4e0 \uc9c4\ud759\ud0d5 \uc2f8\uc6c0\uc744 \uc774\uaca8\ub0b4\uba70 \uc0c1\ub300\ub97c \ubb3c\ub9ac\uc801\uc73c\ub85c \uac08\uc544\ubc84\ub9ac\ub294 \ubbf8\uce5c \ud22c\uacac",
                "A": "\ub04a\uc784\uc5c6\ub294 \ubab8\uc2f8\uc6c0\uacfc \ud3ec\uc2a4\ud2b8 \ud50c\ub808\uc774\ub85c \uc218\ube44\uc9c4\uc744 \uc9c0\uce58\uac8c \ub9cc\ub4dc\ub294 \uc778\uac04 \uc804\ucc28",
                "B": "\ub54c\ub85c\ub294 \ubc00\ub9ac\uae30\ub3c4 \ud558\uc9c0\ub9cc, \ud22c\uc9c0 \ud558\ub098\ub85c \ubab8\uc744 \ubd80\ub52a\uce58\uba70 \uad82\uc740\uc77c\uc744 \ub3c4\ub9e1\ub294 \uc5b8\uc131 \ud788\uc5b4\ub85c",
                "C": "\uc4f8\ub370\uc5c6\uc774 \ubd80\ub52a\ud788\uae30\ub9cc \ud558\uace0 \uc8c4\ub2e4 \ub098\ub4b9\uad6c\ub974\uba70 \ud15c\ud3ec\ub97c \ub04a\uc5b4\uba39\ub294 \ud30c\uc6b8 \ucf5c\ub809\ud130",
                "D": "\uc628\uac16 \uacf3\uc5d0 \ub2e4 \ub4e4\uc774\ubc1b\uc9c0\ub9cc \ud53c\uc9c0\uceec\uc774 \ub208 \uc369\ub294 \uc218\uc900\uc774\ub77c \ud295\uaca8\ub098\uac00\ub294 \uadf8\ub77c\uc6b4\ub4dc\uc758 \uc885\uc774\uc778\ud615"
            },
            "A": {
                "S": "\uac70\uce5c \uacbd\ud569\uc744 \ub9c8\ub2e4\ud558\uc9c0 \uc54a\uc73c\uba74\uc11c\ub3c4 \uc601\ub9ac\ud558\uac8c \ubcfc \uc18c\uc720\uad8c\uc744 \uc9c0\ucf1c\ub0b4\ub294 \ucf54\uc5b4 \uad34\ubb3c",
                "A": "\uc804\ubc29\uc5d0\uc11c \ub04a\uc784\uc5c6\uc774 \uc218\ube44\uc218\uc640 \ubd80\ub52a\ud788\uba70 \uacf5\uac04\uc744 \uc950\uc5b4\uc9dc\ub0b4\ub294 \uc804\ud22c\ud615 \ud3ec\uc6cc\ub4dc",
                "B": "\ubab8\uc2f8\uc6c0\uc5d0 \uc801\uadf9\uc801\uc73c\ub85c \uac00\ub2f4\ud558\uba70 \ud300\uc758 \uc804\ubc29 \uc555\ubc15\uc744 \uc131\uc2e4\ud788 \uc218\ud589\ud558\ub294 \ud558\ub4dc\uc6cc\ucee4",
                "C": "\uc5f4\uc2ec\ud788 \ubab8\uc744 \ub0a0\ub9ac\uc9c0\ub9cc \uc0c1\ub300\uc758 \uac70\uce5c \uc218\ube44 \ub178\ub828\ubbf8\uc5d0 \ub2f9\ud574 \ud134\uc624\ubc84\ub97c \uc790\uc8fc \ud5c8\uc6a9\ud558\ub294 \uc720\ud615",
                "D": "\ubb34\uc791\uc815 \ubd80\ub52a\ud788\uae30\ub9cc \ud558\ub2e4 \ud30c\uc6b8\uc744 \ub0b4\uc8fc\uac70\ub098 \uc5ed\uc73c\ub85c \ud295\uaca8\ub098\uac00 \ud300\uc758 \ud750\ub984\uc744 \ub04a\ub294 \uc790\uc6d0"
            },
            "B": {
                "S": "\ubb34\ub9ac\ud55c \ubab8\uc2f8\uc6c0 \ub300\uc2e0 \uc601\ub9ac\ud55c \ubc38\ub7f0\uc2a4\ub85c \ubcfc\uc744 \uc644\ubcbd\ud788 \uc9c0\ucf1c\ub0b4\ub294 \uc9c0\ub2a5\ud615 \ud0f1\ucee4",
                "A": "\uc555\ubc15 \uc18d\uc5d0\uc11c\ub3c4 \ubb35\ubb35\ud788 \ub4f1\uc744 \uc9c0\uace0 \ub3d9\ub8cc\uc5d0\uac8c \uae38\uc744 \uc5f4\uc5b4\uc8fc\ub294 \ub4e0\ub4e0\ud55c \ub4f1\ub300",
                "B": "\uc0c1\ud669\uc5d0 \ub9de\uac8c \uc801\ub2f9\ud788 \ube44\ubcbc\uc8fc\uace0 \ube60\uc9c8 \uc904 \uc544\ub294 \uc694\ub839 \uc88b\uc740 \uacf5\uaca9\uc218",
                "C": "\ubab8\uc2f8\uc6c0\uc744 \ubc84\ud168\ub0bc \ucf54\uc5b4 \ud798\uc774 \ubd80\uc871\ud574 \ub4f1\uc9c0\ub294 \ud50c\ub808\uc774\uac00 \ubc84\uac70\uc6b4 \ud5c8\uc57d \uccb4\uc9c8",
                "D": "\uc218\ube44\uc218\uc640 \uc637\uae43\ub9cc \uc2a4\uccd0\ub3c4 \ud53d\ud53d \uc4f0\ub7ec\uc838 \uc2ec\ud310\uc5d0\uac8c \ud30c\uc6b8\ub9cc \uad6c\uac78\ud558\ub294 \ub2e4\uc774\ube59 \uc7a5\uc778"
            },
            "C": {
                "S": "\uacbd\ud569\uc744 \ud53c\ud558\uba74\uc11c\ub3c4 \ucc9c\uc7ac\uc801\uc778 \uc6d0\ud130\uce58\ub85c \uc0c1\ub300\ub97c \ubc14\ubcf4\ub85c \ub9cc\ub4dc\ub294 \ud14c\ud06c\ub2c8\uc158",
                "A": "\uc0c1\ub300\uc640\uc758 \ubb3c\ub9ac\uc801 \ub9c8\ucc30\uc744 \uc601\ub9ac\ud558\uac8c \ud53c\ud558\uba70 \ube48 \uacf5\uac04\uc73c\ub85c \ube60\uc838\ub098\uac00\ub294 \ubc40\uc7a5\uc5b4",
                "B": "\ubab8\uc2f8\uc6c0\uc740 \ud53c\ud558\uc9c0\ub9cc \ud2b9\uc720\uc758 \ubbfc\ucca9\uc131\uc73c\ub85c \uc5b4\ub5bb\uac8c\ub4e0 \uacf5\uc740 \uc0b4\ub824\ub0b4\ub294 \uc58c\uccb4",
                "C": "\uacbd\ud569\uc744 \ud53c\ud574 \ubc14\uae65\uc73c\ub85c\ub9cc \ub3cc\ub2e4 \ubcf4\ub2c8 \uc2e4\uc9c8\uc801\uc778 \uacf5\uaca9 \uad00\uc5ec\ub3c4\uac00 \ub5a8\uc5b4\uc9c0\ub294 \uc790\uc6d0",
                "D": "\uce58\uc5f4\ud55c \ubcfc \ub2e4\ud23c \uc0c1\ud669\uc5d0\uc11c \ubc1c\uc744 \ube7c\uba70 \ub3d9\ub8cc\uc5d0\uac8c \uc704\ud5d8\uc744 \ub5a0\ub118\uae30\ub294 \uc18c\uc2ec\uc774"
            },
            "D": {
                "S": "\uc2e0\uccb4 \uc811\ucd09\uc744 \uc544\uc608 \uc548 \ub2f9\ud558\uba74\uc11c\ub3c4 \ucd95\uad6c \ub3c4\uc0ac\uae09 \uc13c\uc2a4\ub85c \ud0c8\uc555\ubc15\ud558\ub294 \ub3c4\uc0ac",
                "A": "\ubab8\uc2f8\uc6c0\uc744 \ucca0\uc800\ud788 \ubc30\uc81c\ud558\uace0 \uc644\ubcbd\ud55c \ube48\uacf5\uac04\ub9cc \ucc3e\uc544\ub2e4\ub2c8\ub294 \uc720\ub839\ud615 \uc2a4\ud2b8\ub77c\uc774\ucee4",
                "B": "\uc9c0\uc0c1 \uacbd\ud569 \uc2b9\ub960\uc740 \ub458\uc9f8\uce58\uace0 \ubd80\ub52a\ud788\ub294 \uac83 \uc790\uccb4\ub97c \uadf9\ub3c4\ub85c \uc2eb\uc5b4\ud558\ub294 \uc628\uc2e4 \uc18d \ud654\ucd08",
                "C": "\uac70\uce5c \uc218\ube44 \ub9c8\ud06c\uac00 \ubd99\uc73c\uba74 \uc815\uc2e0\uc744 \ubabb \ucc28\ub9ac\uace0 \uc644\uc804\ud788 \uc9c0\uc6cc\uc9c0\ub294 \uc720\ub9ac\ubab8",
                "D": "\uc9c4\ud759 \ubb3b\ud788\uae30\ub97c \uadf9\ub3c4\ub85c \ud610\uc624\ud558\uc5ec \uc0c1\ub300 \uc218\ube44 \ubc18\uacbd\uc5d4 \uc5bc\uc52c\ub3c4 \uc548 \ud558\ub294 \ucd5c\uc545\uc758 \ucac4\ubcf4"
            }
        },
    },
    "space_control": {
        "title": "\U0001f9e0 \uacf5\uac04 \uc7a5\uc545\ub825",
        "volume": "cca_area_top_percent",
        "ratio": "danger_zone_density_top_percent",
        "rows": {
            "S": {
                "S": "\ubbf8\uce5c \uc624\ud504\ub354\ubcfc\ub85c \ubaa8\ub4e0 \ub4dd\uc810 \uae30\ud68c\uc758 \uc911\uc2ec\uc5d0 \uc11c\uba70 \ud300 \uc804\uc220\uc744 \uc644\uc131\ud558\ub294 \ucf54\uc5b4",
                "A": "\ub6f0\uc5b4\ub09c \uacf5\uac04 \uc774\ud574\ub3c4\ub85c \ub04a\uc784\uc5c6\uc774 \ucc2c\uc2a4\ub97c \ucc3d\ucd9c\ud558\uace0 \ud30c\uace0\ub4dc\ub294 \uacf5\uac04\uc758 \ub9c8\uc220\uc0ac",
                "B": "\ud22c\ubc15\ud558\uc9c0\ub9cc \uc274 \uc0c8 \uc5c6\uc774 \uacf5\uac04\uc73c\ub85c \uce68\ud22c\ud558\uba70 \uc5b4\ub5bb\uac8c\ub4e0 \uade0\uc5f4\uc744 \ub9cc\ub4dc\ub294 \ud558\ub4dc\uc6cc\ucee4",
                "C": "\uc624\uc9c0\ub796 \ub113\uac8c \uc5ec\uae30\uc800\uae30 \ub07c\uc5b4\ub4e4\uc9c0\ub9cc \uc815\uc791 \uacf5\uaca9\uc758 \ub9e5\uc744 \ub2e4 \ub04a\uc5b4\uba39\ub294 \ub9c8\uc774\ub108\uc2a4\uc758 \uc190",
                "D": "\ubcfc\uc774 \uac00\ub294 \uae38\ubaa9\ub9c8\ub2e4 \uae38\uc744 \ub9c9\uace0 \uc11c\uc11c \ub3d9\ub8cc\uc758 \ucc2c\uc2a4\ub9c8\uc800 \ubc29\ud574\ud558\ub294 X\ub9e8"
            },
            "A": {
                "S": "\uacbd\uae30 \ub0b4\ub0b4 \uc601\ub9ac\ud558\uac8c \uc6c0\uc9c1\uc774\uba70 \uac00\uc7a5 \uacb0\uc815\uc801\uc778 \uacf5\uac04\uc744 \uc801\uc2dc\uc5d0 \ud0c0\uaca9\ud558\ub294 \uc804\uc220\uac00",
                "A": "\ud65c\ubc1c\ud55c \uce68\ud22c\ub85c \uc218\ube44 \ub77c\uc778\uc744 \ud754\ub4e4\uba70 \ub3d9\ub8cc\uc5d0\uac8c\ub3c4 \ud30c\uc0dd \uacf5\uac04\uc744 \uc5f4\uc5b4\uc8fc\ub294 \uc790\uc6d0",
                "B": "\uc131\uc2e4\ud558\uac8c \ube48 \uacf5\uac04\uc744 \ucc3e\uc544 \ub4e4\uc5b4\uac00\uba70 \ud300\uc758 \uacf5\uaca9 \uc21c\ud658\uc744 \ub3d5\ub294 \uc54c\uc9dc\ubc30\uae30",
                "C": "\ub9ce\uc774 \ub6f0\uae34 \ud558\ub294\ub370 \ud0c0\uc774\ubc0d\uc774 \ud55c \ubc15\uc2a4\uc529 \uc5b4\uae0b\ub098 \ub4dd\uc810\uc73c\ub85c \uc798 \uc5f0\uacb0\ub418\uc9c0 \uc54a\ub294 \uc720\ud615",
                "D": "\uc624\ud504\uc0ac\uc774\ub4dc \ub77c\uc778\uc744 \uc804\ud600 \ubabb \ub9de\ucd94\uac70\ub098 \ub3d9\ub8cc\uc758 \ud328\uc2a4 \uae38\uc744 \ub9c9\uc544\uc11c\ub294 \ub2f5\ub2f5\ud55c \uc6c0\uc9c1\uc784"
            },
            "B": {
                "S": "\uaf2d \ud544\uc694\ud55c \uc21c\uac04\uc5d0\ub9cc \ub098\ud0c0\ub098 \uac00\uc7a5 \uce58\uba85\uc801\uc778 \uacf5\uac04\uc744 \uc810\uc720\ud558\ub294 \uc624\ud504\ub354\ubcfc \ub9c8\uc2a4\ud130",
                "A": "\ud328\uc2a4 \uae38\uc744 \uc815\ud655\ud788 \uc77d\uace0 \ud6cc\ub96d\ud55c \ud0c0\uc774\ubc0d\uc5d0 \ucef7\ubc31\uc744 \ubc1b\uc544\uba39\ub294 \uc9c0\ub2a5\ud615 \ud0c0\uac9f",
                "B": "\uae30\ubcf8\uc801\uc778 \uc804\uc220\uc801 \uc6c0\uc9c1\uc784\uc740 \uc131\uc2e4\ud788 \uc218\ud589\ud558\uba70 1\uc778\ubd84 \uae30\ud68c\ub294 \uc5ff\ubcf4\ub294 \uc2a4\ud0e0\ub2e4\ub4dc \uc790\uc6d0",
                "C": "\ub6f0\ub294 \uc704\uce58\ub098 \ud0c0\uc774\ubc0d\uc774 \uc560\ub9e4\ud574 \uacf5\uaca9 \ud15c\ud3ec\ub97c \uc0b4\ub9ac\uc9c0 \ubabb\ud558\ub294 \ud3c9\uc774\ud55c \uc218\uc900",
                "D": "\uc6c0\uc9c1\uc784\uc774 \ub108\ubb34 \ub2e8\uc870\ub85c\uc6cc \uc0c1\ub300 \uc218\ube44\uc218\uc5d0\uac8c \uc644\uc804\ud788 \uc77d\ud788\ub294 \uc790\uc6d0"
            },
            "C": {
                "S": "\uac00\ub9cc\ud788 \uc11c \uc788\ub2e4\uac00\ub3c4 \uacb0\uc815\uc801\uc778 \uc21c\uac04 \ud55c \ubc88\uc758 \uce68\ud22c\ub85c \uace8\uc744 \ubf51\uc544\ub0b4\ub294 \uace0\uc2a4\ud2b8",
                "A": "\uc6c0\uc9c1\uc784\uc740 \uc801\uc9c0\ub9cc \uacf5\uc774 \uc62c \uc790\ub9ac\ub97c \uae30\uac00 \ub9c9\ud788\uac8c \ucc3e\uc544\ub0b4\ub294 \ub291\ub300\ud615",
                "B": "\ud65c\ub3d9\ub7c9\uc774 \uc544\uc27d\uc9c0\ub9cc \uc815\uc801\uc778 \uc704\uce58\uc5d0\uc11c \uacf5\uc744 \ubc1b\uc544 \uc5f0\uacb0\ud574 \uc8fc\ub294 \ud0c0\uac9f\ud615 \uc2a4\ud0c0\uc77c",
                "C": "\uacf5\uac04\uc744 \uc2a4\uc2a4\ub85c \ucc3e\uc544\uac00\uc9c0 \ubabb\ud558\uace0 \ub3d9\ub8cc\uac00 \ub5a0\uba39\uc5ec \uc8fc\uae30\ub9cc \uae30\ub2e4\ub9ac\ub294 \uc218\ub3d9\uc801 \uc790\uc6d0",
                "D": "\uc6c0\uc9c1\uc784\uc774 \uac70\uc758 \uc5c6\uc5b4 \ud300\uc758 \uacf5\uaca9 \uc804\uac1c\uc5d0 \uc544\ubb34\ub7f0 \ubcf4\ud0ec\uc774 \uc548 \ub418\ub294 \uc815\uccb4\ub41c \uc120\uc218"
            },
            "D": {
                "S": "\uc6c0\uc9c1\uc784\uc740 \ucd5c\uc545\uc778\ub370 \uac00\ub054 \uc8fc\uc6cc \uba39\uae30\ub85c \uc2a4\ud0ef \uc138\ud0c1\ud558\ub294 \uae30\uc801\uc758 \uc740\ub454\ud615",
                "A": "\uc774\ub3d9 \ubc94\uc704\uac00 \uadf9\ub3c4\ub85c \uc81c\ud55c\ub418\uc5b4 \uc788\uc5b4 \uc0c1\ub300 \uc218\ube44\uc218\uac00 \ub9c8\ud06c\ud558\uae30 \ub108\ubb34 \ud3b8\ud55c \uc120\uc218",
                "B": "\uacf5\uac04 \ucc3d\ucd9c \ub2a5\ub825\uc774 \uc644\uc804\ud788 \uc0c1\uc2e4\ub418\uc5b4 \uc804\ubc29\uc5d0\uc11c \uc9d0\uc9dd\ucc98\ub7fc \uc11c \uc788\ub294 \uc790\uc6d0",
                "C": "\uc790\uc2e0\uc774 \uc5b4\ub514\ub85c \ub6f0\uc5b4\uc57c \ud560\uc9c0 \uac08\ud53c\ub97c \ubabb \uc7a1\uace0 \uba4d\ud558\ub2c8 \uc11c \uc788\ub294 \uadf8\ub77c\uc6b4\ub4dc\uc758 \ubbf8\uc544",
                "D": "\uacbd\uae30\uc5d0 \uc804\ud600 \uac1c\uc785\ud558\uc9c0 \ubabb\ud558\uace0 90\ubd84 \ub0b4\ub0b4 \uc0c1\ub300 \uc218\ube44 \ub4a4\uc5d0 \uc228\uc5b4 \uc0b0\ucc45\ud558\ub294 \ud22c\uba85\uc778\uac04"
            }
        },
    },
}

SPEAR_FACTOR_DETAILS = {
    "spear_shot_quality_top_percent": ("shot_quality_per90", "spear_shot_quality_rank", "progression_eligible"),
    "out_box_shot_quality_top_percent": ("out_box_shot_quality", "out_box_shot_quality_rank", "progression_eligible"),
    "micro_zoning_finishing_top_percent": ("tactical:deep_box_zone_score", "micro_zoning_finishing_rank", "progression_eligible"),
    "danger_zone_progression_top_percent": ("tactical:danger_zone_density", "danger_zone_progression_rank", "progression_eligible"),
    "aerial_margin_per90_top_percent": ("aerial_margin_per90", "aerial_margin_per90_rank", "progression_eligible"),
    "duel_margin_per90_top_percent": ("duel_margin_per90", "duel_margin_per90_rank", "progression_eligible"),
    "cca_area_top_percent": ("tactical:cca_area_pct", "cca_area_rank", "progression_eligible"),
    "danger_zone_density_top_percent": ("tactical:danger_zone_density", "danger_zone_density_rank", "progression_eligible"),
}


def _spear_tier(score: float) -> str:
    if score >= 95:
        return "S"
    if score >= 85:
        return "A"
    if score >= 65:
        return "B"
    if score >= 35:
        return "C"
    return "D"


def comparison_population_label(league_id: int | None, scope: int) -> str:
    if league_id == EUROPEAN_LEADERBOARD_ID:
        return "유럽대항전 통합(UCL·UEL·UECL) 기준"
    cup_names = {42: "챔피언스리그", 73: "유로파리그", 108: "컨퍼런스리그"}
    if league_id in cup_names:
        return f"{cup_names[league_id]} 기준"
    return f"{scope}대 리그 기준" if scope in (3, 5, 7) else "동일 대회 기준"


def comparison_population_criteria(league_id: int | None, season: str, scope: int) -> str:
    """Make the ranking cohort explicit beside every M.E.S.S.I. rank."""
    is_european = league_id == EUROPEAN_LEADERBOARD_ID or league_id in {42, 73, 108}
    minimum_minutes = 180 if is_european else 450
    minimum_xg = 1.0 if is_european else 2.0
    return (
        f"기준: {season} 시즌 · {comparison_population_label(league_id, scope)} · "
        f"최소 {minimum_minutes}분 · xG {minimum_xg:.1f} 이상"
    )


def _spear_total(rank) -> tuple[float | None, str | None, int]:
    """Return the visible M.E.S.S.I. total from the actually bound radar axes.

    Missing axes are not silently converted to 50 here: a score is only shown
    when at least one real percentile is available, and the coverage count is
    retained for an honest UI caption.
    """
    if rank is None:
        return None, None, 0
    if getattr(rank, "spear_score", None) is not None:
        score = float(rank.spear_score)
        imputed = set(_imputed_axis_attrs(rank, volume=True)) | set(_imputed_axis_attrs(rank, volume=False))
        covered_axes = sum(
            1
            for sector in TWIN_SECTOR_MATRIX.values()
            if sector["volume"] not in imputed and sector["ratio"] not in imputed
        )
        return score, _spear_tier(score), covered_axes
    values = [
        _radar_score(getattr(rank, attr))
        for _, attr in SPEAR_FACTOR_AXES
        if getattr(rank, attr, None) is not None
    ]
    if not values:
        return None, None, 0
    score = round(sum(values) / len(values), 1)
    return score, _spear_tier(score), len(values)


def twin_radar_sector_summaries(rank) -> list[tuple[str, str]]:
    """Resolve all six Volume × Ratio 5×5 descriptions for the player."""
    summaries = []
    for sector_id, sector in TWIN_SECTOR_MATRIX.items():
        volume_percent = getattr(rank, sector["volume"], None) if rank else None
        ratio_percent = getattr(rank, sector["ratio"], None) if rank else None
        volume_score, volume_imputed = _axis_score(rank, sector["volume"], volume=True)
        ratio_score, ratio_imputed = _axis_score(rank, sector["ratio"], volume=False)
        if volume_imputed or ratio_imputed:
            missing_part = "볼륨·비율" if volume_imputed and ratio_imputed else "볼륨" if volume_imputed else "비율"
            summaries.append((
                sector["title"],
                f"[보수적 D 보정] {missing_part} 원천 데이터 부족 — 20점(D)으로 총점·등수에 반영",
            ))
            continue
        if volume_percent is None or ratio_percent is None:
            summaries.append((sector["title"], "[자료 부족] Insufficient Data"))
            continue
        volume_tier = _spear_tier(volume_score)
        ratio_tier = _spear_tier(ratio_score)
        text = sector["rows"][volume_tier][ratio_tier]
        summaries.append((sector["title"], f"[{volume_tier}×{ratio_tier}] {text}"))
    return summaries


def twin_matrix_coordinates(rank) -> tuple[tuple[str, str] | None, ...]:
    """Return the six 5×5 coordinates used by the displayed card dictionary."""
    if rank is None:
        return tuple()
    coordinates = []
    for sector in TWIN_SECTOR_MATRIX.values():
        volume_percent = getattr(rank, sector["volume"], None)
        ratio_percent = getattr(rank, sector["ratio"], None)
        volume_score, volume_imputed = _axis_score(rank, sector["volume"], volume=True)
        ratio_score, ratio_imputed = _axis_score(rank, sector["ratio"], volume=False)
        if volume_imputed or ratio_imputed:
            coordinates.append((
                _spear_tier(volume_score),
                _spear_tier(ratio_score),
            ))
        elif volume_percent is None or ratio_percent is None:
            coordinates.append(None)
        else:
            coordinates.append((
                _spear_tier(volume_score),
                _spear_tier(ratio_score),
            ))
    return tuple(coordinates)


def render_twin_radar_sector_summaries(rank) -> None:
    """Display all six cross-matrix outcomes as an ordered 3×2 card grid."""
    summaries = twin_radar_sector_summaries(rank)
    st.markdown("#### 💡 볼륨 × 비율 교차 프로필")
    st.markdown(
        """
        <style>
        .spear-sector-card {
            min-height: 148px;
            padding: 0.9rem 1rem;
            margin: 0 0 0.8rem 0;
            border: 1px solid rgba(148, 163, 184, 0.32);
            border-radius: 0.7rem;
            background: rgba(30, 41, 59, 0.32);
        }
        .spear-sector-card__header {
            display: flex;
            align-items: center;
            justify-content: space-between;
            gap: 0.5rem;
            margin-bottom: 0.65rem;
            font-weight: 700;
        }
        .spear-tier-badge {
            padding: 0.13rem 0.48rem;
            border-radius: 999px;
            font-size: 0.78rem;
            font-weight: 800;
            letter-spacing: 0.02em;
        }
        .spear-tier--elite { color: #052e16; background: #4ade80; }
        .spear-tier--strong { color: #431407; background: #fb923c; }
        .spear-tier--neutral { color: #172554; background: #93c5fd; }
        .spear-tier--warning { color: #451a03; background: #facc15; }
        .spear-tier--danger { color: #fef2f2; background: #dc2626; }
        .spear-sector-card__body { color: inherit; line-height: 1.55; font-size: 0.91rem; }
        </style>
        """,
        unsafe_allow_html=True,
    )
    columns = st.columns(3)
    for index, (title, text) in enumerate(summaries):
        badge, body = text.split("] ", 1)
        tiers = badge.removeprefix("[").split("×")
        # A single D makes the cross-profile critical; otherwise favor the
        # best displayed tier so exceptional combinations scan immediately.
        if "보수적 D" in badge:
            tone = "danger"
        elif "자료 부족" in badge:
            tone = "warning"
        elif "D" in tiers:
            tone = "danger"
        elif "S" in tiers:
            tone = "elite"
        elif "A" in tiers:
            tone = "strong"
        elif "B" in tiers:
            tone = "neutral"
        else:
            tone = "warning"
        card = (
            '<div class="spear-sector-card">'
            '<div class="spear-sector-card__header">'
            f'<span>{html.escape(title)}</span>'
            f'<span class="spear-tier-badge spear-tier--{tone}">{html.escape(badge + "]")}</span>'
            '</div>'
            f'<div class="spear-sector-card__body">{html.escape(body)}</div>'
            '</div>'
        )
        with columns[index % 3]:
            st.markdown(card, unsafe_allow_html=True)


def render_spear_radar(
    player_name: str, rank, stats: DecisionMetrics | None, *, volume: bool,
    tactical_ratio: dict[str, object] | None = None, comparison_label: str = "동일 대회 기준",
    chart_key: str | None = None,
) -> None:
    """Render one of the synchronized volume/ratio M.E.S.S.I. radars."""
    axes = VOLUME_FACTOR_AXES if volume else SPEAR_FACTOR_AXES
    details = []
    labels = []
    values = []
    for axis in axes:
        if volume:
            label, percentile_attr, raw_attr, rank_attr = axis
            total_attr = "spear_volume_eligible"
        else:
            label, percentile_attr = axis
            raw_attr, rank_attr, total_attr = SPEAR_FACTOR_DETAILS[percentile_attr]
        top_percent = getattr(rank, percentile_attr, None) if rank else None
        score, imputed = _axis_score(rank, percentile_attr, volume=volume)
        tier = _spear_tier(score)
        labels.append(f"{label} [{tier}]")
        values.append(score)
        raw_value = (
            tactical_ratio.get(raw_attr.removeprefix("tactical:"))
            if raw_attr.startswith("tactical:") and tactical_ratio
            else getattr(stats, raw_attr, None) if stats else None
        )
        rank_value = getattr(rank, rank_attr, None) if rank else None
        total = getattr(rank, total_attr, None) if rank else None
        details.append([
            "—" if raw_value is None else f"{float(raw_value):.2f}",
            "보수적 D 보정" if imputed else f"{tier} 등급",
            "원천 데이터 부족 · 20점 반영" if imputed else "데이터 부족" if top_percent is None else f"상위 {float(top_percent):.1f}%",
            "순위 데이터 부족" if rank_value is None or not total else f"{rank_value}위 / {total}명",
        ])

    figure = go.Figure()
    for name, trace_values, color, fill in (
        (player_name, values, "#22C55E", "rgba(34,197,94,0.28)"),
        (f"{comparison_label} 평균", [50.0] * len(labels), "#94A3B8", "rgba(148,163,184,0.16)"),
    ):
        is_player = name == player_name
        figure.add_trace(go.Scatterpolar(
            r=trace_values + [trace_values[0]], theta=labels + [labels[0]],
            mode="lines+markers", name=name, fill="toself", fillcolor=fill,
            line={"color": color, "width": 2}, marker={"color": color, "size": 6},
            customdata=(details + [details[0]]) if is_player else None,
            hovertemplate=(
                "<b>%{theta}</b><br>원시값: %{customdata[0]}<br>%{customdata[1]} · %{customdata[2]} · %{customdata[3]}<br>레이더 점수: %{r:.1f}<extra></extra>"
                if is_player else "%{theta}: 비교군 평균 %{r:.0f}<extra></extra>"
            ),
        ))
    heading = "볼륨(Volume)" if volume else "비율(Ratio)"
    figure.update_layout(
        title=f"M.E.S.S.I. {heading} 레이더 · {comparison_label}",
        height=455, margin={"l": 38, "r": 38, "t": 55, "b": 35},
        paper_bgcolor="rgba(0,0,0,0)",
        polar={
            "bgcolor": "rgba(0,0,0,0)",
            "radialaxis": {
                "range": [0, 100], "tickvals": [0, 25, 50, 75, 100], "visible": True,
                "gridcolor": "#64748B", "linecolor": "#94A3B8",
                "tickfont": {"color": "#CBD5E1"},
            },
            "angularaxis": {
                "rotation": 90, "direction": "clockwise",
                "gridcolor": "#64748B", "linecolor": "#94A3B8",
                "tickfont": {"color": "#F8FAFC", "size": 13},
            },
        },
        font={"color": "#F8FAFC"},
        legend={"orientation": "h", "y": -0.12, "x": 0.5, "xanchor": "center"},
    )
    st.plotly_chart(
        figure, use_container_width=True, config={"displayModeBar": False}, key=chart_key,
    )


def render_spear_head_to_head(left_name: str, left_rank, right_name: str, right_rank) -> None:
    """Overlay the two independent M.E.S.S.I. 2.0 ratio profiles."""
    labels = [label for label, _ in SPEAR_FACTOR_AXES]
    left_scores = [_radar_score(getattr(left_rank, attr, None)) for _, attr in SPEAR_FACTOR_AXES]
    right_scores = [_radar_score(getattr(right_rank, attr, None)) for _, attr in SPEAR_FACTOR_AXES]
    left_tiers = [_spear_tier(score) for score in left_scores]
    right_tiers = [_spear_tier(score) for score in right_scores]
    # Plotly treats theta strings as categorical positions.  The former code
    # embedded each player's own tier in that string, making identical axes
    # (for example "공중볼 [B]" vs "공중볼 [D]") separate categories and
    # rotating/distorting the opponent polygon.  Both traces must share one
    # identical theta sequence.
    shared_labels = [
        f"{label} [{left_tier}/{right_tier}]"
        for label, left_tier, right_tier in zip(labels, left_tiers, right_tiers)
    ]
    figure = go.Figure()
    for name, scores, tiers, color, fill in (
        (left_name, left_scores, left_tiers, "#38BDF8", "rgba(56,189,248,0.25)"),
        (right_name, right_scores, right_tiers, "#FB7185", "rgba(251,113,133,0.24)"),
    ):
        figure.add_trace(go.Scatterpolar(
            r=scores + [scores[0]], theta=shared_labels + [shared_labels[0]],
            mode="lines+markers", name=name, fill="toself", fillcolor=fill,
            line={"color": color, "width": 2.5}, marker={"color": color, "size": 6},
            customdata=tiers + [tiers[0]],
            hovertemplate="<b>%{theta}</b><br>%{fullData.name}: %{r:.1f}/100 · %{customdata}-Tier<extra></extra>",
        ))
    figure.update_layout(
        title="M.E.S.S.I. 2.0 Head-to-Head · 비율 프로필",
        height=500, margin={"l": 44, "r": 44, "t": 55, "b": 38},
        paper_bgcolor="rgba(0,0,0,0)",
        polar={
            "bgcolor": "rgba(0,0,0,0)",
            "radialaxis": {"range": [0, 100], "tickvals": [0, 25, 50, 75, 100]},
            "angularaxis": {"rotation": 90, "direction": "clockwise"},
        },
        legend={"orientation": "h", "y": -0.1, "x": 0.5, "xanchor": "center"},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})


def render_head_to_head_cards(
    left_name: str, left_rank, left_stats, left_ratio,
    right_name: str, right_rank, right_stats, right_ratio,
) -> None:
    """Show both players' six sector descriptions in a scannable 3x2 grid."""
    left_cards = dict(twin_radar_sector_summaries(left_rank))
    right_cards = dict(twin_radar_sector_summaries(right_rank))
    # Stable sector IDs are the H2H data contract.  UI titles change as the
    # product wording evolves, so using them as dictionary keys caused the
    # live KeyError after the twin-radar labels were updated.
    raw_fields = {
        "outside_box_shooting": ("out_box_shots", "out_box_shot_quality", "박스 밖 슈팅 시도", "박스 밖 xGOT-xG"),
        "deep_box_lethality": ("in_box_shots", "in_box_finishing", "박스 안 슈팅 시도", "박스 안 xGOT-xG"),
        "danger_zone_progression": ("dribble_attempts", "dribble_margin_per90", "돌파 시도", "드리블 마진/90"),
        "aerial": ("aerial_duel_attempts", "aerial_margin_per90", "공중볼 경합 시도", "공중볼 마진/90"),
        "ground": ("ground_duel_attempts", "duel_margin_per90", "지상 경합 시도", "지상 경합 마진/90"),
        "space_control": ("tactical:cca_area_pct", "tactical:danger_zone_density", "CCA", "위험 구역 밀도"),
    }

    def raw_fact(sector_id, stats, ratio):
        fields = raw_fields.get(sector_id)
        if fields is None:
            return "보조 원시 지표 매핑이 아직 준비되지 않았습니다."
        first, second, first_label, second_label = fields
        def value(field):
            if field.startswith("tactical:"):
                return (ratio or {}).get(field.removeprefix("tactical:"))
            return getattr(stats, field, None)
        one, two = value(first), value(second)
        fmt = lambda item: "—" if item is None else f"{float(item):.2f}"
        return f"원시값 · {first_label} {fmt(one)} / {second_label} {fmt(two)}"
    st.markdown("### 🧩 분야별 볼륨 × 비율 교차 프로필")
    st.caption("같은 분야에서 두 선수의 활동량과 효율 평가 문장을 나란히 비교합니다.")
    columns = st.columns(3)
    for index, (sector_id, sector) in enumerate(TWIN_SECTOR_MATRIX.items()):
        sector_title = sector["title"]
        left_text = left_cards.get(sector_title, "비교군 또는 공간 데이터 부족")
        right_text = right_cards.get(sector_title, "비교군 또는 공간 데이터 부족")
        with columns[index % 3]:
            with st.container(border=True):
                st.markdown(f"#### {sector_title}")
                st.markdown(f"**🟦 {left_name}**")
                st.write(left_text)
                st.caption(raw_fact(sector_id, left_stats, left_ratio))
                st.divider()
                st.markdown(f"**🟥 {right_name}**")
                st.write(right_text)
                st.caption(raw_fact(sector_id, right_stats, right_ratio))


def render_head_to_head_profile_headers(
    left_name: str, left_rank, left_stats, left_ratio: dict[str, object] | None, left_season: str,
    right_name: str, right_rank, right_stats, right_ratio: dict[str, object] | None, right_season: str,
    scope: int,
) -> None:
    """Keep scores and spatial identities visible before the H2H radar.

    A comparison can now span seasons and competitions, so each card declares
    its own cohort rather than implying that the two percentiles share one N.
    """
    st.markdown("### 👑 M.E.S.S.I. 프로필 비교")
    left_col, right_col = st.columns(2)

    def render_profile(column, name, rank, stats, ratio, season, color):
        score, tier, coverage = _spear_total(rank)
        score_text = "동기화 대기" if score is None else f"{score:.1f}/100"
        with column:
            with st.container(border=True):
                st.markdown(f"#### {color} {name}")
                st.metric("M.E.S.S.I. 점수", score_text, f"{tier}-Tier" if tier else None)
                if stats is not None:
                    league_name = stats.league_name or "대회 정보 없음"
                    st.caption(f"{season} · {league_name}")
                    st.caption(comparison_population_criteria(stats.league_id, season, scope))
                if score is not None and rank is not None:
                    score_rank = getattr(rank, "spear_score_rank", None)
                    score_top_percent = getattr(rank, "spear_score_top_percent", None)
                    population = getattr(rank, "spear_score_eligible", 0) or getattr(rank, "eligible_players", 0)
                    if score_rank and score_top_percent is not None and population:
                        st.caption(f"{score_rank}위 / {population}명 · 상위 {score_top_percent:.1f}%")
                if coverage and coverage < len(SPEAR_FACTOR_AXES):
                    st.caption(f"원천 데이터 확인 {coverage}/{len(SPEAR_FACTOR_AXES)}개 · 나머지는 보수적 D(20점) 보정")

                identities = spatial_identity_badges(
                    ratio, force_type_b=False,
                )
                footprint = activity_coverage_identity(rank)
                # The order is tactical lane identity, activity coverage, then
                # micro-zoning: it matches the requested profile scan order.
                lane_identity = identities[1] if len(identities) > 1 else None
                micro_identity = identities[0] if identities else None
                for identity in (lane_identity, footprint, micro_identity):
                    if identity:
                        badge, text = identity
                        st.markdown(f"**[{badge}]** : {text}")

    render_profile(left_col, left_name, left_rank, left_stats, left_ratio, left_season, "🟦")
    render_profile(right_col, right_name, right_rank, right_stats, right_ratio, right_season, "🟥")


def primary_spear_rank(player, selected_seasons: list[str], restrict_to_forwards: bool, minimum_final_third_ratio: int):
    """Use the first displayed league-season to drive the analysis-center radar."""
    try:
        seasons = extract_multi_season_metrics(cached_player_data(player.player_id))
        for season_key, stats in seasons.items():
            season_label = season_key.split("_", 1)[0]
            if season_label not in selected_seasons:
                continue
            season_name = f"20{season_label[:2]}/20{season_label[3:]}"
            return cached_percentiles(
                player.player_id, season_label, stats, min_xg=1.0,
                restrict_to_forwards=restrict_to_forwards,
                minimum_final_third_ratio=minimum_final_third_ratio,
            )
    except (FotMobError, ValueError, IndexError):
        return None
    return None


def spear_rank_for_session(player, season_label: str, stats: DecisionMetrics, restrict_to_forwards: bool):
    return cached_percentiles(
        player.player_id, season_label, stats, min_xg=1.0,
        restrict_to_forwards=restrict_to_forwards, minimum_final_third_ratio=0,
    )


def render_season_heatmap(
    player_id: str, player_name: str, heatmap_key: str | None = None,
    tactical_ratio: dict[str, object] | None = None,
) -> None:
    points = get_heatmap_points(player_id, heatmap_key)
    st.markdown("#### 📍 시즌 활동 히트맵")
    st.caption(
        "저장된 시즌 좌표를 기반으로 활동 밀도를 표시합니다. 공격 방향은 화면 왼쪽→오른쪽이며, "
        "화면 아래는 우측 레인(Lane 1), 위는 좌측 레인(Lane 5)입니다. 5-Lane 막대와 같은 좌표 기준을 사용합니다."
    )
    if not points:
        st.caption("정적 히트맵 좌표 데이터가 아직 생성되지 않았습니다.")
        return
    x = [point[0] for point in points if isinstance(point, list) and len(point) == 2]
    y = [point[1] for point in points if isinstance(point, list) and len(point) == 2]
    # Smooth a fixed grid so repeatedly visited zones visibly intensify instead
    # of rendering as indistinguishable overlapping dots.
    density, y_edges, x_edges = np.histogram2d(y, x, bins=(22, 32), range=((0, 100), (0, 100)))
    kernel = np.array([1, 4, 6, 4, 1], dtype=float) / 16.0
    for axis in (0, 1):
        density = np.apply_along_axis(
            lambda row: np.convolve(np.pad(row, 2, mode="edge"), kernel, mode="valid"),
            axis, density,
        )
    peak = float(density.max())
    normalized = density / peak if peak else density
    figure = go.Figure(go.Heatmap(
        z=normalized,
        x=((x_edges[:-1] + x_edges[1:]) / 2).tolist(),
        y=((y_edges[:-1] + y_edges[1:]) / 2).tolist(),
        zmin=0, zmax=1, showscale=False, zsmooth="best", opacity=0.94,
        colorscale=[
            [0.00, "rgba(0,0,0,0)"],
            [0.08, "rgba(124,151,71,0.18)"],
            [0.24, "rgba(188,185,65,0.56)"],
            [0.48, "rgba(244,209,60,0.78)"],
            [0.72, "rgba(247,135,39,0.90)"],
            [1.00, "rgba(222,63,31,0.98)"],
        ],
        hovertemplate="활동 밀도 %{z:.0%}<extra></extra>",
    ))
    line = {"color": "rgba(12,34,28,0.92)", "width": 1.3}
    for x0, y0, x1, y1 in ((0, 0, 100, 100), (83, 21.1, 100, 78.9), (0, 21.1, 17, 78.9)):
        fill = "#4d704c" if (x0, y0, x1, y1) == (0, 0, 100, 100) else "rgba(34,197,94,0.06)" if x0 == 83 else "rgba(0,0,0,0)"
        figure.add_shape(type="rect", x0=x0, y0=y0, x1=x1, y1=y1, line=line, fillcolor=fill, layer="below")
    figure.add_shape(type="line", x0=50, y0=0, x1=50, y1=100, line=line)
    figure.add_shape(type="circle", x0=43, y0=43, x1=57, y1=57, line=line)
    # SportsAPI Y=0 is the player's right touchline. Plotly's ordinary axis
    # places that coordinate at the bottom, which matches the conventional
    # viewer perspective for left-to-right attacking: right wing below, left
    # wing above. Keep raw coordinates and only use that display orientation.
    figure.update_layout(height=430, margin={"l": 0, "r": 0, "t": 0, "b": 0}, paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)", xaxis={"range": [0, 100], "visible": False, "fixedrange": True, "constrain": "domain"}, yaxis={"range": [0, 100], "visible": False, "scaleanchor": "x", "scaleratio": 0.68, "fixedrange": True, "constrain": "domain"}, showlegend=False)
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})


def lane_summary(ratio: dict[str, object] | None) -> tuple[str, str] | None:
    """Return one direction-aware lateral identity from the shared lane bins.

    SportsAPI's Y coordinate is the pitch width. In its attacking orientation,
    Lane 1/2 (the screen top) is the player's right side and Lane 4/5 is the
    player's left. The profile header and heatmap use this same convention.
    """
    if not ratio:
        return None
    fields = ("lane_1_ratio", "lane_2_ratio", "lane_3_ratio", "lane_4_ratio", "lane_5_ratio")
    if not all(ratio.get(field) is not None for field in fields):
        return None
    lanes = [max(0.0, float(ratio[field])) for field in fields]
    total = sum(lanes)
    if total <= 0.0:
        return None
    lanes = [value / total * 100.0 for value in lanes]
    right, left = lanes[0] + lanes[1], lanes[3] + lanes[4]
    halfspace, center, wing = lanes[1] + lanes[3], lanes[2], lanes[0] + lanes[4]
    direction = "좌측" if left - right > 15.0 else "우측" if right - left > 15.0 else "양측"
    if halfspace > 40.0:
        return (
            f"🎯 {direction} 하프스페이스 타격형",
            "수비진의 치명적 균열을 유발하는 안쪽 채널 침투에 능한 현대적 포워드",
        )
    if center > 50.0:
        return (
            f"⚓ {direction} 중앙 밀집형",
            "측면으로 빠지기보다 피치 중앙에 머무르며 센터백과 직접 경합하는 정적인 타겟",
        )
    if wing > 30.0:
        return (
            f"🏃 {direction} 와이드 타겟",
            "밀집 수비를 피해 측면으로 넓게 빠져서 볼을 받아주는 측면 지향적 움직임",
        )
    return (
        "🌪️ 전방위 스위칭",
        "특정 레인에 국한되지 않고 횡적으로 피치를 폭넓게 오가며 공간을 창출하는 프리롤",
    )


def spatial_identity_badges(
    ratio: dict[str, object] | None, force_type_b: bool = False,
) -> list[tuple[str, str]]:
    """Return the three compact spatial identities used by the profile header."""
    false_nine_badge = "👻 2선 지향 펄스 나인형 (Deep-Lying)"
    false_nine_text = "상대 수비와의 물리적 마찰을 피해 2선으로 내려와 플레이메이킹과 공간 창출에 집중하는 변칙적 포워드"
    if not ratio:
        return [(false_nine_badge, false_nine_text)]
    badges: list[tuple[str, str]] = []
    micro_fields = ("box_six_yard_ratio", "box_penalty_spot_ratio", "box_wide_ratio")
    box_ratio = float(ratio.get("in_box_ratio") or 0.0)
    if force_type_b or box_ratio < 15.0:
        badges.append((false_nine_badge, false_nine_text))
    elif all(ratio.get(field) is not None for field in micro_fields):
        gold, silver, bronze = (float(ratio[field]) for field in micro_fields)
        if gold + silver + bronze > 0:
            if max(gold, silver, bronze) - min(gold, silver, bronze) <= 10.0:
                badges.append(("⚖️ 전방위 타격형", "식스야드 쇄도와 컷백 대기를 가리지 않고, 박스 안 어디서든 득점 찬스를 창출"))
            elif gold >= max(silver, bronze):
                badges.append(("🥇 문전 심층 포처형", "발만 갖다 대면 득점이 되는 6야드 박스 안을 집요하게 파고드는 포식자"))
            elif silver >= bronze:
                badges.append(("🥈 중앙 박스 피니셔형", "박스 중앙의 컷백·세컨드볼 구역을 선점하며 마무리 기회를 노리는 유형"))
            else:
                badges.append(("🥉 박스 측면 활용형", "박스 측면과 제한된 슈팅 각도 구역의 활동 비중이 높은 유형"))
        else:
            badges.append((false_nine_badge, false_nine_text))
    else:
        badges.append((false_nine_badge, false_nine_text))

    profile = lane_summary(ratio)
    if profile:
        badges.append(profile)
    return badges


def activity_coverage_identity(rank) -> tuple[str, str] | None:
    """Describe the repeat-activity footprint used by the CCA radar axis."""
    cca_top_percent = getattr(rank, "cca_area_top_percent", None) if rank else None
    if cca_top_percent is None:
        return None
    coverage_score = max(0.0, min(100.0, 100.0 - float(cca_top_percent)))
    if coverage_score >= 65.0:
        badge = "🏃 활동 반경 넓은 전방위형"
        text = "반복 활동 셀의 코어 커버리지가 비교군 평균보다 넓습니다"
    elif coverage_score <= 35.0:
        badge = "🏃 활동 반경 좁은 고립형"
        text = "특정 구역에 머무르는 정적인 반복 동선이 확인됩니다"
    else:
        badge = "🏃 활동 반경 균형형"
        text = "반복 활동 구역의 코어 커버리지가 비교군 중간권입니다"
    return f"{badge} · 백분위 {coverage_score:.0f}", text


def render_lane_analysis(player_name: str, ratio: dict[str, object], rank=None) -> None:
    """Render the ETL-backed 5-Lane occupation and directional summary."""
    lane_fields = (
        ("Lane 1 · 우측 윙", "lane_1_ratio", "#2563EB"),
        ("Lane 2 · 우측 하프스페이스", "lane_2_ratio", "#38BDF8"),
        ("Lane 3 · 중앙", "lane_3_ratio", "#A78BFA"),
        ("Lane 4 · 좌측 하프스페이스", "lane_4_ratio", "#FB923C"),
        ("Lane 5 · 좌측 윙", "lane_5_ratio", "#DC2626"),
    )
    if not all(ratio.get(field) is not None for _, field, _ in lane_fields):
        st.caption("5-Lane 횡적 동선 데이터가 아직 준비되지 않았습니다.")
        return

    lanes = [max(0.0, float(ratio[field])) for _, field, _ in lane_fields]
    if sum(lanes) <= 0.0:
        st.caption("유효한 5-Lane 횡적 동선 표본이 부족합니다.")
        return

    # Percentages are generated by the ETL; normalising here only protects the
    # visual from harmless rounding drift in older CSV rows.
    total = sum(lanes)
    lanes = [value / total * 100.0 for value in lanes]
    wing_ratio = lanes[0] + lanes[4]
    halfspace_ratio = lanes[1] + lanes[3]
    center_ratio = lanes[2]
    right_ratio = lanes[0] + lanes[1]
    left_ratio = lanes[3] + lanes[4]

    if halfspace_ratio > 40.0:
        activity_badge = "🎯 하프스페이스 타격형"
        activity_text = "수비진의 치명적 균열을 유발하는 안쪽 채널 침투에 능한 현대적 포워드"
    elif center_ratio > 50.0:
        activity_badge = "⚓ 중앙 밀집형"
        activity_text = "측면으로 빠지기보다 피치 중앙에 머무르며 상대 센터백과 직접 경합하는 정적인 타겟"
    elif wing_ratio > 30.0:
        activity_badge = "🏃 와이드 타겟"
        activity_text = "밀집 수비를 피해 측면(터치라인)으로 넓게 빠져서 볼을 받아주는 측면 지향적 움직임"
    else:
        activity_badge = "🌪️ 전방위 스위칭"
        activity_text = "특정 레인에 국한되지 않고 횡적으로 피치를 폭넓게 오가며 공간을 창출하는 프리롤"

    if left_ratio - right_ratio > 15.0:
        balance_badge = "⬅️ 좌측면 지향"
        balance_text = "주로 좌측면에 머무르며(Left-biased), 우측면 활용도는 상대적으로 떨어짐"
    elif right_ratio - left_ratio > 15.0:
        balance_badge = "➡️ 우측면 지향"
        balance_text = "주로 우측면에 머무르며(Right-biased), 좌측면 활용도는 상대적으로 떨어짐"
    else:
        balance_badge = "⚖️ 좌우 밸런스형"
        balance_text = "좌우를 가리지 않고 양쪽 공간을 고르게 활용하는 밸런스 잡힌 동선"

    st.markdown("#### 🧭 5-Lane 횡적 동선 및 밸런스 분석")
    figure = go.Figure()
    for (label, _, color), value in zip(lane_fields, lanes):
        figure.add_bar(
            name=label, y=[player_name], x=[value], orientation="h",
            marker_color=color, text=[f"{value:.0f}%"], textposition="inside",
            insidetextanchor="middle",
        )
    figure.update_layout(
        barmode="stack", height=105, margin={"l": 0, "r": 0, "t": 5, "b": 0},
        showlegend=True, legend={"orientation": "h", "y": -0.48, "x": 0},
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
        xaxis={"range": [0, 100], "visible": False, "fixedrange": True},
        yaxis={"visible": False, "fixedrange": True},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})
    # One line combines direction and primary activity space; it is built by
    # the same helper used in the profile header, preventing a left/right
    # label drift between the two surfaces.
    profile = lane_summary(ratio)
    if profile:
        badge, text = profile
        st.markdown(f"**[{badge}]** : {text}")
    cca_top_percent = getattr(rank, "cca_area_top_percent", None) if rank else None
    if cca_top_percent is not None:
        coverage_score = max(0.0, min(100.0, 100.0 - float(cca_top_percent)))
        if coverage_score >= 65.0:
            coverage_badge, coverage_text = "🏃 활동 반경 넓은 전방위형", "반복 활동 셀의 코어 커버리지가 비교군 평균보다 넓습니다"
        elif coverage_score <= 35.0:
            coverage_badge, coverage_text = "🏃 활동 반경 좁은 고립형", "특정 구역에 머무르는 정적인 반복 동선이 확인됩니다"
        else:
            coverage_badge, coverage_text = "🏃 활동 반경 균형형", "반복 활동 구역의 코어 커버리지가 비교군 중간권입니다"
        st.markdown(
            f"**[{coverage_badge} · 백분위 {coverage_score:.0f}]** : {coverage_text}"
        )


def render_activity_ratio(
    player_id: str, player_name: str, ratio: dict[str, object] | None = None,
    force_type_b: bool = False, rank=None,
) -> None:
    """Render the ETL-backed mid/final-third activity split without live API calls."""
    ratio = ratio or get_tactical_ratio(player_id) or get_tactical_ratio_by_name(player_name)
    st.markdown("#### 🏃 주요 활동 반경")
    st.caption("일회성 좌표를 제외한 반복 활동 구역 기준")
    if ratio is None:
        st.caption("히트맵 비율 데이터가 아직 적재되지 않았습니다.")
        return
    mid, final = ratio["mid_third_ratio"], ratio["final_third_ratio"]
    figure = go.Figure()
    if "in_box_ratio" in ratio and "out_box_final_ratio" in ratio:
        in_box, out_box = ratio["in_box_ratio"], ratio["out_box_final_ratio"]
        figure.add_bar(name="박스 안", y=[player_name], x=[in_box], orientation="h", marker_color="#22C55E", text=[f"박스 안 {in_box:.0f}%"], textposition="inside")
        figure.add_bar(name="박스 밖 파이널", y=[player_name], x=[out_box], orientation="h", marker_color="#EF4444", text=[f"박스 밖 파이널 {out_box:.0f}%"], textposition="inside")
        figure.add_bar(name="미드써드", y=[player_name], x=[mid], orientation="h", marker_color="#3B82F6", text=[f"미드써드 {mid:.0f}%"], textposition="inside")
    else:
        figure.add_bar(name="미드써드 연계", y=[player_name], x=[mid], orientation="h", marker_color="#3B82F6", text=[f"미드써드 연계 {mid:.0f}%"], textposition="inside")
        figure.add_bar(name="파이널써드 타격", y=[player_name], x=[final], orientation="h", marker_color="#EF4444", text=[f"파이널써드 타격 {final:.0f}%"], textposition="inside")
    figure.update_layout(
        barmode="stack", height=90, margin={"l": 0, "r": 0, "t": 5, "b": 0},
        showlegend=True, legend={"orientation": "h", "y": -0.45},
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
        xaxis={"range": [0, 100], "visible": False, "fixedrange": True},
        yaxis={"visible": False, "fixedrange": True},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})
    render_lane_analysis(player_name, ratio, rank=rank)
    zone_fields = (
        ("🥇 골드 존 · 6야드", "box_six_yard_ratio", "#F6C945"),
        ("🥈 실버 존 · 중앙 박스", "box_penalty_spot_ratio", "#CBD5E1"),
        ("🥉 브론즈 존 · 와이드 박스", "box_wide_ratio", "#CD7F32"),
    )
    micro_values = [ratio.get(field) for _, field, _ in zone_fields]
    # Historical rows built from a down-sampled visual heatmap can retain a
    # valid pitch image while losing every box coordinate.  Treat that as
    # unavailable rather than presenting three misleading 0.0% values.
    micro_available = (
        all(value is not None for value in micro_values)
        and sum(float(value) for value in micro_values) > 0.0
    )
    if micro_available:
        gold = float(ratio["box_six_yard_ratio"])
        silver = float(ratio["box_penalty_spot_ratio"])
        bronze = float(ratio["box_wide_ratio"])
        weighted = float(ratio.get("deep_box_zone_score", 0.0))
        micro_badge, micro_text = spatial_identity_badges(ratio, force_type_b=force_type_b)[0]
        label_col, help_col = st.columns([5, 1])
        with label_col:
            st.markdown("### 🎯 박스 내 마이크로 조닝 요약")
            st.markdown(
                f"<div style='padding:0.7rem 0.85rem; border-left:5px solid #F6C945; "
                f"background:rgba(246,201,69,0.12); border-radius:0.35rem; font-size:1.08rem; font-weight:750; line-height:1.55;'>"
                f"[ {micro_badge} ] : {micro_text}</div>",
                unsafe_allow_html=True,
            )
            st.caption(f"킬링 존 타격 지수 {weighted:.1f}/100")
        with help_col:
            with st.popover("❓ 구역 안내"):
                st.markdown("**골드 존**: 6야드 박스, 가장 높은 득점 확률 구역")
                st.markdown("**실버 존**: 페널티 스팟 정면, 컷백 타격 구역")
                st.markdown("**브론즈 존**: 박스 측면, 슈팅 각도가 제한되는 구역")
        zone_cols = st.columns(3)
        for column, (label, field, color) in zip(zone_cols, zone_fields):
            with column:
                st.markdown(
                    f"<div style='border-left:4px solid {color}; padding-left:0.55rem;'>"
                    f"<b>{label}</b><br><span style='font-size:1.25rem'>{float(ratio[field]):.1f}%</span></div>",
                    unsafe_allow_html=True,
                )
    else:
        false_nine_badge, false_nine_text = spatial_identity_badges(ratio)[0]
        st.markdown("### 🎯 박스 내 마이크로 조닝 요약")
        st.markdown(
            f"<div style='padding:0.7rem 0.85rem; border-left:5px solid #A855F7; "
            f"background:rgba(168,85,247,0.12); border-radius:0.35rem; font-size:1.08rem; font-weight:750; line-height:1.55;'>"
            f"[ {false_nine_badge} ] : {false_nine_text}</div>",
            unsafe_allow_html=True,
        )


def build_radar_profile(
    player, selected_seasons: list[str], competition_filter: str,
    restrict_to_forwards: bool, minimum_final_third_ratio: int,
):
    """Return the first eligible season's profile for the compare-mode overlay."""
    try:
        seasons = extract_multi_season_metrics(cached_player_data(player.player_id))
        for season_key, stats in seasons.items():
            season_str = season_key.split("_", 1)[0]
            is_ucl = stats.league_id == 42 or "champions" in (stats.league_name or "").lower()
            if season_str not in selected_seasons:
                continue
            if competition_filter == "리그" and is_ucl:
                continue
            if competition_filter == "챔피언스리그" and not is_ucl:
                continue
            rank = cached_percentiles(player.player_id, season_str, stats, 1.0, restrict_to_forwards, minimum_final_third_ratio)
            return make_radar_profile(f"{player.name} · {season_str}", rank)
    except Exception:
        return None
    return None

def render_tactical_matrix(
    matrix: pd.DataFrame, selected_player_id: str, selected_name: str,
    comparison_label: str = "동일 대회 기준",
) -> None:
    if matrix.empty:
        st.info("사분면을 구성할 수 있는 비교군 데이터가 없습니다.")
        return

    x_median = matrix["net_progression_per90"].median()
    y_median = matrix["in_box_xgot_minus_xg"].median()
    x_min, x_max = matrix["net_progression_per90"].min(), matrix["net_progression_per90"].max()
    y_min, y_max = matrix["in_box_xgot_minus_xg"].min(), matrix["in_box_xgot_minus_xg"].max()
    x_pad = max((x_max - x_min) * 0.12, 0.15)
    y_pad = max((y_max - y_min) * 0.12, 0.10)
    x_range = [x_min - x_pad, x_max + x_pad]
    y_range = [y_min - y_pad, y_max + y_pad]

    highlighted = matrix[matrix["player_id"].astype(str) == str(selected_player_id)]
    background = matrix[matrix["player_id"].astype(str) != str(selected_player_id)]
    is_dark = st.get_option("theme.base") == "dark"
    
    figure = go.Figure()
    figure.add_trace(go.Scatter(
        x=background["net_progression_per90"], y=background["in_box_xgot_minus_xg"],
        # Comparison players remain uncluttered points.  Their name, team and
        # both coordinates are retained in ``customdata`` for hover only.
        mode="markers",
        customdata=background[["player_name", "team_name", "net_progression_per90", "in_box_xgot_minus_xg"]],
        marker={"size": 10, "color": "rgba(140, 140, 140, 0.45)"},
        hovertemplate=("<b>%{customdata[0]}</b><br>%{customdata[1]}<br>"
                       "Net Progression /90: %{customdata[2]:.2f}<br>"
                       "In-Box xGOT - xG: %{customdata[3]:.2f}<extra></extra>"),
        name="비교군",
    ))
    if not highlighted.empty:
        figure.add_trace(go.Scatter(
            x=highlighted["net_progression_per90"], y=highlighted["in_box_xgot_minus_xg"], mode="markers+text",
            text=[selected_name], textposition="top center",
            customdata=highlighted[["player_name", "team_name", "net_progression_per90", "in_box_xgot_minus_xg"]],
            marker={"size": 17, "color": "#F4C542", "line": {"color": "#E63946", "width": 2}},
            hovertemplate=("<b>%{customdata[0]}</b><br>%{customdata[1]}<br>"
                           "Net Progression /90: %{customdata[2]:.2f}<br>"
                           "In-Box xGOT - xG: %{customdata[3]:.2f}<extra></extra>"),
            name="선택 선수",
        ))

    quadrants = [
        (x_range[0], x_median, y_median, y_range[1], "rgba(78, 121, 167, 0.08)", "포처"),
        (x_median, x_range[1], y_median, y_range[1], "rgba(89, 161, 79, 0.10)", "컴플리트포워드"),
        (x_range[0], x_median, y_range[0], y_median, "rgba(225, 87, 89, 0.07)", "컴플리트낙제점"),
        (x_median, x_range[1], y_range[0], y_median, "rgba(242, 142, 43, 0.08)", "펄스나인"),
    ]
    for x0, x1, y0, y1, color, label in quadrants:
        figure.add_shape(type="rect", x0=x0, x1=x1, y0=y0, y1=y1, fillcolor=color, line={"width": 0}, layer="below")
        figure.add_annotation(x=(x0 + x1) / 2, y=(y0 + y1) / 2, text=label, showarrow=False,
                              font={"size": 15, "color": "rgba(128, 128, 128, 0.40)"})
    figure.add_vline(x=x_median, line_dash="dash", line_color="#8a8a8a")
    figure.add_hline(y=y_median, line_dash="dash", line_color="#8a8a8a")
    figure.update_layout(
        template="plotly_dark" if is_dark else "plotly_white", height=600,
        margin={"l": 25, "r": 25, "t": 45, "b": 25}, showlegend=False,
        title=f"전술 사분면 매트릭스 · {comparison_label}",
        xaxis={"title": "Net Progression / 90분", "range": x_range, "zeroline": True},
        yaxis={"title": "In-Box xGOT - xG", "range": y_range, "zeroline": True},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displaylogo": False})

def get_gradient_color(percentile: float) -> str:
    """Return a Plotly-safe RGB colour for any rank-derived marker value."""
    try:
        percentile = float(percentile)
    except (TypeError, ValueError):
        percentile = 50.0
    if not math.isfinite(percentile):
        percentile = 50.0
    percentile = max(0.0, min(100.0, percentile))
    if percentile <= 50:
        ratio = percentile / 50.0
        r, g, b = int(30 + (255 - 30) * ratio), int(136 + (193 - 136) * ratio), int(229 + (7 - 229) * ratio)
    else:
        ratio = (percentile - 50.0) / 50.0
        r, g, b = int(255 + (229 - 255) * ratio), int(193 + (57 - 193) * ratio), int(7 + (53 - 7) * ratio)
    return f"rgb({r}, {g}, {b})"

def render_unified_bar(
    title: str,
    player_value: float | None = None,
    median_value: float | None = None,
    top_percent: float | None = None,
    rank_val: int | None = None,
    total_players: int | None = None,
    suffix: str = ""
) -> None:
    if player_value is None and top_percent is None:
        st.caption(f"{title} · 데이터 부족")
        return

    def finite_number(value: float | None, default: float = 0.0) -> float:
        try:
            numeric = float(value) if value is not None else default
        except (TypeError, ValueError):
            return default
        return numeric if math.isfinite(numeric) else default

    safe_player = finite_number(player_value)
    raw_median = finite_number(median_value, default=float("nan"))
    has_median = median_value is not None and math.isfinite(raw_median)
    safe_median = raw_median if has_median else 0.0
    safe_top_percent = finite_number(top_percent, default=float("nan"))
    if not math.isfinite(safe_top_percent):
        safe_top_percent = None

    if safe_top_percent is not None:
        # Rank data is authoritative when it exists: use the same percentile
        # scale for the marker and its colour.
        player_pos = max(0.0, min(100.0, 100.0 - safe_top_percent))
        color_pos = player_pos
        median_pos = 50.0 if has_median else None
    else:
        # Anchor the absolute-value scale to the cohort median. Deriving the
        # scale from the player value pins whichever value is larger to 80%.
        if safe_median > 0:
            scale_max = safe_median * 2.2
        else:
            scale_max = max(safe_player, 0.1) * 1.6
        player_pos = min((safe_player / scale_max) * 100.0, 100.0)
        median_pos = (
            min((safe_median / scale_max) * 100.0, 100.0)
            if has_median else None
        )
        color_pos = player_pos

    dynamic_color = get_gradient_color(color_pos)
    rank_label = (
        f"{rank_val}위 / {total_players}명 · 상위 {safe_top_percent}%"
        if rank_val is not None and safe_top_percent is not None else ""
    )

    label_col, rank_col = st.columns([3, 1])
    label_col.markdown(f"**{title}** · 선수 {safe_player:.2f}{suffix}")
    if rank_label:
        rank_col.caption(rank_label)

    figure = go.Figure()
    figure.add_trace(go.Scatter(
        x=[0, 100], y=[0, 0], mode="lines",
        line={"color": "#454545", "width": 6},
        hoverinfo="skip", showlegend=False,
    ))
    if median_pos is not None:
        figure.add_trace(go.Scatter(
            x=[median_pos], y=[0], mode="markers",
            marker={"symbol": "diamond", "size": 15, "color": "#aaa", "line": {"color": "#262730", "width": 2}},
            hovertemplate=f"중앙값 {safe_median:.2f}{suffix}<extra></extra>",
            showlegend=False,
        ))
    figure.add_trace(go.Scatter(
        x=[player_pos], y=[0], mode="markers",
        marker={"symbol": "circle", "size": 15, "color": dynamic_color, "line": {"color": "#262730", "width": 2}},
        hovertemplate=f"선수 {safe_player:.2f}{suffix}<extra></extra>",
        showlegend=False,
    ))
    figure.update_layout(
        height=48, margin={"l": 0, "r": 0, "t": 0, "b": 0},
        paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="rgba(0,0,0,0)",
    )
    figure.update_xaxes(range=[-1, 101], visible=False, fixedrange=True)
    figure.update_yaxes(range=[-1, 1], visible=False, fixedrange=True)
    st.plotly_chart(
        figure,
        use_container_width=True,
        config={"displayModeBar": False},
        key=f"unified-bar-{next(_UNIFIED_BAR_COUNTER)}",
    )

    median_label = f"◆ 중앙값 {safe_median:.2f}{suffix}" if has_median else "중앙값 없음"
    poor_col, median_col, great_col = st.columns([1, 2, 1])
    poor_col.caption("Poor")
    median_col.caption(median_label)
    great_col.caption("Great")

def style_dataframe(df: pd.DataFrame):
    if df.empty:
        return df
    try:
        return df.style.background_gradient(
            cmap="RdYlBu_r", subset=["박스 안 순수 결정력 (xGOT-xG)"]
        ).format({
            "박스 안 순수 결정력 (xGOT-xG)": "{:.2f}",
            "박스 안 xG": "{:.2f}",
            "박스 안 xGOT": "{:.2f}"
        })
    except Exception:
        return df

def select_player(query: str, key: str, label: str = "선수 선택"):
    if not query.strip():
        return None
    try:
        candidates = cached_search(query.strip())
    except FotMobError as exc:
        st.error(f"선수 검색에 실패했습니다: {exc}")
        return None
    if not candidates:
        st.warning("일치하는 선수를 찾지 못했습니다.")
        return None
    labels = [f"{row.name} · {row.team_name}" if row.team_name else row.name for row in candidates]
    # Never treat the first autocomplete match as a selection. Search endpoints
    # often return several similarly named players, so navigation must wait for
    # an explicit user choice from the visible candidate list.
    options = [None, *range(len(candidates))]
    selected_index = st.selectbox(
        label, options,
        format_func=lambda index: "선수를 선택하세요" if index is None else labels[index],
        key=key,
    )
    return candidates[selected_index] if selected_index is not None else None


def render_spear_leaderboard(
    season: str, comparison_scope: int, league_id: int = 47,
    position_filter: str = "전체", role_filter: str = "전체",
    section_title: str = "🏆 M.E.S.S.I. 스카우팅 리스트",
) -> PlayerCandidate | None:
    """Show a local, sortable scouting list and return the selected player."""
    table = cached_spear_leaderboard(league_id, season, comparison_scope)
    role_filter = {"정통형": "Type A", "펄스 나인형": "Type B"}.get(role_filter, role_filter)
    st.subheader(section_title)
    st.caption(comparison_population_criteria(league_id, season, comparison_scope))
    if table.empty:
        st.info(
            f"{season} 시즌의 정적 M.E.S.S.I. 코호트가 아직 준비되지 않았습니다. "
            "상세 검색은 가능하며, 리더보드는 시즌 스냅샷이 적재되면 자동 활성화됩니다."
        )
        return None
    if position_filter != "전체" and "position" in table:
        position_tokens = {
            "FW": ("striker", "forward", "winger", "attacking"),
            "MF": ("midfielder",),
            "DF": ("back", "defender"),
        }
        tokens = position_tokens.get(position_filter, ())
        table = table[
            table["position"].astype(str).str.lower().apply(
                lambda value: any(token in value for token in tokens)
            )
        ]
    if role_filter in {"Type A", "Type B"}:
        table = table[table["role"] == role_filter]
    if table.empty:
        st.info("현재 필터 조합에 맞는 M.E.S.S.I. 선수 데이터가 없습니다.")
        return None
    display = table.rename(columns={
        "rank": "순위", "player_name": "선수", "team_name": "팀", "league_name": "리그",
        "score": "M.E.S.S.I.", "tier": "티어", "role": "기본 롤",
        "outside_shot_tier": "박스 밖 슈팅", "deep_box_tier": "박스 타격",
        "danger_zone_tier": "위험 구역", "aerial_tier": "공중볼",
        "ground_duel_tier": "지상 경합", "space_control_tier": "공간 장악",
    })[[
        "순위", "선수", "팀", "리그", "M.E.S.S.I.", "티어", "박스 밖 슈팅", "박스 타격",
        "위험 구역", "공중볼", "지상 경합", "공간 장악", "기본 롤",
    ]].copy()
    display.insert(
        1, "프로필",
        "https://images.fotmob.com/image_resources/playerimages/" + table["player_id"].astype(str) + ".png",
    )
    # The player name is the only list-to-detail navigation control.  Do not
    # auto-route on dataframe-row selection: Streamlit preserves a selected
    # row across reruns, which previously sent users straight back to Detail
    # after they had clicked the Leaderboard page in the sidebar.
    def detail_url(row: pd.Series) -> str:
        player_name = str(row["player_name"])
        return (
            f"?page=detail&player={quote(str(row['player_id']))}"
            f"&name={quote(player_name)}&team={quote(str(row['team_name']))}"
            f"&season={quote(season)}&scope={comparison_scope}&label={player_name}"
        )

    display["선수"] = table.apply(detail_url, axis=1)
    display["기본 롤"] = display["기본 롤"].map({
        "Type A": "정통형", "Type B": "펄스 나인형",
    }).fillna(display["기본 롤"])
    display["M.E.S.S.I."] = display["M.E.S.S.I."].map(lambda value: f"{value:.1f}")
    st.dataframe(
        display, use_container_width=True, hide_index=True, height=430,
        column_config={
            "프로필": st.column_config.ImageColumn("프로필", width="small"),
            "선수": st.column_config.LinkColumn(
                "선수", display_text=r".*[?&]label=([^&]+).*",
                help="선수 이름을 클릭하면 상세 분석 리포트로 이동합니다.",
            ),
        },
        key=f"v32_leaderboard_{league_id}_{season}_{comparison_scope}",
    )
    st.caption("선수 이름을 클릭하면 해당 선수의 상세 분석 리포트로 이동합니다.")
    return None

def render_player_report(
    player, selected_seasons: list[str], competition_filter: str,
    restrict_to_forwards: bool, minimum_final_third_ratio: int, show_activity: bool = True,
    selected_league_id: int | None = None, comparison_scope: int = 0,
) -> None:
    try:
        with st.spinner(f"{player.name}의 전술 스탯을 분석 중입니다..."):
            seasons = extract_multi_season_metrics(cached_player_data(player.player_id))
    except FotMobError as exc:
        st.error(f"데이터를 불러오지 못했습니다: {exc}")
        return
    if not seasons:
        st.warning("스탯 데이터를 찾을 수 없습니다.")
        return

    st.subheader(player.name)
    if show_activity:
        render_activity_ratio(player.player_id, player.name)
    for season_key, stats in seasons.items():
        season_str = season_key.split("_", 1)[0]
        is_ucl = stats.league_id == 42 or "champions" in (stats.league_name or "").lower()
        if season_str not in selected_seasons:
            continue
        if competition_filter == "리그" and is_ucl:
            continue
        if competition_filter == "챔피언스리그" and not is_ucl:
            continue
        if selected_league_id is not None and stats.league_id != selected_league_id:
            continue

        with st.expander(f"🏆 {season_str} · {stats.league_name or '대회 정보 없음'}", expanded=True):
            if stats.team_name:
                st.caption(f"소속팀: {stats.team_name}")
            season_name = f"20{season_str[:2]}/20{season_str[3:]}"
            
            # --- AttributeError 방지: 객체를 직접 수정하지 않고 지역 변수로 우회 ---
            aerial_won = getattr(stats, "aerial_duels_won_per90", None) or 0.0
            aerial_lost = getattr(stats, "aerial_duels_lost_per90", None) or 0.0
            duels_won = getattr(stats, "duels_won_per90", None) or 0.0
            duels_lost = getattr(stats, "duels_lost_per90", None) or 0.0
            dribbles_succeeded = getattr(stats, "dribbles_succeeded_per90", None) or 0.0
            dribbles_failed = getattr(stats, "dribbles_failed_per90", None) or 0.0
            fouls_won = getattr(stats, "fouls_won_per90", None) or 0.0
            penalties_awarded = getattr(stats, "penalties_awarded_per90", None) or 0.0
            dispossessed = getattr(stats, "dispossessed_per90", None) or 0.0

            # 누락 스탯으로 인해 순수 전진 기여도가 계산되지 않았을 경우를 위한 백업 계산
            net_progression = getattr(stats, "net_progression_per90", None)
            if net_progression is None:
                net_progression = (
                    dribbles_succeeded + fouls_won + penalties_awarded + duels_won + aerial_won
                    - duels_lost - aerial_lost - dribbles_failed - dispossessed
                )
            # -----------------------------------------------------------

            try:
                medians = cached_league_medians(stats.league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)
            except Exception:
                medians = {}

            try:
                minimum_xg = 1.0
                rank = cached_percentiles(
                    player.player_id, season_str, stats, min_xg=minimum_xg,
                    restrict_to_forwards=restrict_to_forwards,
                    minimum_final_third_ratio=minimum_final_third_ratio,
                    comparison_scope=comparison_scope,
                )
            except Exception:
                rank = None

            render_radar_chart(
                [make_radar_profile(f"{player.name} · {season_str}", rank)],
                "🕸️ 전술 프로필 · 전문 공격수 백분위",
            )

            try:
                matrix = cached_tactical_matrix(
                    stats.league_id, season_name, restrict_to_forwards,
                    minimum_final_third_ratio, comparison_scope,
                )
                if str(player.player_id) not in matrix.get("player_id", pd.Series(dtype=str)).astype(str).tolist():
                    matrix = pd.concat([matrix, pd.DataFrame([{
                        "player_id": str(player.player_id), "player_name": player.name,
                        "team_name": stats.team_name or "", 
                        "net_progression_per90": net_progression,  # 수정한 지역 변수 사용
                        "in_box_xgot_minus_xg": stats.in_box_finishing,
                    }])], ignore_index=True)
                st.caption(
                    "📊 전술 사분면 매트릭스 · "
                    + comparison_population_criteria(stats.league_id, season_str, comparison_scope)
                )
                render_tactical_matrix(
                    matrix, player.player_id, player.name,
                    comparison_population_label(stats.league_id, comparison_scope),
                )
            except Exception:
                st.caption("사분면 매트릭스를 구성할 비교 집단 데이터가 없습니다.")

            st.divider()

            def get_rank(attr):
                return getattr(rank, attr, None) if rank else None

            progression_eligible = get_rank("progression_eligible") or 0
            minimum_minutes = 180 if stats.league_id in (42, 73, 108) else 450
            minimum_xg = 1.0 if stats.league_id in {42, 73, 108} else 2.0
            cohort_label = f"{comparison_population_label(stats.league_id, comparison_scope)} · {minimum_minutes}분 이상 · xG {minimum_xg:.1f} 이상"
            with st.expander(
                f"🏃 순수 전진 기여도 상대평가 · {cohort_label} · 비교군 {progression_eligible}명",
                expanded=True,
            ):
                st.caption("성공 드리블 + 획득 파울 + 획득 PK + 볼 경합 성공 + 공중볼 경합 성공 − 볼 경합 실패 − 공중볼 경합 실패 − 실패 드리블 − 볼 뺏김")
                tab_dribble, tab_duel, tab_aerial, tab_total = st.tabs(["🤹 드리블", "⚔️ 지상 경합", "✈️ 공중볼", "🚀 종합 기여도"])
                with tab_dribble:
                    render_unified_bar("성공 드리블", dribbles_succeeded, medians.get("dribbles_succeeded_per90"), get_rank("dribbles_succeeded_per90_top_percent"), get_rank("dribbles_succeeded_per90_rank"), progression_eligible, "/90분")
                    render_unified_bar("실패 드리블", dribbles_failed, medians.get("dribbles_failed_per90"), get_rank("dribbles_failed_per90_top_percent"), get_rank("dribbles_failed_per90_rank"), progression_eligible, "/90분")
                    render_unified_bar("드리블 마진", stats.dribble_margin_per90, medians.get("dribble_margin_per90"), get_rank("dribble_margin_per90_top_percent"), get_rank("dribble_margin_per90_rank"), progression_eligible, "/90분")
                with tab_duel:
                    render_unified_bar("볼 경합 성공", duels_won, medians.get("duels_won_per90"), get_rank("duels_won_per90_top_percent"), get_rank("duels_won_per90_rank"), progression_eligible, "/90분")
                    render_unified_bar("볼 경합 실패", duels_lost, medians.get("duels_lost_per90"), get_rank("duels_lost_per90_top_percent"), get_rank("duels_lost_per90_rank"), progression_eligible, "/90분")
                    render_unified_bar("볼 경합 마진", stats.duel_margin_per90, medians.get("duel_margin_per90"), get_rank("duel_margin_per90_top_percent"), get_rank("duel_margin_per90_rank"), progression_eligible, "/90분")
                with tab_aerial:
                    render_unified_bar("공중볼 경합 성공", aerial_won, medians.get("aerial_duels_won_per90"), get_rank("aerials_won_per90_top_percent"), get_rank("aerials_won_per90_rank"), progression_eligible, "/90분")
                    render_unified_bar("공중볼 경합 실패", aerial_lost, medians.get("aerial_duels_lost_per90"), get_rank("aerials_lost_per90_top_percent"), get_rank("aerials_lost_per90_rank"), progression_eligible, "/90분")
                    render_unified_bar("공중볼 마진", stats.aerial_margin_per90, medians.get("aerial_margin_per90"), get_rank("aerial_margin_per90_top_percent"), get_rank("aerial_margin_per90_rank"), progression_eligible, "/90분")
                with tab_total:
                    render_unified_bar("순수 전진 기여도", net_progression, medians.get("net_progression_per90"), get_rank("net_progression_top_percent"), get_rank("net_progression_rank"), progression_eligible, "/90분")

            st.divider()
            
            if rank and rank.eligible_players:
                with st.expander(f"🎯 결정력 상대평가 · {cohort_label} · {rank.eligible_players}명", expanded=True):
                    st.caption("⭐ 메인 지표 · 박스 안 마무리 / 보조 지표 · 중거리 성향 및 슛 이후 변수")
                    render_unified_bar("박스 안 순수 결정력", stats.in_box_finishing, rank.in_box_finishing_median,
                                       rank.in_box_finishing_top_percent, rank.in_box_finishing_rank, progression_eligible, "골")
                    render_unified_bar("박스 밖 슈팅 퀄리티", stats.out_box_shot_quality, rank.out_box_shot_quality_median,
                                       rank.out_box_shot_quality_top_percent, rank.out_box_shot_quality_rank, progression_eligible, "골")
                    render_unified_bar("득점 운 · 상대 선방", stats.luck_or_gk_impact, rank.gk_impact_median,
                                       rank.gk_impact_top_percent, rank.gk_impact_rank, rank.eligible_players, "골")
            else:
                st.caption("결정력 상대평가 비교군을 불러오지 못했습니다.")

def render_v32_analysis_center() -> None:
    """Form-gated Ver 3.2 entry panel; expensive report work starts on submit."""
    st.title("🇪🇺 유럽 5대리그 공격기여도 분석센터")
    st.caption("3-Zone 활동 비율 · M.E.S.S.I. · 동일 리그 비교 리포트")
    if "v32_filters" not in st.session_state:
        st.session_state.v32_filters = None

    with st.form("global_analysis_filters", border=True):
        season_col, scope_col, player_col, action_col = st.columns([1.2, 1.3, 2.1, 1.0])
        with season_col:
            season = st.selectbox("시즌", ["25/26", "24/25", "23/24", "22/23", "21/22"], index=0)
        with scope_col:
            comparison_scope = st.selectbox(
                "비교 모집단", [3, 5, 7], index=1,
                format_func=lambda value: f"{value}대 리그",
                help="3대: LaLiga·Premier League·Serie A / 5대: 여기에 Bundesliga·Ligue 1 / 7대: 여기에 Eredivisie·Primeira Liga",
            )
        with player_col:
            query = st.text_input("선수명 검색", placeholder="예: Erling Haaland")
        with action_col:
            st.write("")
            submitted = st.form_submit_button("🔍 데이터 분석", use_container_width=True, type="primary")
        if submitted:
            st.session_state.v32_filters = {"season": season, "comparison_scope": comparison_scope, "query": query.strip()}

    filters = st.session_state.v32_filters
    if not filters:
        st.info("포지션·시즌·선수명을 설정한 뒤 **데이터 분석**을 눌러주세요.")
        return
    leaderboard_player = render_spear_leaderboard(filters["season"], filters["comparison_scope"])
    st.divider()
    player = (
        select_player(filters["query"], "v32_selected_player")
        if filters["query"] else leaderboard_player
    )
    if not player:
        if not filters["query"]:
            st.info("선수명을 검색하거나, 위 스카우팅 리스트에서 한 행을 선택해 상세 분석을 여세요.")
        return
    try:
        all_sessions = extract_multi_season_metrics(cached_player_data(player.player_id))
    except FotMobError as exc:
        st.error(f"선수 세션 데이터를 불러오지 못했습니다: {exc}")
        return
    session_rows = [
        (key, stats) for key, stats in all_sessions.items()
        if key.split("_", 1)[0] == filters["season"]
    ]
    if not session_rows:
        st.warning(f"{filters['season']} 시즌에 조회 가능한 대회 기록이 없습니다.")
        return
    selected_index = st.selectbox(
        "대회", range(len(session_rows)),
        format_func=lambda index: session_rows[index][1].league_name or "대회 정보 없음",
        key=f"v32_competition_{player.player_id}_{filters['season']}",
    )
    session_key, selected_stats = session_rows[selected_index]
    # A static leaderboard link carries the season-specific roster team.  Use
    # it when the live session payload omits a team label, rather than showing
    # an avoidable “team information unavailable” caption on the report.
    session_team = selected_stats.team_name or player.team_name or "팀 정보 미제공"
    st.caption(
        f"분석 세션: {filters['season']} · {selected_stats.league_name or '대회 정보 미제공'} · {session_team} "
        "(검색 결과의 소속 표기는 현재 소속일 수 있습니다.)"
    )
    st.divider()
    tactical_ratio = get_tactical_ratio_for_session(player.player_id, selected_stats.league_name or "", filters["season"])
    rank = cached_percentiles(
        player.player_id, filters["season"], selected_stats, 1.0, True, 0,
        filters["comparison_scope"],
    )
    if filters["comparison_scope"] == 7:
        st.caption("7대 리그 모드: Eredivisie·Primeira Liga 코호트는 다음 정적 코호트 수집 후 자동으로 포함됩니다. 현재는 적재된 5대 리그 기준입니다.")
    view_mode = st.radio("분석 보기", ["단일 분석", "Head-to-Head"], horizontal=True, key="v32_view_mode")
    if view_mode == "Head-to-Head":
        st.caption("두 선수는 같은 시즌·같은 대회 세션에서 각각 독립적으로 상대평가됩니다.")
        opponent = select_player(
            st.text_input("비교 선수 검색", key="v32_opponent_query", placeholder="예: Robert Lewandowski"),
            "v32_opponent_player",
        )
        if not opponent:
            return
        try:
            opponent_sessions = extract_multi_season_metrics(cached_player_data(opponent.player_id))
        except FotMobError as exc:
            st.error(f"비교 선수 세션 데이터를 불러오지 못했습니다: {exc}")
            return
        opponent_stats = next((
            stats for key, stats in opponent_sessions.items()
            if key.split("_", 1)[0] == filters["season"] and stats.league_id == selected_stats.league_id
        ), None)
        if opponent_stats is None:
            st.warning(f"{opponent.name}은(는) {filters['season']} {selected_stats.league_name}에 독립된 세션이 없습니다.")
            return
        opponent_rank = cached_percentiles(
            opponent.player_id, filters["season"], opponent_stats, 1.0, True, 0,
            filters["comparison_scope"],
        )
        left_total = sum(_radar_score(getattr(rank, attr, None)) for _, attr in SPEAR_FACTOR_AXES) if rank else 0.0
        right_total = sum(_radar_score(getattr(opponent_rank, attr, None)) for _, attr in SPEAR_FACTOR_AXES) if opponent_rank else 0.0
        if twin_matrix_coordinates(rank) and twin_matrix_coordinates(rank) == twin_matrix_coordinates(opponent_rank):
            result = "🤝 동일한 전술 프로필"
        elif left_total > right_total:
            result = f"🏆 {player.name} 우세"
        else:
            result = f"🏆 {opponent.name} 우세"
        opponent_ratio = get_tactical_ratio_for_session(
            opponent.player_id, opponent_stats.league_name or "", filters["season"],
        )
        st.subheader(f"{result} · {selected_stats.league_name}")
        render_spear_head_to_head(player.name, rank, opponent.name, opponent_rank)
        render_head_to_head_cards(
            player.name, rank, selected_stats, tactical_ratio,
            opponent.name, opponent_rank, opponent_stats, opponent_ratio,
        )
        with st.expander("공간·활동량 세부 차트", expanded=False):
            left_col, right_col = st.columns(2)
            with left_col:
                render_activity_ratio(player.player_id, player.name, tactical_ratio, rank=rank)
                render_season_heatmap(
                    player.player_id, player.name,
                    tactical_ratio.get("heatmap_key") if tactical_ratio else None,
                    tactical_ratio,
                )
            with right_col:
                render_activity_ratio(opponent.player_id, opponent.name, opponent_ratio, rank=opponent_rank)
                render_season_heatmap(
                    opponent.player_id, opponent.name,
                    opponent_ratio.get("heatmap_key") if opponent_ratio else None,
                    opponent_ratio,
                )
        return
    # Role remains a tactical descriptor. Both views use the identical,
    # transparent six-factor score formula and never mask box activity.
    default_role = "type_b" if getattr(rank, "is_type_b", False) else "type_a"
    title_col, role_col, help_col = st.columns([4.2, 3.0, 1.0])
    with role_col:
        selected_role = st.radio(
            "M.E.S.S.I. 롤 시뮬레이션",
            ("type_a", "type_b"),
            index=0 if default_role == "type_a" else 1,
            format_func=lambda role: (
                "🎯 정통 9번 롤 (Type A)" if role == "type_a"
                else "👻 펄스 나인 롤 (Type B)"
            ),
            horizontal=True,
            key=(
                f"v32_role_{player.player_id}_{filters['season']}_"
                f"{selected_stats.league_id}_{filters['comparison_scope']}"
            ),
        )
    if selected_role != default_role:
        rank = cached_percentiles(
            player.player_id, filters["season"], selected_stats, 1.0, True, 0,
            filters["comparison_scope"], selected_role,
        )
    spear_score, spear_tier, spear_coverage = _spear_total(rank)
    with title_col:
        if spear_score is None:
            st.subheader(f"👑 {player.name}  ·  🏷️ M.E.S.S.I. 데이터 부족")
        else:
            score_rank = getattr(rank, "spear_score_rank", None)
            score_percent = getattr(rank, "spear_score_top_percent", None)
            score_population = getattr(rank, "spear_score_eligible", 0) or rank.eligible_players
            rank_text = (
                f" ({score_rank}위 / {score_population}명 · 상위 {score_percent:.1f}%)"
                if score_rank and score_percent is not None and score_population else ""
            )
            st.subheader(f"👑 {player.name}  ·  [{spear_tier}-Tier]  M.E.S.S.I. {spear_score:.1f}/100{rank_text}")
            st.caption(
                comparison_population_criteria(
                    selected_stats.league_id, filters["season"], filters["comparison_scope"],
                )
            )
            st.caption(
                f"전술 역할: {getattr(rank, 'spear_role', 'Type A · 정통 타겟/포처')} "
                "· 모든 역할에 동일한 6개 팩터 가중치 적용"
            )
            if spear_coverage < len(SPEAR_FACTOR_AXES):
                st.caption(f"원천 데이터 확인 {spear_coverage}/{len(SPEAR_FACTOR_AXES)}개 · 나머지는 보수적 D(20점) 보정입니다.")
            identities = spatial_identity_badges(
                tactical_ratio,
                force_type_b=False,
            )
            if identities:
                st.markdown("**💡 전술 공간 아이덴티티**")
                for badge, text in identities:
                    st.markdown(f"**[{badge}]** : {text}")
    with help_col:
        with st.popover("❓ M.E.S.S.I. 프레임워크"):
            st.markdown(MESSI_FRAMEWORK)
            st.caption("동일 대회 비교군의 정규화된 팩터를 0~100 점수로 변환합니다.")
            st.markdown("S 🌟 95+ · A 🔴 85~94 · B 🔵 65~84 · C 🟢 35~64 · D ⚪ 34 이하")
    volume_col, ratio_col = st.columns(2)
    selected_population_label = comparison_population_label(selected_stats.league_id, filters["comparison_scope"])
    with volume_col:
        render_spear_radar(
            player.name, rank, selected_stats, volume=True, tactical_ratio=tactical_ratio,
            comparison_label=selected_population_label,
            chart_key=f"analysis_radar_{player.player_id}_{selected_stats.league_id}_{filters['season']}_volume",
        )
    with ratio_col:
        render_spear_radar(
            player.name, rank, selected_stats, volume=False, tactical_ratio=tactical_ratio,
            comparison_label=selected_population_label,
            chart_key=f"analysis_radar_{player.player_id}_{selected_stats.league_id}_{filters['season']}_ratio",
        )
    if rank is None:
        st.caption("비교군 데이터를 불러오지 못한 축은 중립값(50)과 C 등급으로 표시됩니다.")
    render_twin_radar_sector_summaries(rank)

    competition_name = selected_stats.league_name or "선택 대회"
    with st.expander(f"📍 {filters['season']} · {competition_name} 공간·활동량", expanded=True):
        activity_col, heatmap_col = st.columns([1, 1.45])
        with activity_col:
            render_activity_ratio(
                player.player_id, player.name, tactical_ratio,
                force_type_b=False,
                rank=rank,
            )
        with heatmap_col:
            render_season_heatmap(
                player.player_id,
                player.name,
                tactical_ratio.get("heatmap_key") if tactical_ratio else None,
                tactical_ratio,
            )
    render_player_report(
        player, [filters["season"]], "전체", True, 0,
        show_activity=False, selected_league_id=selected_stats.league_id,
        comparison_scope=filters["comparison_scope"],
    )
    if not rank or (rank.eligible_players or 0) < 10:
        st.caption("해당 대회 표본이 부족하여 잠정 수치가 적용되었습니다.")


def _query_text(name: str, default: str = "") -> str:
    value = st.query_params.get(name, default)
    return str(value[0] if isinstance(value, list) else value)


def _query_scope(default: int = 5) -> int:
    try:
        value = int(_query_text("scope", str(default)))
        return value if value in {3, 5, 7} else default
    except ValueError:
        return default


def _route(page: str, **params: object) -> None:
    """Replace the URL state atomically when moving between app surfaces."""
    # Updating individual query parameters creates intermediate browser
    # history states.  In particular, a Detail URL could retain its player
    # context while the user was returning to the leaderboard.  Rebuilding
    # the full URL ensures each top-level page starts with only its own state.
    route_params = {"page": page}
    route_params.update({key: str(value) for key, value in params.items()})
    st.query_params.clear()
    st.query_params.from_dict(route_params)


def _queue_top_navigation(page: str) -> None:
    """Defer URL mutation until the next Streamlit run triggered by a click."""
    st.session_state["_pending_top_navigation"] = page


def render_leaderboard_page() -> None:
    """Page 1 — independent scouting-pool search and ranking list."""
    st.title("🔍 선수 검색 및 리더보드")
    st.caption("정적 M.E.S.S.I. 스냅샷으로 즉시 정렬되며, 선수 이름을 클릭하면 상세 리포트로 이동합니다.")
    league_options = {
        "통합 리그 범위": 47,
        "Premier League": 47, "LaLiga": 87, "Bundesliga": 54,
        "Serie A": 55, "Ligue 1": 53,
    }
    default_season = _query_text("season", "25/26")
    default_scope = _query_scope()
    default_league = _query_text("league_name", "통합 리그 범위")
    if default_league not in league_options:
        default_league = "통합 리그 범위"
    season_options = ["25/26", "24/25", "23/24", "22/23", "21/22"]
    # Keep the season switch separate from the dense search form.  Scouting
    # users should be able to move through historical leaderboards without
    # having to rediscover a small dropdown or press the general filter button.
    if "leaderboard_season_picker" not in st.session_state:
        st.session_state.leaderboard_season_picker = (
            default_season if default_season in season_options else season_options[0]
        )
    active_season = st.radio(
        "리더보드 시즌", season_options, horizontal=True,
        key="leaderboard_season_picker",
        help="선택 즉시 유럽대항전과 리그 리더보드를 해당 시즌 스냅샷으로 전환합니다.",
    )
    with st.form("leaderboard_filters", border=True):
        league_col, position_col, role_col, search_col, action_col = st.columns([1.4, 1, 1, 1.8, 0.9])
        with league_col:
            league_name = st.selectbox("리그", list(league_options), index=list(league_options).index(default_league))
        with position_col:
            position = st.selectbox("포지션", ["전체", "FW", "MF", "DF"], index=["전체", "FW", "MF", "DF"].index(_query_text("position", "전체")) if _query_text("position", "전체") in {"전체", "FW", "MF", "DF"} else 0)
        with role_col:
            role_options = ["전체", "정통형", "펄스 나인형"]
            saved_role = _query_text("role", "전체")
            saved_role = {"Type A": "정통형", "Type B": "펄스 나인형"}.get(saved_role, saved_role)
            role = st.selectbox("기본 롤", role_options, index=role_options.index(saved_role) if saved_role in role_options else 0)
        with search_col:
            query = st.text_input("선수명 검색", value=_query_text("search", ""), placeholder="예: Erling Haaland")
        with action_col:
            st.write("")
            submitted = st.form_submit_button("적용", use_container_width=True, type="primary")
        if submitted:
            # Deliberately omit the raw search phrase: GA only receives the
            # selected scouting dimensions, never arbitrary visitor input.
            queue_ga_event(
                "leaderboard_filter_apply",
                season=active_season,
                league=league_name,
                position=position,
                role=role,
            )
            _route("leaderboard", season=active_season, scope=default_scope, league_name=league_name, position=position, role=role, search=query.strip())
            st.rerun()

    active_league_name = _query_text("league_name", default_league)
    active_position = _query_text("position", "전체")
    active_role = _query_text("role", "전체")
    active_query = _query_text("search", "")
    if active_query:
        st.caption("검색 결과에서 선수를 직접 선택하면 상세 분석 리포트로 이동합니다.")
        candidate = select_player(active_query, "leaderboard_search_player_v2", "검색 결과")
        if candidate:
            _route(
                "detail", player=candidate.player_id, name=candidate.name,
                team=candidate.team_name or "", season=active_season, scope=default_scope,
            )
            st.rerun()
    european_competitions = {
        "유럽대항전 통합 (UCL · UEL · UECL)": EUROPEAN_LEADERBOARD_ID,
        "UEFA Champions League": 42,
        "UEFA Europa League": 73,
        "UEFA Conference League": 108,
    }
    european_name = st.selectbox(
        "유럽대항전 리더보드", list(european_competitions),
        key=f"european_leaderboard_{active_season}",
    )
    european_selected = render_spear_leaderboard(
        active_season, default_scope, european_competitions[european_name],
        active_position, active_role,
        section_title=f"🌍 {european_name} · M.E.S.S.I. 리더보드",
    )
    st.divider()
    league_selected = render_spear_leaderboard(
        active_season, default_scope, league_options.get(active_league_name, 47),
        active_position, active_role,
        section_title=f"🏆 {active_league_name} · 리그 M.E.S.S.I. 리더보드",
    )
    selected = european_selected or league_selected
    if selected:
        st.rerun()


def _render_role_overview(player, filters: dict[str, object], stats: DecisionMetrics, tactical_ratio, role: str = "auto") -> object:
    """Render the player's automatically classified, unmasked detail profile."""
    rank = cached_percentiles(
        player.player_id, str(filters["season"]), stats, 1.0, True, 0,
        int(filters["scope"]), role,
    )
    spear_score, spear_tier, spear_coverage = _spear_total(rank)
    if spear_score is None:
        st.warning("현재 역할 뷰의 M.E.S.S.I. 비교군이 준비되지 않았습니다.")
        return rank
    score_rank = getattr(rank, "spear_score_rank", None)
    score_percent = getattr(rank, "spear_score_top_percent", None)
    score_population = getattr(rank, "spear_score_eligible", 0) or rank.eligible_players
    rank_text = (
        f" ({score_rank}위 / {score_population}명 · 상위 {score_percent:.1f}%)"
        if score_rank and score_percent is not None and score_population else ""
    )
    # Keep the score visually centred in the page: a same-width right spacer
    # balances the portrait on the left instead of letting it push the score.
    portrait_col, score_col, score_spacer = st.columns([1.2, 6.6, 1.2])
    with portrait_col:
        # FotMob's player-image CDN uses the same stable player id used by
        # this report, so the portrait stays aligned when the user changes
        # season, competition, or role view.
        st.image(
            f"https://images.fotmob.com/image_resources/playerimages/{player.player_id}.png",
            width=104,
        )
    with score_col:
        st.markdown(
            "<div style='text-align: center; padding-top: 0.25rem;'>"
            f"<span style='font-size: 1.75rem; font-weight: 800;'>"
            f"{html.escape(player.name)} · [{spear_tier}-Tier] "
            f"M.E.S.S.I. {spear_score:.1f}/100{rank_text}</span>"
            "</div>",
            unsafe_allow_html=True,
        )
        st.markdown(
            "<div style='text-align: center; color: #a6a6a6; font-size: 0.86rem;'>"
            f"{comparison_population_criteria(stats.league_id, str(filters['season']), int(filters['scope']))}"
            "</div>",
            unsafe_allow_html=True,
        )
        st.markdown(
            "<div style='text-align: center; color: #a6a6a6; font-size: 0.86rem;'>"
            f"적용 롤: {getattr(rank, 'spear_role', role)} · 원천 데이터 {spear_coverage}/6개"
            "</div>",
            unsafe_allow_html=True,
        )
        st.markdown(
            "<div style='text-align: center; color: #94A3B8; font-size: 0.82rem;'>"
            "총점: 6개 섹터별 볼륨 50% + 비율 50%의 가중합"
            "</div>",
            unsafe_allow_html=True,
        )
    identities = spatial_identity_badges(tactical_ratio, force_type_b=False)
    for badge, text in identities:
        st.markdown(f"**[{badge}]** : {text}")
    footprint = activity_coverage_identity(rank)
    if footprint:
        badge, text = footprint
        st.markdown(f"**[{badge}]** : {text}")
    volume_col, ratio_col = st.columns(2)
    population_label = comparison_population_label(stats.league_id, int(filters["scope"]))
    with volume_col:
        render_spear_radar(
            player.name, rank, stats, volume=True, tactical_ratio=tactical_ratio,
            comparison_label=population_label,
            chart_key=f"detail_radar_{player.player_id}_{stats.league_id}_{filters['season']}_{role}_volume",
        )
    with ratio_col:
        render_spear_radar(
            player.name, rank, stats, volume=False, tactical_ratio=tactical_ratio,
            comparison_label=population_label,
            chart_key=f"detail_radar_{player.player_id}_{stats.league_id}_{filters['season']}_{role}_ratio",
        )
    render_twin_radar_sector_summaries(rank)
    return rank


def render_player_detail_page() -> None:
    """Page 2 — URL-addressable player detail report with role tabs."""
    st.title("📊 선수 상세 분석 리포트")
    season_options = ["25/26", "24/25", "23/24", "22/23", "21/22"]
    saved_season = _query_text("season", "25/26")
    with st.container(border=True):
        search_col, season_col = st.columns([2.2, 1])
        with search_col:
            detail_query = st.text_input(
                "선수명 검색", key="detail_player_query",
                placeholder="예: Antoine Semenyo",
                help="두 글자 이상 입력하면 후보 목록에서 선택할 수 있습니다.",
            )
        with season_col:
            detail_season = st.selectbox(
                "분석 시즌", season_options,
                index=season_options.index(saved_season) if saved_season in season_options else 0,
                key="detail_season_picker",
            )
        selected_candidate = (
            select_player(detail_query, "detail_search_player")
            if len(detail_query.strip()) >= 2 else None
        )
        if selected_candidate:
            _route(
                "detail", player=selected_candidate.player_id, name=selected_candidate.name,
                team=selected_candidate.team_name or "", season=detail_season, scope=_query_scope(),
            )
            st.rerun()
    player_id = _query_text("player")
    if not player_id:
        st.info("위 검색창에서 선수를 선택하거나, 리더보드에서 선수를 선택해 주세요.")
        return
    filters = {"season": _query_text("season", "25/26"), "scope": _query_scope()}
    player = PlayerCandidate(player_id, _query_text("name", "선수"), _query_text("team", ""))
    player = _resolve_static_player(player, filters["season"])
    try:
        sessions = extract_multi_season_metrics(cached_player_data(player.player_id))
    except (FotMobError, TypeError, ValueError, KeyError):
        # An archived cohort may still contain this player/season even after
        # the mutable player-history response has been removed upstream. The
        # extra structural exceptions are an upstream-response safety net: an
        # unavailable player must render a fallback notice, never a red page.
        sessions = {}
    session_rows = [(key, stats) for key, stats in sessions.items() if key.split("_", 1)[0] == filters["season"]]
    using_static_snapshot = False
    if not session_rows:
        session_rows = _static_session_rows(player.player_id, filters["season"])
        using_static_snapshot = bool(session_rows)
    if not session_rows:
        st.warning(f"{filters['season']} 시즌에 조회 가능한 대회 기록이 없습니다.")
        return
    selected_index = st.selectbox(
        "대회", range(len(session_rows)),
        format_func=lambda index: session_rows[index][1].league_name or "대회 정보 없음",
        key=f"detail_competition_{player.player_id}_{filters['season']}",
    )
    _, selected_stats = session_rows[selected_index]
    emit_ga_event_once(
        "player_report_open",
        f"{player.player_id}:{filters['season']}:{selected_stats.league_id}",
        player_name=player.name,
        season=filters["season"],
        competition=selected_stats.league_name or "unknown",
    )
    tactical_ratio = get_tactical_ratio_for_session(player.player_id, selected_stats.league_name or "", str(filters["season"]))
    if using_static_snapshot:
        st.info(
            "이 리포트는 현재 선수 이력 API에서 제외된 과거 시즌을 정적 코호트 스냅샷으로 복원했습니다. "
            "상대평가는 해당 대회·시즌 스냅샷을 기준으로 계산됩니다."
        )
    st.caption("역할은 해당 대회·시즌의 박스 점유율을 기준으로 자동 분류됩니다. 수동 탭 전환은 점수나 역할 표기를 바꾸지 않습니다.")
    rank = _render_role_overview(player, filters, selected_stats, tactical_ratio)
    if using_static_snapshot:
        st.caption("과거 원본 선수 이력 API가 없는 시즌입니다. 세부 상대평가 바는 생략하고, 적재된 공간·히트맵 데이터를 표시합니다.")
    else:
        st.divider()
        st.subheader("세부 상대평가")
        render_player_report(
            player, [str(filters["season"])], "전체", True, 0,
            show_activity=False, selected_league_id=selected_stats.league_id,
            comparison_scope=int(filters["scope"]),
        )
    with st.expander(f"📍 {filters['season']} · {selected_stats.league_name or '선택 대회'} 공간·활동량", expanded=True):
        activity_col, heatmap_col = st.columns([1, 1.45])
        with activity_col:
            render_activity_ratio(player.player_id, player.name, tactical_ratio, rank=rank)
        with heatmap_col:
            render_season_heatmap(player.player_id, player.name, tactical_ratio.get("heatmap_key") if tactical_ratio else None, tactical_ratio)


def render_head_to_head_page() -> None:
    """Page 3 — dedicated player-versus-player analysis."""
    st.title("⚔️ 비교 분석 집중 페이지")
    st.caption("양쪽 선수의 시즌과 대회를 독립적으로 선택합니다. 백분위는 각자 선택한 대회의 동일 조건 모집단을 기준으로 계산됩니다.")
    if "h2h_filters" not in st.session_state:
        st.session_state.h2h_filters = None
    st.caption("선수명을 2자 이상 입력하면 후보 드롭다운에서 바로 선택할 수 있습니다.")
    with st.container(border=True):
        left_season_col, left_col, right_season_col, right_col, scope_col, action_col = st.columns([1, 2, 1, 2, 1, 1])
        with left_season_col:
            left_season = st.selectbox("A 시즌", ["25/26", "24/25", "23/24", "22/23", "21/22"], key="h2h_left_season")
        with left_col:
            left_query = st.text_input("A 선수", key="h2h_left_query", placeholder="예: Lionel Messi")
            left_player = (
                select_player(left_query, "h2h_left_player", "A 선수 후보")
                if len(left_query.strip()) >= 2 else None
            )
        with right_season_col:
            right_season = st.selectbox("B 시즌", ["25/26", "24/25", "23/24", "22/23", "21/22"], key="h2h_right_season")
        with right_col:
            right_query = st.text_input("B 선수", key="h2h_right_query", placeholder="예: Lamine Yamal")
            right_player = (
                select_player(right_query, "h2h_right_player", "B 선수 후보")
                if len(right_query.strip()) >= 2 else None
            )
        with scope_col:
            scope = st.selectbox("비교 범위", [3, 5, 7], index=1, key="h2h_scope")
        with action_col:
            st.write("")
            st.write("")
            submit = st.button(
                "비교 시작", use_container_width=True, type="primary",
                disabled=left_player is None or right_player is None,
                key="h2h_submit",
            )
        if submit and left_player and right_player:
            st.session_state.h2h_filters = {
                "left_season": left_season,
                "right_season": right_season,
                "scope": scope,
                "left_id": left_player.player_id,
                "left_name": left_player.name,
                "left_team": left_player.team_name or "",
                "right_id": right_player.player_id,
                "right_name": right_player.name,
                "right_team": right_player.team_name or "",
            }
            emit_ga_event(
                "player_comparison_open",
                left_player=left_player.name,
                left_season=left_season,
                right_player=right_player.name,
                right_season=right_season,
                comparison_scope=scope,
            )
    filters = st.session_state.h2h_filters
    # Drop the pre-autocomplete form state from an already-open browser
    # session after deployment, so legacy {left, right} values cannot cause a
    # KeyError before the user makes a new selection.
    required_filter_keys = {"left_id", "right_id", "left_season", "right_season", "scope"}
    if filters and not required_filter_keys.issubset(filters):
        st.session_state.h2h_filters = None
        filters = None
    if not filters:
        return
    left_player = PlayerCandidate(filters["left_id"], filters["left_name"], filters.get("left_team") or None)
    right_player = PlayerCandidate(filters["right_id"], filters["right_name"], filters.get("right_team") or None)
    left_player = _resolve_static_player(left_player, str(filters["left_season"]))
    right_player = _resolve_static_player(right_player, str(filters["right_season"]))
    try:
        left_sessions = extract_multi_season_metrics(cached_player_data(left_player.player_id))
    except (FotMobError, TypeError, ValueError, KeyError) as exc:
        left_sessions = {}
        st.caption(f"A 선수의 현재 이력 API를 읽지 못해 정적 시즌 스냅샷을 확인합니다: {exc}")
    try:
        right_sessions = extract_multi_season_metrics(cached_player_data(right_player.player_id))
    except (FotMobError, TypeError, ValueError, KeyError) as exc:
        right_sessions = {}
        st.caption(f"B 선수의 현재 이력 API를 읽지 못해 정적 시즌 스냅샷을 확인합니다: {exc}")
    left_candidates = [
        (key, stats) for key, stats in left_sessions.items()
        if key.split("_", 1)[0] == filters["left_season"]
    ]
    right_candidates = [
        (key, stats) for key, stats in right_sessions.items()
        if key.split("_", 1)[0] == filters["right_season"]
    ]
    if not left_candidates:
        left_candidates = _static_session_rows(left_player.player_id, filters["left_season"])
    if not right_candidates:
        right_candidates = _static_session_rows(right_player.player_id, filters["right_season"])
    if not left_candidates or not right_candidates:
        missing = "A 선수" if not left_candidates else "B 선수"
        missing_season = filters["left_season"] if not left_candidates else filters["right_season"]
        st.warning(f"{missing}의 {missing_season} 시즌 대회 세션을 찾지 못했습니다.")
        return
    left_selector, right_selector = st.columns(2)
    with left_selector:
        left_index = st.selectbox(
            "A 선수 대회", range(len(left_candidates)), key="h2h_left_competition",
            format_func=lambda index: left_candidates[index][1].league_name or "대회 정보 없음",
        )
    with right_selector:
        right_index = st.selectbox(
            "B 선수 대회", range(len(right_candidates)), key="h2h_right_competition",
            format_func=lambda index: right_candidates[index][1].league_name or "대회 정보 없음",
        )
    _, left_stats = left_candidates[left_index]
    _, right_stats = right_candidates[right_index]
    left_season = str(filters["left_season"])
    right_season = str(filters["right_season"])
    scope = int(filters["scope"])
    left_rank = cached_percentiles(left_player.player_id, left_season, left_stats, 1.0, True, 0, scope)
    right_rank = cached_percentiles(right_player.player_id, right_season, right_stats, 1.0, True, 0, scope)
    left_ratio = get_tactical_ratio_for_session(left_player.player_id, left_stats.league_name or "", left_season)
    right_ratio = get_tactical_ratio_for_session(right_player.player_id, right_stats.league_name or "", right_season)
    render_head_to_head_profile_headers(
        left_player.name, left_rank, left_stats, left_ratio, left_season,
        right_player.name, right_rank, right_stats, right_ratio, right_season,
        scope,
    )
    render_spear_head_to_head(left_player.name, left_rank, right_player.name, right_rank)
    render_head_to_head_cards(left_player.name, left_rank, left_stats, left_ratio, right_player.name, right_rank, right_stats, right_ratio)


def render_messi_about_page() -> None:
    """Explain the M.E.S.S.I. framework in a scouting-friendly Q&A format."""
    st.title("❓ M.E.S.S.I. 스탯이란?")
    st.caption("ver 2.0 · 공간 점유와 전술적 역할을 함께 반영하는 현대 공격수 평가 프레임워크")
    st.info(
        "M.E.S.S.I.는 단순 득점 순위가 아니라, 선수가 어디에서 움직이고 어떤 역할로 "
        "공격에 기여하는지를 6개 축과 역할별 동적 가중치로 해석합니다."
    )

    questions = [
        (
            "Q1. 왜 기존 공격 스탯만으로는 부족한가요?",
            "정통 타겟맨과 2선으로 내려와 연계·공간 창출을 맡는 펄스 나인은 박스 점유와 "
            "슈팅 위치가 다릅니다. 같은 기준으로 줄세우면 펄스 나인형 선수가 '자료 부족'이나 "
            "저효율로 과소평가될 수 있어, M.E.S.S.I.는 먼저 전술적 역할을 식별합니다.",
        ),
        (
            "Q2. M.E.S.S.I.는 무엇의 약자인가요?",
            "\n".join([
                "- **M — Micro-zoning:** 박스 안 골드·실버·브론즈 존과 활동 위치 분석",
                "- **E — Efficiency:** 박스 타격과 득점 효율",
                "- **S — Space:** 핵심 활동 반경(CCA)과 5-Lane 공간 활용",
                "- **S — Striking:** 위험 구역 파괴와 박스 밖 슈팅력",
                "- **I — Intensity:** 지상·공중 경합 및 물리적 강도",
            ]),
        ),
        (
            "Q3. 비교군은 어떻게 구성되나요?",
            "선택한 시즌·대회 안에서 충분한 출전 시간과 공격 기여가 확인된 선수만 포함합니다. "
            "현재 기준은 리그 최소 450분, 컵대회 최소 180분이며, 화면의 각 리더보드·차트에 "
            "적용된 xG 기준과 모집단 수를 함께 표시합니다. 따라서 등수와 백분위는 항상 해당 "
            "화면에 명시된 동일 코호트 안에서 해석해야 합니다.",
        ),
        (
            "Q4. 공간 데이터와 히트맵은 어떻게 해석하나요?",
            "시즌 활동 좌표를 정적 데이터로 저장한 뒤, 반복 밀도가 높은 핵심 활동 반경(CCA)을 계산합니다. "
            "CCA는 KDE(커널 밀도 추정)에서 상위 50% 밀도 영역을 기반으로 하며, 일회성 위치보다 "
            "지속적으로 점유한 공간을 우선 반영합니다. 3-Zone은 전진 깊이, 5-Lane은 횡적 움직임과 "
            "좌우 밸런스를 보여줍니다.",
        ),
        (
            "Q5. 박스 내 마이크로 조닝은 무엇인가요?",
            "전체 활동 좌표 중 박스 안 좌표의 비율(Box Ratio)을 구하고, 박스 안을 골드 존(6야드), "
            "실버 존(중앙 박스), 브론즈 존(와이드 박스)으로 나눕니다. 골드 존 비중은 문전 침투, "
            "실버 존은 중앙 컷백·세컨드볼 대응, 브론즈 존은 실제 측면 활동 경향을 해석하는 근거입니다.",
        ),
        (
            "Q6. 6개 평가 축은 무엇을 보나요?",
            "\n".join([
                "1. **박스 타격 효율** — 박스 안 생산성과 유리한 마무리 구역 점유",
                "2. **위험 구역 파괴력** — 전진·돌파로 수비 블록을 흔드는 능력",
                "3. **박스 밖 슈팅력** — 외곽 타격의 볼륨과 순도",
                "4. **공간 장악력** — CCA, 위험 구역 점유, 5-Lane 활용",
                "5. **지상 경합 능력** — 소유권 방어·압박 강도",
                "6. **공중볼 장악력** — 제공권과 롱볼·크로스 대응",
            ]),
        ),
        (
            "Q7. Type A와 Type B는 어떻게 달라지나요?",
            "**Type A(정통 9번)**와 **Type B(펄스 나인)**는 Box Ratio 15%를 기준으로 한 활동 성향 분류입니다. "
            "두 유형 모두 박스 타격 효율을 포함한 동일한 6개 팩터와 동일 가중치로 평가됩니다. 따라서 Type B의 "
            "박스 침투·마무리 데이터도 마스킹하거나 총점에서 제외하지 않습니다.",
        ),
        (
            "Q8. M.E.S.S.I. 점수와 티어는 어떻게 읽나요?",
            "모든 원본 지표는 선택 시즌·대회·비교군 안에서 백분위 점수(상위 0% = 100점)로 정규화합니다. "
            "그 뒤 6개 섹터 점수를 가중합해 0~100점의 M.E.S.S.I. 점수를 만들고, 이 점수로 등수·상위 %·티어를 "
            "동시에 산출합니다. S(95+), A(85~94), B(65~84), C(35~64), D(34 이하) 티어를 사용합니다.",
        ),
        (
            "Q9. 볼륨과 비율은 총점에 어떻게 반영되나요?",
            "볼륨 레이더는 얼마나 자주 해당 상황에 관여했는지, 비율 레이더는 그 관여가 얼마나 효율적인지 보여줍니다. "
            "두 값을 따로 설명하는 데 그치지 않고, 각 섹터에서 **볼륨 점수 50% + 비율 점수 50%**로 합산합니다. "
            "따라서 적은 시도에서 나온 높은 효율만으로 총점이 과대평가되거나, 시도량만 많은 저효율 선수가 고평가되는 일을 막습니다.",
        ),
        (
            "Q10. 6개 섹터의 볼륨 × 비율 짝은 무엇인가요?",
            "\n".join([
                "1. **박스 밖 슈팅력** — 박스 밖 슈팅 시도 × 박스 밖 킥 순도",
                "2. **박스 타격 효율** — 박스 안 타격 시도 × 박스 타격 효율",
                "3. **위험 구역 파괴력** — 드리블 돌파 시도 × 위험 구역 파괴력",
                "4. **공중볼 장악력** — 공중볼 경합 시도 × 공중볼 장악력",
                "5. **지상 경합 능력** — 지상 경합 시도 × 지상 경합 능력",
                "6. **공간 장악력** — 핵심 활동 반경(CCA) × 위험 구역 점유 효율",
            ]),
        ),
        (
            "Q11. 6개 섹터는 총점에서 같은 비중인가요?",
            "아닙니다. 각 섹터 안에서는 볼륨과 비율을 50:50으로 동등하게 반영하지만, 최종 총점은 공격수 역할에 맞게 "
            "박스 타격 효율 30%, 박스 밖 슈팅력 20%, 위험 구역 파괴력 15%, 공간 장악력 15%, 공중볼 장악력 10%, "
            "지상 경합 능력 10%의 비중으로 합산합니다.",
        ),
        (
            "Q12. 자료 부족이나 역할 미스매치는 어떻게 처리하나요?",
            "공간·마이크로 조닝 표본이 부족하면 해당 사실을 UI에 표시하고 임의의 평균값이나 보정값으로 숨기지 않습니다. "
            "Type A·B 역할 표기는 전술 성향을 설명할 뿐, 박스 타격 수치나 총점 가중치를 마스킹·보정하지 않습니다.",
        ),
    ]
    for index, (question, answer) in enumerate(questions):
        with st.expander(question, expanded=index < 2):
            st.markdown(answer)


def main() -> None:
    """URL-addressable three-page navigation for the scouting workflow."""
    pages = {
        "leaderboard": "🔍 리더보드",
        "detail": "📊 선수 상세 분석",
        "compare": "⚔️ 비교 분석",
        "about": "❓ M.E.S.S.I. 스탯이란?",
    }
    current = _query_text("page", "leaderboard")
    if current not in pages:
        current = "leaderboard"

    # Button callbacks run before the script body.  Apply the queued page
    # switch here so a Detail-page widget cannot interfere with the URL update
    # that returns the user to the leaderboard.
    requested_page = st.session_state.pop("_pending_top_navigation", None)
    if requested_page in pages and requested_page != current:
        _route(requested_page)
        st.rerun()

    # This tag executes in the app document and keeps page views deduplicated
    # across ordinary Streamlit widget reruns.  Queued events are emitted only
    # after the target page URL has become active.
    initialize_ga4_tracking()
    emit_queued_ga_event()

    # Top navigation keeps the three product surfaces visible without taking
    # permanent horizontal space from the scouting visuals as a sidebar does.
    with st.container(border=True):
        brand_col, leaderboard_col, detail_col, compare_col, about_col = st.columns([1.05, 0.95, 1.1, 0.95, 1.55])
        with brand_col:
            st.markdown("#### M.E.S.S.I.")
            st.caption("ver 2.0")
        for column, page, label in (
            (leaderboard_col, "leaderboard", pages["leaderboard"]),
            (detail_col, "detail", pages["detail"]),
            (compare_col, "compare", pages["compare"]),
            (about_col, "about", pages["about"]),
        ):
            with column:
                st.button(
                    label,
                    key=f"top_navigation_{page}",
                    use_container_width=True,
                    type="primary" if current == page else "secondary",
                    disabled=current == page,
                    on_click=_queue_top_navigation,
                    args=(page,),
                )
    st.divider()
    if current == "leaderboard":
        render_leaderboard_page()
    elif current == "detail":
        render_player_detail_page()
    elif current == "compare":
        render_head_to_head_page()
    else:
        render_messi_about_page()

if __name__ == "__main__":
    main()
