import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import numpy as np

from fotmob_client import FotMobError, fetch_player_multi_season_data, search_players
from metrics import DecisionMetrics, extract_multi_season_metrics
from rankings import (
    calculate_league_percentiles,
    get_league_metric_medians,
    get_tactical_matrix,
    get_top_leagues_shot_quality,
)
from tactical_ratio import get_heatmap_points, get_tactical_ratio, get_tactical_ratio_by_name, get_tactical_ratio_for_session

st.set_page_config(page_title="Striker Decision Quality", page_icon="⚽", layout="wide")

@st.cache_data(ttl=3600, show_spinner=False)
def cached_search(term: str):
    return search_players(term)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_player_data(player_id: str):
    return fetch_player_multi_season_data(player_id)

@st.cache_data(ttl=3600, show_spinner=False)
def cached_percentiles(
    player_id: str, season: str, metrics: DecisionMetrics, min_xg: float,
    restrict_to_forwards: bool, minimum_final_third_ratio: int,
):
    return calculate_league_percentiles(
        player_id, season, metrics, minimum_xg=min_xg,
        restrict_to_forwards=restrict_to_forwards,
        minimum_final_third_ratio=minimum_final_third_ratio,
    )

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
) -> pd.DataFrame:
    return get_tactical_matrix(league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)


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
    is_dark = st.get_option("theme.base") == "dark"
    figure.update_layout(
        title=title, height=440, margin={"l": 55, "r": 55, "t": 55, "b": 35},
        paper_bgcolor="rgba(0,0,0,0)",
        polar={"bgcolor": "rgba(0,0,0,0)", "radialaxis": {"range": [0, 100], "tickvals": [0, 25, 50, 75, 100], "gridcolor": "#606060", "color": "#BBBBBB"}},
        font={"color": "#EEEEEE" if is_dark else "#222222"},
        showlegend=len(profiles) > 1,
        legend={"orientation": "h", "y": -0.08, "x": 0.5, "xanchor": "center"},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})


SPEAR_FACTOR_AXES = [
    ("박스 안 결정력", "in_box_finishing_top_percent"),
    ("전체 슈팅 파괴력", "shot_quality_top_percent"),
    ("득점 기회 포착 (xG/90)", "xg_per90_top_percent"),
    ("지상 경합 마진", "duel_margin_per90_top_percent"),
    ("공중볼 장악 마진", "aerial_margin_per90_top_percent"),
    ("드리블 돌파 마진", "dribble_margin_per90_top_percent"),
]


def render_spear_factor_radar(player_name: str, rank) -> None:
    """Six attack-only percentile factors used by the S.P.E.A.R. model."""
    labels = [label for label, _ in SPEAR_FACTOR_AXES]
    player_values = [_radar_score(getattr(rank, attr, None) if rank else None) for _, attr in SPEAR_FACTOR_AXES]
    # Percentile 50 is the median of exactly the same league/position cohort.
    average_values = [50.0] * len(labels)
    figure = go.Figure()
    for name, values, color, fill in (
        (player_name, player_values, "#22C55E", "rgba(34,197,94,0.28)"),
        ("동일 리그·포지션 평균", average_values, "#94A3B8", "rgba(148,163,184,0.16)"),
    ):
        figure.add_trace(go.Scatterpolar(
            r=values + [values[0]], theta=labels + [labels[0]],
            mode="lines+markers", name=name, fill="toself", fillcolor=fill,
            line={"color": color, "width": 2}, marker={"color": color, "size": 6},
        ))
    figure.update_layout(
        title="S.P.E.A.R. 6대 공격 팩터 · 선수 vs 동일 리그·포지션 평균",
        height=420, margin={"l": 35, "r": 35, "t": 55, "b": 25},
        paper_bgcolor="rgba(0,0,0,0)",
        polar={"bgcolor": "rgba(0,0,0,0)", "radialaxis": {"range": [0, 100], "tickvals": [0, 25, 50, 75, 100], "visible": True}},
        legend={"orientation": "h", "y": -0.12, "x": 0.5, "xanchor": "center"},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})


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


def build_tactical_summary(rank, tactical_ratio: dict[str, object] | None) -> str:
    """Combine the weakest/strongest S.P.E.A.R. factors with the 3-Zone role."""
    factor_labels = {
        "in_box_finishing_top_percent": "박스 안 결정력",
        "shot_quality_top_percent": "슈팅 파괴력",
        "xg_per90_top_percent": "위치 선정 및 오프더볼",
        "duel_margin_per90_top_percent": "지상 경합 능력",
        "aerial_margin_per90_top_percent": "공중볼 장악력",
        "dribble_margin_per90_top_percent": "자력 전진 및 돌파 능력",
    }
    available = [
        (attr, _radar_score(getattr(rank, attr, None)))
        for _, attr in SPEAR_FACTOR_AXES
        if rank is not None and getattr(rank, attr, None) is not None
    ]
    def particle(label: str) -> str:
        codepoint = ord(label[-1])
        return "이" if 0xAC00 <= codepoint <= 0xD7A3 and (codepoint - 0xAC00) % 28 else "가"

    weak_labels = [factor_labels[attr] for attr, score in available if score < 40.0]
    strong_labels = [factor_labels[attr] for attr, score in available if score > 60.0]
    if weak_labels:
        joined = ", ".join(weak_labels)
        weakness = f"{joined}{particle(joined)} 심각하게 떨어져 전반적으로 고전하는 편이다."
    else:
        weakness = "뚜렷한 약점 없이 전반적으로 안정적인 기량을 보여준다."
    if strong_labels:
        joined = ", ".join(strong_labels)
        strength = f"{joined}{particle(joined)} 돋보이는 "
    else:
        strength = "뚜렷하게 압도적인 강점은 없으나 균형을 갖춘 "

    if not tactical_ratio:
        return f"{weakness} {strength}활동 반경 데이터가 갱신되는 중인 공격수."
    in_box = float(tactical_ratio.get("in_box_ratio", 0.0))
    mid = float(tactical_ratio.get("mid_third_ratio", 0.0))
    role = "전술적 움직임 위주의" if mid >= 40.0 else "득점에 집중하는"
    player_type = (
        "정통 경합형 포워드" if in_box >= 25.0
        else "하이브리드형 포워드" if in_box >= 20.0
        else "경합 회피형 피니셔"
    )
    return f"{weakness} {strength}{role} {player_type}."


def render_season_heatmap(player_id: str, player_name: str, heatmap_key: str | None = None) -> None:
    points = get_heatmap_points(player_id, heatmap_key)
    st.markdown("#### 📍 시즌 활동 히트맵")
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
        figure.add_shape(type="rect", x0=x0, y0=y0, x1=x1, y1=y1, line=line, fillcolor="rgba(34,197,94,0.06)" if x0 == 83 else "rgba(0,0,0,0)")
    figure.add_shape(type="line", x0=50, y0=0, x1=50, y1=100, line=line)
    figure.add_shape(type="circle", x0=43, y0=43, x1=57, y1=57, line=line)
    figure.update_layout(height=390, margin={"l": 10, "r": 10, "t": 15, "b": 15}, paper_bgcolor="rgba(0,0,0,0)", plot_bgcolor="#4d704c", xaxis={"range": [0, 100], "visible": False, "fixedrange": True}, yaxis={"range": [0, 100], "visible": False, "scaleanchor": "x", "scaleratio": 0.68, "fixedrange": True}, showlegend=False)
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})


def render_activity_ratio(player_id: str, player_name: str, ratio: dict[str, object] | None = None) -> None:
    """Render the ETL-backed mid/final-third activity split without live API calls."""
    ratio = ratio or get_tactical_ratio(player_id) or get_tactical_ratio_by_name(player_name)
    st.markdown("#### 🏃 주요 활동 반경")
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

def render_tactical_matrix(matrix: pd.DataFrame, selected_player_id: str, selected_name: str) -> None:
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
        x=background["net_progression_per90"], y=background["in_box_xgot_minus_xg"], mode="markers",
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
        (x_median, x_range[1], y_median, y_range[1], "rgba(89, 161, 79, 0.10)", "컴플리트 포워드"),
        (x_range[0], x_median, y_range[0], y_median, "rgba(225, 87, 89, 0.07)", "전술적 보완 필요"),
        (x_median, x_range[1], y_range[0], y_median, "rgba(242, 142, 43, 0.08)", "딥라잉 포워드"),
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
        title="전술 사분면 매트릭스",
        xaxis={"title": "Net Progression / 90분", "range": x_range, "zeroline": True},
        yaxis={"title": "In-Box xGOT - xG", "range": y_range, "zeroline": True},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displaylogo": False})

def get_gradient_color(percentile: float) -> str:
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

    safe_player = player_value if player_value is not None else 0.0
    safe_median = median_value if median_value is not None else 0.0

    if top_percent is not None:
        # Rank data is authoritative when it exists: use the same percentile
        # scale for the marker and its colour.
        player_pos = 100.0 - top_percent
        color_pos = player_pos
        median_pos = 50.0 if median_value is not None else None
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
            if median_value is not None else None
        )
        color_pos = player_pos

    dynamic_color = get_gradient_color(color_pos)
    rank_label = (
        f"{rank_val}위 / {total_players}명 · 상위 {top_percent}%"
        if rank_val is not None and top_percent is not None else ""
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
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})

    median_label = f"◆ 중앙값 {safe_median:.2f}{suffix}" if median_value is not None else "중앙값 없음"
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

def select_player(query: str, key: str):
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
    return candidates[st.selectbox("선수 선택", range(len(candidates)), format_func=lambda i: labels[i], key=key)]

def render_player_report(
    player, selected_seasons: list[str], competition_filter: str,
    restrict_to_forwards: bool, minimum_final_third_ratio: int, show_activity: bool = True,
    selected_league_id: int | None = None,
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
                )
            except Exception:
                rank = None

            render_radar_chart(
                [make_radar_profile(f"{player.name} · {season_str}", rank)],
                "🕸️ 전술 프로필 · 전문 공격수 백분위",
            )

            try:
                matrix = cached_tactical_matrix(stats.league_id, season_name, restrict_to_forwards, minimum_final_third_ratio)
                if str(player.player_id) not in matrix.get("player_id", pd.Series(dtype=str)).astype(str).tolist():
                    matrix = pd.concat([matrix, pd.DataFrame([{
                        "player_id": str(player.player_id), "player_name": player.name,
                        "team_name": stats.team_name or "", 
                        "net_progression_per90": net_progression,  # 수정한 지역 변수 사용
                        "in_box_xgot_minus_xg": stats.in_box_finishing,
                    }])], ignore_index=True)
                st.caption("📊 전술 사분면 매트릭스")
                render_tactical_matrix(matrix, player.player_id, player.name)
            except Exception:
                st.caption("사분면 매트릭스를 구성할 비교 집단 데이터가 없습니다.")

            st.divider()

            def get_rank(attr):
                return getattr(rank, attr, None) if rank else None

            progression_eligible = get_rank("progression_eligible") or 0
            cohort_label = "전문 공격수·윙어·공격형 미드필더" if restrict_to_forwards else "포지션 전체"
            with st.expander(
                f"🏃 순수 전진 기여도 상대평가 · {cohort_label} · 볼 경합 성공 1회 이상 {progression_eligible}명",
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
                with st.expander(f"🎯 결정력 상대평가 · 동일 대회 xG {minimum_xg} 이상 {rank.eligible_players}명", expanded=True):
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
    st.caption("3-Zone 활동 비율 · S.P.E.A.R. · 동일 리그 비교 리포트")
    if "v32_filters" not in st.session_state:
        st.session_state.v32_filters = None

    with st.form("global_analysis_filters", border=True):
        position_col, season_col, player_col, action_col = st.columns([1.25, 1.4, 2.2, 1.0])
        with position_col:
            positions = st.multiselect("포지션", ["FW (ST/CF)", "MF", "DF", "GK"], default=["FW (ST/CF)"])
        with season_col:
            season = st.selectbox("시즌", ["25/26", "24/25", "23/24", "22/23", "21/22"], index=0)
        with player_col:
            query = st.text_input("선수명 검색", placeholder="예: Erling Haaland")
        with action_col:
            st.write("")
            submitted = st.form_submit_button("🔍 데이터 분석", use_container_width=True, type="primary")
        if submitted:
            st.session_state.v32_filters = {"positions": positions, "season": season, "query": query.strip()}

    filters = st.session_state.v32_filters
    if not filters:
        st.info("포지션·시즌·선수명을 설정한 뒤 **데이터 분석**을 눌러주세요.")
        return
    if not filters["query"]:
        st.info("선수명을 입력하면 5대 리그 검색 결과에서 선수를 선택할 수 있습니다.")
        return

    player = select_player(filters["query"], "v32_selected_player")
    if not player:
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
    st.divider()
    tactical_ratio = get_tactical_ratio_for_session(player.player_id, selected_stats.league_name or "", filters["season"])
    rank = spear_rank_for_session(player, filters["season"], selected_stats, "FW (ST/CF)" in filters["positions"])
    tactical_summary = build_tactical_summary(rank, tactical_ratio)
    title_col, help_col = st.columns([4, 1])
    with title_col:
        st.subheader(f"👑 {player.name}  ·  🏷️ S.P.E.A.R. 동기화 대기  (—/100)")
        st.markdown(f"💡 **전술 요약:** {tactical_summary}")
    with help_col:
        with st.popover("❓ 점수 산출 방식"):
            st.markdown("**S.P.E.A.R.**  \\n슈팅 50% · 수비 부수기 30% · 위치 선정 20%")
            st.caption("1,000분 이상 전문 공격수의 Z-점수를 0~100 점수로 변환합니다.")
            st.markdown("S 🌟 95+ · A 🔴 85~94 · B 🔵 65~84 · C 🟢 35~64 · D ⚪ 34 이하")
    render_activity_ratio(player.player_id, player.name, tactical_ratio)
    radar_col, ratio_col = st.columns(2)
    with radar_col:
        render_spear_factor_radar(player.name, rank)
        if rank is None:
            st.caption("비교군 데이터를 불러오지 못한 축은 중립값(50)으로 표시됩니다.")
    with ratio_col:
        render_season_heatmap(player.player_id, player.name, tactical_ratio.get("heatmap_key") if tactical_ratio else None)
    render_player_report(
        player, [filters["season"]], "전체", "FW (ST/CF)" in filters["positions"], 0,
        show_activity=False, selected_league_id=selected_stats.league_id,
    )
    if (getattr(selected_stats, "minutes_played", 0) or 0) < 1000 or not rank or (rank.eligible_players or 0) < 10:
        st.caption("해당 대회 표본이 부족하여 잠정 수치가 적용되었습니다.")


def main() -> None:
    render_v32_analysis_center()
    return
    st.title("🎯 스트라이커 전술 스카우팅 리포트")
    st.caption("2차 스탯 기반 선수 기여도 분석 · 동일 포맷의 1:1 비교 지원")
    selected_seasons = st.multiselect("📊 조회할 시즌", ["25/26", "24/25", "23/24", "22/23", "21/22"], default=["25/26", "24/25"])
    competition_filter = st.radio("대회", ["전체", "리그", "챔피언스리그"], horizontal=True)
    compare_mode = st.toggle("선수 비교 모드")
    restrict_to_forwards = st.toggle(
        "전문 공격수·윙어·공격형 미드필더 비교군만 사용",
        value=True,
        help="켜면 Striker, Forward, Attacker, CF, 좌·우 윙어, 공격형 미드필더만 비교합니다. 끄면 동일 대회에서 볼 경합 성공 1회 이상인 모든 포지션을 비교합니다.",
    )
    minimum_final_third_ratio = st.slider(
        "파이널써드 활동 비중 최소 조건 (%)",
        min_value=0, max_value=100, value=0,
        help="선택한 비율 이상인 선수만 모든 상대평가의 비교군에 포함합니다.",
    )

    if compare_mode:
        left, right = st.columns(2)
        with left:
            left_player = select_player(st.text_input("왼쪽 선수 검색", key="left_query", placeholder="예: Francisco Panichelli"), "left_player")
        with right:
            right_player = select_player(st.text_input("오른쪽 선수 검색", key="right_query", placeholder="예: Robert Lewandowski"), "right_player")
        if left_player and right_player:
            profiles = [
                build_radar_profile(left_player, selected_seasons, competition_filter, restrict_to_forwards, minimum_final_third_ratio),
                build_radar_profile(right_player, selected_seasons, competition_filter, restrict_to_forwards, minimum_final_third_ratio),
            ]
            render_radar_chart([profile for profile in profiles if profile], "🕸️ 전술 프로필 비교 · 전문 공격수 백분위")
            st.divider()
            left, right = st.columns(2)
            with left:
                render_player_report(left_player, selected_seasons, competition_filter, restrict_to_forwards, minimum_final_third_ratio)
            with right:
                render_player_report(right_player, selected_seasons, competition_filter, restrict_to_forwards, minimum_final_third_ratio)
        return

    player = select_player(st.text_input("🔍 선수 이름 검색", placeholder="예: Erling Haaland, Lamine Yamal"), "single_player")
    if player:
        st.divider()
        render_player_report(player, selected_seasons, competition_filter, restrict_to_forwards, minimum_final_third_ratio)
        return

    st.divider()
    st.subheader("🏆 25/26 시즌 박스 안 순수 결정력 (xGOT-xG) Top 20")
    try:
        ranking_tables = cached_top20(minimum_final_third_ratio)
        if ranking_tables and not ranking_tables.get("통합", pd.DataFrame()).empty:
            tabs = st.tabs(["통합", "Premier League", "LaLiga", "Bundesliga", "Serie A", "Champions League"])
            for tab, name in zip(tabs, ["통합", "Premier League", "LaLiga", "Bundesliga", "Serie A", "Champions League"]):
                with tab:
                    st.dataframe(style_dataframe(ranking_tables.get(name, pd.DataFrame())), use_container_width=True, height=735)
    except Exception as exc:
        st.info(f"랭킹 데이터를 불러오지 못했습니다: {exc}")

if __name__ == "__main__":
    main()
