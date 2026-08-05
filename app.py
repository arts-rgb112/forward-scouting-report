import streamlit as st
import pandas as pd
import plotly.graph_objects as go

from fotmob_client import FotMobError, fetch_player_multi_season_data, search_players
from metrics import DecisionMetrics, extract_multi_season_metrics
from rankings import calculate_league_percentiles, get_tactical_matrix, get_top_leagues_shot_quality

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
                {rank_val}위 <span style="font-size: 12px; font-weight: normal; color: #888;">/ {total_players}명 (상위 {top_percent}%)</span>
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


def render_per90_metric_bar(title: str, value_per90: float | None, description: str = "") -> None:
    """90분당 스탯을 UI로 노출하되, 리그 랭킹 데이터가 수집되기 전까지 사용할 커스텀 바입니다."""
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

    # 값이 높을수록 긍정적이라는 가정 하에 시각적 포인트(색상) 적용
    color = "rgb(255, 193, 7)" if value_per90 >= 1.0 else "rgb(30, 136, 229)"
    if value_per90 >= 3.0:
        color = "rgb(229, 57, 53)"
        
    html_content = f"""
    <div style="margin-bottom: 25px; padding: 0 10px;">
        <div style="display: flex; justify-content: space-between; margin-bottom: 12px;">
            <span style="font-size: 15px; font-weight: 600;">{title}</span>
            <span style="font-size: 14px; font-weight: bold; color: {color};">
                {value_per90:.2f}회 <span style="font-size: 12px; font-weight: normal; color: #888;">/ 90분</span>
            </span>
        </div>
        <div style="position: relative; width: 100%; height: 4px; background-color: #444; border-radius: 2px;">
            <div style="position: absolute; top: -7px; left: 50%; 
                        width: 18px; height: 18px; border-radius: 50%; background-color: {color}; 
                        border: 2.5px solid white; box-shadow: 0 2px 4px rgba(0,0,0,0.5); z-index: 10;">
            </div>
        </div>
        <div style="text-align: right; margin-top: 8px; font-size: 11px; color: #aaa;">
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


def main() -> None:
    st.title("🎯 스트라이커 전술 스카우팅 리포트")
    st.caption("리그 주요 데이터를 기반으로 선수의 득점 생산성과 순수 기여도를 시각화합니다.")
    
    season_options = ["25/26", "24/25", "23/24", "22/23", "21/22"]
    selected_seasons = st.multiselect(
        "📊 조회할 시즌 선택 (최대 3개 권장)", 
        options=season_options, 
        default=["25/26", "24/25"]
    )
    
    query = st.text_input("🔍 선수 이름 검색", placeholder="예: Erling Haaland, Lamine Yamal")
    
    if not query:
        st.divider()
        st.subheader("🏆 25/26 시즌 슈팅 퀄리티 (xGOT-xG) Top 20")
        with st.spinner("유럽 주요 대회 데이터를 집계 중입니다..."):
            try:
                rankings = cached_top20()
                if rankings and not rankings.get("통합", pd.DataFrame()).empty:
                    tab_all, tab_pl, tab_la, tab_bu, tab_sa, tab_ucl = st.tabs([
                        "🌍 통합 랭킹", "🏴󠁧󠁢󠁥󠁮󠁧󠁿 Premier League", "🇪🇸 LaLiga", "🇩🇪 Bundesliga", "🇮🇹 Serie A", "⭐️ Champions League"
                    ])
                    
                    TABLE_HEIGHT = 735
                    
                    with tab_all:
                        st.dataframe(style_dataframe(rankings["통합"]), use_container_width=True, height=TABLE_HEIGHT)
                    with tab_pl:
                        st.dataframe(style_dataframe(rankings.get("Premier League", pd.DataFrame())), use_container_width=True, height=TABLE_HEIGHT)
                    with tab_la:
                        st.dataframe(style_dataframe(rankings.get("LaLiga", pd.DataFrame())), use_container_width=True, height=TABLE_HEIGHT)
                    with tab_bu:
                        st.dataframe(style_dataframe(rankings.get("Bundesliga", pd.DataFrame())), use_container_width=True, height=TABLE_HEIGHT)
                    with tab_sa:
                        st.dataframe(style_dataframe(rankings.get("Serie A", pd.DataFrame())), use_container_width=True, height=TABLE_HEIGHT)
                    with tab_ucl:
                        st.dataframe(style_dataframe(rankings.get("Champions League", pd.DataFrame())), use_container_width=True, height=TABLE_HEIGHT)
                else:
                    st.info("현재 랭킹 데이터를 불러올 수 없습니다.")
            except Exception as e:
                st.error(f"랭킹 렌더링 중 오류가 발생했습니다. (사유: {e})")
        return

    try:
        candidates = cached_search(query)
    except FotMobError as exc:
        st.error(f"선수 검색에 실패했습니다: {exc}")
        return
        
    if not candidates:
        st.warning("일치하는 선수를 찾지 못했습니다.")
        return

    labels = [f"{row.name} · {row.team_name}" if row.team_name else row.name for row in candidates]
    selected = candidates[st.selectbox("선수 선택", range(len(candidates)), format_func=lambda i: labels[i])]
    
    try:
        with st.spinner("선수 전술 스탯을 분석 중입니다..."):
            raw_data = cached_player_data(selected.player_id)
            seasons = extract_multi_season_metrics(raw_data)
    except FotMobError as exc:
        st.error(f"데이터를 불러오지 못했습니다: {exc}")
        return
    
    if not seasons:
        st.warning("스탯 데이터를 찾을 수 없습니다.")
        return

    st.divider()
    st.header(selected.name)
    
    grouped_seasons = {}
    for season_key, stats in seasons.items():
        season_str = season_key.split('_')[0] if '_' in season_key else season_key
        
        if len(season_str) > 5 and "/" in season_str:
            parts = season_str.split("/")
            if len(parts) == 2:
                p1 = parts[0][-2:] if len(parts[0]) >= 2 else parts[0]
                p2 = parts[1][-2:] if len(parts[1]) >= 2 else parts[1]
                season_str = f"{p1}/{p2}"
                
        if season_str not in grouped_seasons:
            grouped_seasons[season_str] = []
        grouped_seasons[season_str].append((season_key, stats))
        
    for season_str, competitions in grouped_seasons.items():
        if selected_seasons and season_str not in selected_seasons:
            continue
            
        st.markdown(f"### 📅 {season_str} 시즌")
        
        for season_key, stats in competitions:
            with st.expander(f"🏆 {stats.league_name or '대회 정보 없음'}", expanded=True):
                if stats.team_name:
                    st.markdown(f"**소속팀:** {stats.team_name}")
                st.divider()
                
                # The matrix is intentionally first: it is the primary scouting view.
                try:
                    season_name = f"20{season_str[:2]}/20{season_str[3:]}"
                    matrix = cached_tactical_matrix(stats.league_id, season_name)
                    if (
                        str(selected.player_id) not in matrix.get("player_id", pd.Series(dtype=str)).astype(str).tolist()
                        and stats.net_progression_per90 is not None
                        and stats.shot_quality is not None
                    ):
                        selected_row = pd.DataFrame([{
                            "player_id": str(selected.player_id),
                            "player_name": selected.name,
                            "team_name": stats.team_name or "",
                            "net_progression_per90": stats.net_progression_per90,
                            "xgot_minus_xg": stats.shot_quality,
                            "dribbles_succeeded_per90": stats.dribbles_succeeded_per90,
                        }])
                        matrix = pd.concat([matrix, selected_row], ignore_index=True)
                    st.caption("📊 **전술 사분면 매트릭스** — 점 위에 마우스를 올리면 상세 수치를 볼 수 있습니다.")
                    render_tactical_matrix(matrix, selected.player_id, selected.name)
                except Exception:
                    st.caption("사분면 매트릭스를 구성할 비교 집단 데이터가 없습니다.")

                st.divider()
                net_progression_per90 = stats.net_progression_per90
                
                try:
                    current_min_xg = 1.5 if stats.league_id == 42 else 5.0
                    rank = cached_percentiles(selected.player_id, season_str, stats, min_xg=current_min_xg)
                    
                    if rank.eligible_players > 0:
                        st.caption(f"🎯 **결정력 및 선방 관련 지표** (동일 대회, xG {current_min_xg} 이상 선수 {rank.eligible_players}명 기준 상대평가)")
                        render_percentile_bar("득점", rank.goals_top_percent, rank.goals_rank, rank.eligible_players)
                        render_percentile_bar("순수결정력", rank.shot_quality_top_percent, rank.shot_quality_rank, rank.eligible_players)
                        render_percentile_bar("결정력+선방", rank.overall_finishing_top_percent, rank.overall_finishing_rank, rank.eligible_players)
                    else:
                        st.warning("순위 비교를 위한 표본이 부족합니다.")
                    st.divider()
# 💡 안내 문구의 숫자 2를 1로 수정합니다.
                    st.caption(
                        f"🏃 **드리블·경합 지표** — 같은 리그·시즌에서 "
                        f"성공 드리블/90이 1 이상인 선수 {rank.elite_dribbler_eligible}명 기준\n\n"
                        f"*(💡 순 전진 기여도 = 성공 드리블 + 피파울 + PK 획득 - 실패 드리블 - 볼 뺏김)*"
                    )
                    render_percentile_bar(
                        "드리블 성공 / 90분",
                        rank.dribbles_succeeded_per90_top_percent,
                        rank.dribbles_succeeded_per90_rank,
                        rank.elite_dribbler_eligible,
                        "엘리트 드리블러 비교군 미포함",
                    )
                    render_percentile_bar(
                        "드리블 실패 / 90분 (낮을수록 우수)",
                        rank.dribbles_failed_per90_top_percent,
                        rank.dribbles_failed_per90_rank,
                        rank.dribbles_failed_eligible,
                        "계산 가능한 비교 데이터 없음",
                    )
                    render_percentile_bar(
                        "순 전진 기여도 / 90분",
                        rank.net_progression_top_percent,
                        rank.net_progression_rank,
                        rank.net_progression_eligible,
                        "계산 가능한 비교 데이터 없음",
                    )
                except Exception:
                    st.caption("비교 집단 데이터를 불러오지 못했습니다.")

                st.divider()
                st.caption("🏃 **순 전진 기여도 (Net Progression)**")
                render_per90_metric_bar(
                    "순 전진 기여도 / 90분", 
                    net_progression_per90, 
                    "성공 드리블 + 획득 파울 + 획득 PK - 드리블 실패 - 볼 뺏김"
                )

                st.divider()
                st.caption("💥 **경합 기여도** (90분당 지상 경합 승리 횟수)")
                render_per90_metric_bar(
                    "지상 경합 승리", 
                    None, 
                    "모집단 구축 후 상대평가 랭킹 적용 예정"
                )

if __name__ == "__main__":
    main()
