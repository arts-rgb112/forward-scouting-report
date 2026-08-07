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

st.set_page_config(page_title="Striker Decision Quality", page_icon="⚽", layout="wide")

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

def render_tactical_matrix(matrix: pd.DataFrame, selected_player_id: str, selected_name: str) -> None:
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
            cmap="RdYlBu_r", subset=["슈팅 퀄리티 (xGOT-xG)"]
        ).format({
            "슈팅 퀄리티 (xGOT-xG)": "{:.2f}",
            "xG": "{:.2f}",
            "xGOT": "{:.2f}"
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
                medians = cached_league_medians(stats.league_id, season_name)
            except Exception:
                medians = {}

            try:
                matrix = cached_tactical_matrix(stats.league_id, season_name)
                if str(player.player_id) not in matrix.get("player_id", pd.Series(dtype=str)).astype(str).tolist():
                    matrix = pd.concat([matrix, pd.DataFrame([{
                        "player_id": str(player.player_id), "player_name": player.name,
                        "team_name": stats.team_name or "", 
                        "net_progression_per90": net_progression,  # 수정한 지역 변수 사용
                        "xgot_minus_xg": stats.shot_quality,
                    }])], ignore_index=True)
                st.caption("📊 전술 사분면 매트릭스")
                render_tactical_matrix(matrix, player.player_id, player.name)
            except Exception:
                st.caption("사분면 매트릭스를 구성할 비교 집단 데이터가 없습니다.")

            st.divider()

            try:
                minimum_xg = 1.5 if stats.league_id == 42 else 5.0
                rank = cached_percentiles(player.player_id, season_str, stats, min_xg=minimum_xg)
            except Exception:
                rank = None

            def get_rank(attr):
                return getattr(rank, attr, None) if rank else None

            progression_eligible = get_rank("progression_eligible") or 0
            with st.expander(
                f"🏃 순수 전진 기여도 상대평가 · 동일 대회 볼 경합 성공 1회 이상 {progression_eligible}명",
                expanded=True,
            ):
                st.caption("성공 드리블 + 획득 파울 + 획득 PK + 볼 경합 성공 + 공중볼 경합 성공 − 볼 경합 실패 − 공중볼 경합 실패 − 실패 드리블 − 볼 뺏김")
                render_unified_bar("성공 드리블", dribbles_succeeded, medians.get("dribbles_succeeded_per90"),
                                   get_rank("dribbles_succeeded_per90_top_percent"), get_rank("dribbles_succeeded_per90_rank"), progression_eligible, "/90분")
                render_unified_bar("실패 드리블", dribbles_failed, medians.get("dribbles_failed_per90"),
                                   get_rank("dribbles_failed_per90_top_percent"), get_rank("dribbles_failed_per90_rank"), progression_eligible, "/90분")
                render_unified_bar("볼 경합 성공", duels_won, medians.get("duels_won_per90"),
                                   get_rank("duels_won_per90_top_percent"), get_rank("duels_won_per90_rank"), progression_eligible, "/90분")
                render_unified_bar("볼 경합 실패", duels_lost, medians.get("duels_lost_per90"),
                                   get_rank("duels_lost_per90_top_percent"), get_rank("duels_lost_per90_rank"), progression_eligible, "/90분")
                render_unified_bar("공중볼 경합 성공", aerial_won, medians.get("aerial_duels_won_per90"),
                                   get_rank("aerials_won_per90_top_percent"), get_rank("aerials_won_per90_rank"), progression_eligible, "/90분")
                render_unified_bar("공중볼 경합 실패", aerial_lost, medians.get("aerial_duels_lost_per90"),
                                   get_rank("aerials_lost_per90_top_percent"), get_rank("aerials_lost_per90_rank"), progression_eligible, "/90분")
                render_unified_bar("순수 전진 기여도", net_progression, medians.get("net_progression_per90"),
                                   get_rank("net_progression_top_percent"), get_rank("net_progression_rank"), progression_eligible, "/90분")

            st.divider()
            
            if rank and rank.eligible_players:
                with st.expander(f"🎯 결정력 상대평가 · 동일 대회 xG {minimum_xg} 이상 {rank.eligible_players}명", expanded=True):
                    render_unified_bar("득점", stats.goals, None,
                                       rank.goals_top_percent, rank.goals_rank, rank.eligible_players, "골")
                    render_unified_bar("순수결정력", stats.shot_quality, None,
                                       rank.shot_quality_top_percent, rank.shot_quality_rank, rank.eligible_players, "골")
                    render_unified_bar("결정력+선방", stats.overall_finishing, None,
                                       rank.overall_finishing_top_percent, rank.overall_finishing_rank, rank.eligible_players, "골")
            else:
                st.caption("결정력 상대평가 비교군을 불러오지 못했습니다.")

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
