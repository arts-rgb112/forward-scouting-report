import streamlit as st
import pandas as pd
import plotly.graph_objects as go

from fotmob_client import FotMobError, fetch_player_multi_season_data, search_players
from metrics import DecisionMetrics, extract_multi_season_metrics
from rankings import (
    calculate_league_percentiles,
    get_league_metric_medians,
    get_tactical_matrix,
    get_top_leagues_shot_quality,
)

st.set_page_config(page_title="Striker Decision Quality", page_icon="⚽", layout="centered")


@st.cache_data(ttl=3600, show_spinner=False)
def cached_search(term: str):
    return search_players(term)


@st.cache_data(ttl=3600, show_spinner=False)
def cached_player_data(player_id: str):
    return fetch_player_multi_season_data(player_id)


@st.cache_data(ttl=3600, show_spinner=False)
def cached_percentiles(player_id: str, season: str, metrics: DecisionMetrics, min_xg: float):
    return calculate_league_percentiles(player_id, season, metrics, minimum_xg=min_xg)


@st.cache_data(ttl=3600, show_spinner=False)
def cached_top20():
    return get_top_leagues_shot_quality("25/26")


@st.cache_data(ttl=3600, show_spinner=False)
def cached_league_medians(league_id: int, season_name: str) -> dict[str, float | None]:
    return get_league_metric_medians(league_id, season_name)


@st.cache_data(ttl=3600, show_spinner=False)
def cached_tactical_matrix(league_id: int, season_name: str) -> pd.DataFrame:
    return get_tactical_matrix(league_id, season_name)


def render_tactical_matrix(
    matrix: pd.DataFrame, selected_player_id: str, selected_name: str
) -> None:
    """Render a logo-free, interactive Net Progression vs finishing matrix."""
    if matrix.empty:
        st.info("사분면을 구성할 수 있는 비교군 데이터가 없습니다.")
        return

    x_median = matrix["net_progression_per90"].median()
    y_median = matrix["xgot_minus_xg"].median()
    x_min, x_max = matrix["net_progression_per90"].min(), matrix["net_progression_per90"].max()
    y_min, y_max = matrix["xgot_minus_xg"].min(), matrix["xgot_minus_xg"].max()
    x_pad = max((x_max - x_min) * 0.12, 0.15)
    y_pad = max((y_max - y_min) * 0.12, 0.10)
    x_range = [x_min - x_pad, x_max + x_pad]
    y_range = [y_min - y_pad, y_max + y_pad]

    highlighted = matrix[matrix["player_id"].astype(str) == str(selected_player_id)]
    background = matrix[matrix["player_id"].astype(str) != str(selected_player_id)]
    is_dark = st.get_option("theme.base") == "dark"
    figure = go.Figure()
    figure.add_trace(go.Scatter(
        x=background["net_progression_per90"], y=background["xgot_minus_xg"], mode="markers",
        customdata=background[["player_name", "team_name", "net_progression_per90", "xgot_minus_xg"]],
        marker={"size": 10, "color": "rgba(140, 140, 140, 0.45)"},
        hovertemplate=("<b>%{customdata[0]}</b><br>%{customdata[1]}<br>"
                       "Net Progression /90: %{customdata[2]:.2f}<br>"
                       "xGOT - xG: %{customdata[3]:.2f}<extra></extra>"),
        name="비교군",
    ))
    if not highlighted.empty:
        figure.add_trace(go.Scatter(
            x=highlighted["net_progression_per90"], y=highlighted["xgot_minus_xg"], mode="markers+text",
            text=[selected_name], textposition="top center",
            customdata=highlighted[["player_name", "team_name", "net_progression_per90", "xgot_minus_xg"]],
            marker={"size": 17, "color": "#F4C542", "line": {"color": "#E63946", "width": 2}},
            hovertemplate=("<b>%{customdata[0]}</b><br>%{customdata[1]}<br>"
                           "Net Progression /90: %{customdata[2]:.2f}<br>"
                           "xGOT - xG: %{customdata[3]:.2f}<extra></extra>"),
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
        yaxis={"title": "xGOT - xG", "range": y_range, "zeroline": True},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displaylogo": False})


def get_gradient_color(percentile: float) -> str:
    """백분위에 따라 파랑 -> 노랑 -> 빨강으로 자연스럽게 변환되는 RGB 값을 반환합니다."""
    if percentile <= 50:
        ratio = percentile / 50.0
        r = int(30 + (255 - 30) * ratio)
        g = int(136 + (193 - 136) * ratio)
        b = int(229 + (7 - 229) * ratio)
    else:
        ratio = (percentile - 50.0) / 50.0
        r = int(255 + (229 - 255) * ratio)
        g = int(193 + (57 - 193) * ratio)
        b = int(7 + (53 - 7) * ratio)
    return f"rgb({r}, {g}, {b})"


def render_percentile_bar(title: str, top_percent: float | None, rank_val: int | None, total_players: int, missing_msg: str = "데이터 부족") -> None:
    if top_percent is None or rank_val is None:
        html_content = f"""
        <div style="margin-bottom: 25px; padding: 0 10px; opacity: 0.6;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span style="font-size: 15px; font-weight: 600;">{title}</span>
                <span style="font-size: 14px; font-weight: bold; color: #888;">{missing_msg}</span>
            </div>
            <div style="width: 100%; height: 4px; background-color: #333; border-radius: 2px;"></div>
        </div>
        """
        st.markdown(html_content, unsafe_allow_html=True)
        return

    percentile = 100.0 - top_percent
    dynamic_color = get_gradient_color(percentile)

    html_content = f"""
    <div style="margin-bottom: 25px; padding: 0 10px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
            <span style="font-size: 15px; font-weight: 600;">{title}</span>
            <span style="font-size: 14px; font-weight: bold; color: {dynamic_color};">
                {rank_val}위 <span style="font-size: 12px; font-weight: normal; color: #888;">/ {total_players}명 · 상위 {top_percent}% · 백분위 {percentile:.1f}</span>
            </span>
        </div>
        <div style="position: relative; width: 100%; height: 4px; background-color: #444; border-radius: 2px;">
            <div style="position: absolute; top: -7px; left: calc({percentile}% - 9px); 
                        width: 18px; height: 18px; border-radius: 50%; background-color: {dynamic_color}; 
                        border: 2.5px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.5); z-index: 10;">
            </div>
        </div>
        <div style="display: flex; justify-content: space-between; margin-top: 8px; font-size: 11px; color: #aaa;">
            <span style="color: rgb(30, 136, 229);">Poor</span>
            <span style="color: rgb(255, 193, 7);">Avg</span>
            <span style="color: rgb(229, 57, 53);">Great</span>
        </div>
    </div>
    """
    st.markdown(html_content, unsafe_allow_html=True)


def render_per90_metric_bar(
    title: str,
    value_per90: float | None,
    median_per90: float | None = None,
    description: str = "",
) -> None:
    """Render player and cohort-median values directly on one compact bar."""
    if value_per90 is None:
        html_content = f"""
        <div style="margin-bottom: 25px; padding: 0 10px; opacity: 0.6;">
            <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
                <span style="font-size: 15px; font-weight: 600;">{title}</span>
                <span style="font-size: 14px; font-weight: bold; color: #888;">상세 스탯 없음</span>
            </div>
            <div style="width: 100%; height: 4px; background-color: #333; border-radius: 2px;"></div>
        </div>
        """
        st.markdown(html_content, unsafe_allow_html=True)
        return

    color = "rgb(255, 193, 7)" if value_per90 >= 1.0 else "rgb(30, 136, 229)"
    if value_per90 >= 3.0:
        color = "rgb(229, 57, 53)"
    median_label = f"{median_per90:.2f}" if median_per90 is not None else "정보 없음"
    scale_max = max(value_per90, median_per90 or 0, 0.1) * 1.15
    player_position = min(value_per90 / scale_max * 100, 100)
    median_position = min((median_per90 or 0) / scale_max * 100, 100)
    median_marker = (
        f'<div style="position:absolute; top:-4px; left:calc({median_position}% - 6px); '
        'width:12px; height:12px; background:#a9a9a9; transform:rotate(45deg); '
        'border:1px solid white;"></div>' if median_per90 is not None else ""
    )
        
    html_content = f"""
    <div style="margin-bottom: 25px; padding: 0 10px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 8px;">
            <span style="font-size: 15px; font-weight: 600;">{title}</span>
            <span style="font-size: 13px; font-weight: bold; color: {color};">선수 {value_per90:.2f} /90</span>
        </div>
        <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:6px;">
            <span style="color:{color};">● 선수</span><span style="color:#a9a9a9;">◆ 중앙값 {median_label} /90</span>
        </div>
        <div style="position:relative; width:100%; height:8px; background:#444; border-radius:5px;">
            <div style="position:absolute; top:-5px; left:calc({player_position}% - 7px); width:14px; height:14px; border-radius:50%; background:{color}; border:2px solid white; z-index:2;"></div>
            {median_marker}
        </div>
        <div style="text-align:right; margin-top:8px; font-size:11px; color:#aaa;">
            {description}
        </div>
    </div>
    """
    st.markdown(html_content, unsafe_allow_html=True)


def style_dataframe(df: pd.DataFrame):
    if df.empty:
        return df
    
    try:
        return df.style.background_gradient(
            cmap="RdYlBu_r", subset=["슈팅 퀄리티 (xGOT-xG)"]
        ).format({
            "슈팅 퀄리티 (xGOT-xG)": "{:.2f}",
            "xG": "{:.2f}",
            "xGOT": "{:.2f}"
        })
    except Exception:
        return df


def select_player(query: str, key: str):
    """Search and select one player, keeping comparison-side widget keys unique."""
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


def render_player_report(player, selected_seasons: list[str], competition_filter: str) -> None:
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
    for season_key, stats in seasons.items():
        season_str = season_key.split("_", 1)[0]
        is_ucl = stats.league_id == 42 or "champions" in (stats.league_name or "").lower()
        if season_str not in selected_seasons:
            continue
        if competition_filter == "리그" and is_ucl:
            continue
        if competition_filter == "챔피언스리그" and not is_ucl:
            continue

        with st.expander(f"🏆 {season_str} · {stats.league_name or '대회 정보 없음'}", expanded=True):
            if stats.team_name:
                st.caption(f"소속팀: {stats.team_name}")
            season_name = f"20{season_str[:2]}/20{season_str[3:]}"
            try:
                medians = cached_league_medians(stats.league_id, season_name)
            except Exception:
                medians = {}

            # The tactical matrix is the primary scouting view and intentionally
            # appears before every detail metric.
            try:
                matrix = cached_tactical_matrix(stats.league_id, season_name)
                if str(player.player_id) not in matrix.get("player_id", pd.Series(dtype=str)).astype(str).tolist():
                    matrix = pd.concat([matrix, pd.DataFrame([{
                        "player_id": str(player.player_id), "player_name": player.name,
                        "team_name": stats.team_name or "", "net_progression_per90": stats.net_progression_per90,
                        "xgot_minus_xg": stats.shot_quality,
                    }])], ignore_index=True)
                st.caption("📊 전술 사분면 매트릭스")
                render_tactical_matrix(matrix, player.player_id, player.name)
            except Exception:
                st.caption("사분면 매트릭스를 구성할 비교 집단 데이터가 없습니다.")

            st.divider()
            st.caption("🏃 순수 전진 기여도 = 성공 드리블 + 획득 파울 + 획득 PK + 볼 경합 성공 + 공중볼 경합 성공 − 볼 경합 실패 − 공중볼 경합 실패 − 실패 드리블 − 볼 뺏김")
            render_per90_metric_bar("성공 드리블", stats.dribbles_succeeded_per90, medians.get("dribbles_succeeded_per90"))
            render_per90_metric_bar("실패 드리블", stats.dribbles_failed_per90, medians.get("dribbles_failed_per90"))
            render_per90_metric_bar("볼 경합 성공", stats.duels_won_per90, medians.get("duels_won_per90"))
            render_per90_metric_bar("볼 경합 실패", stats.duels_lost_per90, medians.get("duels_lost_per90"))
            render_per90_metric_bar("공중볼 경합 성공", stats.aerial_duels_won_per90, medians.get("aerial_duels_won_per90"))
            render_per90_metric_bar("공중볼 경합 실패", stats.aerial_duels_lost_per90, medians.get("aerial_duels_lost_per90"))
            render_per90_metric_bar("순수 전진 기여도", stats.net_progression_per90, medians.get("net_progression_per90"))

            try:
                minimum_xg = 1.5 if stats.league_id == 42 else 5.0
                rank = cached_percentiles(player.player_id, season_str, stats, min_xg=minimum_xg)
                if rank.eligible_players:
                    st.caption(f"결정력 상대평가 (동일 대회, xG {minimum_xg} 이상 {rank.eligible_players}명)")
                    render_percentile_bar("득점", rank.goals_top_percent, rank.goals_rank, rank.eligible_players)
                    render_percentile_bar("순수결정력", rank.shot_quality_top_percent, rank.shot_quality_rank, rank.eligible_players)
                    render_percentile_bar("결정력+선방", rank.overall_finishing_top_percent, rank.overall_finishing_rank, rank.eligible_players)
            except Exception:
                st.caption("상대평가 비교군을 불러오지 못했습니다.")



def main() -> None:
    st.title("🎯 스트라이커 전술 스카우팅 리포트")
    st.caption("2차 스탯 기반 선수 기여도 분석 · 동일 포맷의 1:1 비교 지원")
    selected_seasons = st.multiselect("📊 조회할 시즌", ["25/26", "24/25", "23/24", "22/23", "21/22"], default=["25/26", "24/25"])
    competition_filter = st.radio("대회", ["전체", "리그", "챔피언스리그"], horizontal=True)
    compare_mode = st.toggle("선수 비교 모드")

    if compare_mode:
        left, right = st.columns(2)
        with left:
            left_player = select_player(st.text_input("왼쪽 선수 검색", key="left_query", placeholder="예: Francisco Panichelli"), "left_player")
        with right:
            right_player = select_player(st.text_input("오른쪽 선수 검색", key="right_query", placeholder="예: Robert Lewandowski"), "right_player")
        if left_player and right_player:
            st.divider()
            left, right = st.columns(2)
            with left:
                render_player_report(left_player, selected_seasons, competition_filter)
            with right:
                render_player_report(right_player, selected_seasons, competition_filter)
        return

    player = select_player(st.text_input("🔍 선수 이름 검색", placeholder="예: Erling Haaland, Lamine Yamal"), "single_player")
    if player:
        st.divider()
        render_player_report(player, selected_seasons, competition_filter)
        return

    st.divider()
    st.subheader("🏆 25/26 시즌 슈팅 퀄리티 (xGOT-xG) Top 20")
    try:
        ranking_tables = cached_top20()
        if ranking_tables and not ranking_tables.get("통합", pd.DataFrame()).empty:
            tabs = st.tabs(["통합", "Premier League", "LaLiga", "Bundesliga", "Serie A", "Champions League"])
            for tab, name in zip(tabs, ["통합", "Premier League", "LaLiga", "Bundesliga", "Serie A", "Champions League"]):
                with tab:
                    st.dataframe(style_dataframe(ranking_tables.get(name, pd.DataFrame())), use_container_width=True, height=735)
    except Exception as exc:
        st.info(f"랭킹 데이터를 불러오지 못했습니다: {exc}")

if __name__ == "__main__":
    main()
