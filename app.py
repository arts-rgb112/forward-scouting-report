import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import numpy as np
import math
import itertools
import html

from fotmob_client import FotMobError, fetch_player_multi_season_data, search_players
from metrics import DecisionMetrics, extract_multi_season_metrics
from rankings import (
    calculate_league_percentiles,
    get_league_metric_medians,
    get_tactical_matrix,
    get_top_leagues_shot_quality,
)
from tactical_ratio import get_heatmap_points, get_tactical_ratio, get_tactical_ratio_by_name, get_tactical_ratio_for_session


_UNIFIED_BAR_COUNTER = itertools.count()

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
    restrict_to_forwards: bool, minimum_final_third_ratio: int, comparison_scope: int = 0,
):
    return calculate_league_percentiles(
        player_id, season, metrics, minimum_xg=min_xg,
        restrict_to_forwards=restrict_to_forwards,
        minimum_final_third_ratio=minimum_final_third_ratio,
        comparison_scope=comparison_scope,
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
    ("박스 밖 킥 순도", "spear_shot_quality_top_percent"),
    ("심층 타격 효율", "micro_zoning_finishing_top_percent"),
    ("위험 구역 파괴력", "danger_zone_progression_top_percent"),
    ("공중볼 장악력", "aerial_margin_per90_top_percent"),
    ("지상 경합 능력", "duel_margin_per90_top_percent"),
    ("공간 장악력", "cca_area_top_percent"),
]

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
        "title": "\U0001f94a \uc2ec\uce35 \ud0c0\uaca9 \ud6a8\uc728",
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
    "micro_zoning_finishing_top_percent": ("tactical:box_six_yard_ratio", "micro_zoning_finishing_rank", "progression_eligible"),
    "danger_zone_progression_top_percent": ("tactical:danger_zone_density", "danger_zone_progression_rank", "progression_eligible"),
    "aerial_margin_per90_top_percent": ("aerial_margin_per90", "aerial_margin_per90_rank", "progression_eligible"),
    "duel_margin_per90_top_percent": ("duel_margin_per90", "duel_margin_per90_rank", "progression_eligible"),
    "cca_area_top_percent": ("tactical:cca_area_pct", "cca_area_rank", "progression_eligible"),
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


def _spear_total(rank) -> tuple[float | None, str | None, int]:
    """Return the visible S.P.E.A.R. total from the actually bound radar axes.

    Missing axes are not silently converted to 50 here: a score is only shown
    when at least one real percentile is available, and the coverage count is
    retained for an honest UI caption.
    """
    if rank is None:
        return None, None, 0
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
    if rank is None:
        return []
    summaries = []
    for sector in TWIN_SECTOR_MATRIX.values():
        volume_percent = getattr(rank, sector["volume"], None)
        ratio_percent = getattr(rank, sector["ratio"], None)
        if volume_percent is None or ratio_percent is None:
            continue
        volume_tier = _spear_tier(_radar_score(volume_percent))
        ratio_tier = _spear_tier(_radar_score(ratio_percent))
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
        if volume_percent is None or ratio_percent is None:
            coordinates.append(None)
        else:
            coordinates.append((
                _spear_tier(_radar_score(volume_percent)),
                _spear_tier(_radar_score(ratio_percent)),
            ))
    return tuple(coordinates)


def render_twin_radar_sector_summaries(rank) -> None:
    """Display all six cross-matrix outcomes as an ordered 3×2 card grid."""
    summaries = twin_radar_sector_summaries(rank)
    st.markdown("#### 💡 볼륨 × 비율 교차 프로필")
    if not summaries:
        st.caption("두 레이더의 상대평가 데이터가 확보되면 6개 섹터의 5×5 교차 설명이 표시됩니다.")
        return

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
        if "D" in tiers:
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
    tactical_ratio: dict[str, object] | None = None,
) -> None:
    """Render one of the synchronized volume/ratio S.P.E.A.R. radars."""
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
        score = _radar_score(top_percent)
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
            f"{tier} 등급",
            "데이터 부족" if top_percent is None else f"상위 {float(top_percent):.1f}%",
            "순위 데이터 부족" if rank_value is None or not total else f"{rank_value}위 / {total}명",
        ])

    figure = go.Figure()
    for name, trace_values, color, fill in (
        (player_name, values, "#22C55E", "rgba(34,197,94,0.28)"),
        ("동일 대회 xG 1+ 평균", [50.0] * len(labels), "#94A3B8", "rgba(148,163,184,0.16)"),
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
        title=f"S.P.E.A.R. {heading} 레이더 · 동일 대회 xG 1+ 기준",
        height=455, margin={"l": 38, "r": 38, "t": 55, "b": 35},
        paper_bgcolor="rgba(0,0,0,0)",
        polar={
            "bgcolor": "rgba(0,0,0,0)",
            "radialaxis": {"range": [0, 100], "tickvals": [0, 25, 50, 75, 100], "visible": True},
            "angularaxis": {"rotation": 90, "direction": "clockwise"},
        },
        legend={"orientation": "h", "y": -0.12, "x": 0.5, "xanchor": "center"},
    )
    st.plotly_chart(figure, use_container_width=True, config={"displayModeBar": False})


def render_spear_head_to_head(left_name: str, left_rank, right_name: str, right_rank) -> None:
    """Overlay the two independent S.P.E.A.R. 2.0 ratio profiles."""
    labels = [label for label, _ in SPEAR_FACTOR_AXES]
    left_scores = [_radar_score(getattr(left_rank, attr, None)) for _, attr in SPEAR_FACTOR_AXES]
    right_scores = [_radar_score(getattr(right_rank, attr, None)) for _, attr in SPEAR_FACTOR_AXES]
    figure = go.Figure()
    for name, scores, color, fill in (
        (left_name, left_scores, "#38BDF8", "rgba(56,189,248,0.25)"),
        (right_name, right_scores, "#FB7185", "rgba(251,113,133,0.24)"),
    ):
        tiers = [_spear_tier(score) for score in scores]
        figure.add_trace(go.Scatterpolar(
            r=scores + [scores[0]], theta=[f"{label} [{tier}]" for label, tier in zip(labels, tiers)] + [f"{labels[0]} [{tiers[0]}]"],
            mode="lines+markers", name=name, fill="toself", fillcolor=fill,
            line={"color": color, "width": 2.5}, marker={"color": color, "size": 6},
            hovertemplate="<b>%{theta}</b><br>%{fullData.name}: %{r:.1f}/100<extra></extra>",
        ))
    figure.update_layout(
        title="S.P.E.A.R. 2.0 Head-to-Head · 비율 프로필",
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
    """Show each player's matrix evidence independently; never concatenate copy."""
    left_cards = dict(twin_radar_sector_summaries(left_rank))
    right_cards = dict(twin_radar_sector_summaries(right_rank))
    raw_fields = {
        "🚀 박스 밖 슈팅력": ("out_box_shots", "out_box_shot_quality", "박스 밖 슛", "xGOT-xG"),
        "🥊 심층 타격 효율": ("in_box_shots", "in_box_finishing", "박스 안 슛", "박스 안 xGOT-xG"),
        "⚡ 위험 구역 파괴력": ("dribble_attempts", "dribble_margin_per90", "돌파 시도", "드리블 마진/90"),
        "🦅 공중볼 장악력": ("aerial_duel_attempts", "aerial_margin_per90", "공중볼 시도", "공중볼 마진/90"),
        "🪨 지상 경합 능력": ("ground_duel_attempts", "duel_margin_per90", "지상 경합 시도", "지상 마진/90"),
        "🧠 공간 장악력": ("tactical:cca_area_pct", "tactical:danger_zone_density", "CCA", "위험구역 밀도"),
    }

    def raw_fact(title, stats, ratio):
        first, second, first_label, second_label = raw_fields[title]
        def value(field):
            if field.startswith("tactical:"):
                return (ratio or {}).get(field.removeprefix("tactical:"))
            return getattr(stats, field, None)
        one, two = value(first), value(second)
        fmt = lambda item: "—" if item is None else f"{float(item):.2f}"
        return f"원시값 · {first_label} {fmt(one)} / {second_label} {fmt(two)}"
    for title in TWIN_SECTOR_MATRIX.values():
        sector_title = title["title"]
        left_text = left_cards.get(sector_title, "비교군 또는 공간 데이터 부족")
        right_text = right_cards.get(sector_title, "비교군 또는 공간 데이터 부족")
        with st.expander(sector_title, expanded=False):
            left_col, right_col = st.columns(2)
            with left_col:
                st.markdown(f"**{left_name}**")
                st.write(left_text)
                st.caption(raw_fact(sector_title, left_stats, left_ratio))
            with right_col:
                st.markdown(f"**{right_name}**")
                st.write(right_text)
                st.caption(raw_fact(sector_title, right_stats, right_ratio))


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


def render_season_heatmap(player_id: str, player_name: str, heatmap_key: str | None = None) -> None:
    points = get_heatmap_points(player_id, heatmap_key)
    st.markdown("#### 📍 시즌 활동 히트맵")
    st.caption("저장된 시즌 좌표를 기반으로 활동 밀도를 표시합니다. 반복 동선 필터 데이터는 수집 완료 후 자동 반영됩니다.")
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
    zone_fields = (
        ("🥇 골드 존 · 6야드", "box_six_yard_ratio", "#F6C945"),
        ("🥈 실버 존 · 페널티 스팟", "box_penalty_spot_ratio", "#CBD5E1"),
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
        tendency = (
            "골 에어리어 심층 침투형" if gold >= max(silver, bronze)
            else "페널티 스팟 컷백 타격형" if silver >= bronze
            else "와이드 박스 앵글 제한형"
        )
        st.caption(f"🥊 박스 내 마이크로 조닝 · 가중 심층 점유 {weighted:.1f}/100 · {tendency}")
        zone_cols = st.columns(3)
        for column, (label, field, color) in zip(zone_cols, zone_fields):
            with column:
                st.markdown(
                    f"<div style='border-left:4px solid {color}; padding-left:0.55rem;'>"
                    f"<b>{label}</b><br><span style='font-size:1.25rem'>{float(ratio[field]):.1f}%</span></div>",
                    unsafe_allow_html=True,
                )
    else:
        st.caption("박스 내 반복 좌표 표본이 부족해 골드·실버·브론즈 비율을 아직 산출할 수 없습니다. 0%를 의미하지 않습니다.")


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
            cohort_label = "동일 대회 · xG 1 이상"
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
    session_team = selected_stats.team_name or "팀 정보 미제공"
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
                render_activity_ratio(player.player_id, player.name, tactical_ratio)
                render_season_heatmap(player.player_id, player.name, tactical_ratio.get("heatmap_key") if tactical_ratio else None)
            with right_col:
                render_activity_ratio(opponent.player_id, opponent.name, opponent_ratio)
                render_season_heatmap(opponent.player_id, opponent.name, opponent_ratio.get("heatmap_key") if opponent_ratio else None)
        return
    spear_score, spear_tier, spear_coverage = _spear_total(rank)
    title_col, help_col = st.columns([4, 1])
    with title_col:
        if spear_score is None:
            st.subheader(f"👑 {player.name}  ·  🏷️ S.P.E.A.R. 데이터 부족")
        else:
            st.subheader(f"👑 {player.name}  ·  [{spear_tier}-Tier]  S.P.E.A.R. {spear_score:.1f}/100")
            if spear_coverage < len(SPEAR_FACTOR_AXES):
                st.caption(f"현재 산출 가능한 팩터 {spear_coverage}/{len(SPEAR_FACTOR_AXES)}개 기준의 잠정 점수입니다.")
    with help_col:
        with st.popover("❓ 점수 산출 방식"):
            st.markdown("**S.P.E.A.R.**  \\n슈팅 50% · 수비 부수기 30% · 위치 선정 20%")
            st.caption("1,000분 이상 전문 공격수의 Z-점수를 0~100 점수로 변환합니다.")
            st.markdown("S 🌟 95+ · A 🔴 85~94 · B 🔵 65~84 · C 🟢 35~64 · D ⚪ 34 이하")
    volume_col, ratio_col = st.columns(2)
    with volume_col:
        render_spear_radar(player.name, rank, selected_stats, volume=True, tactical_ratio=tactical_ratio)
    with ratio_col:
        render_spear_radar(player.name, rank, selected_stats, volume=False, tactical_ratio=tactical_ratio)
    if rank is None:
        st.caption("비교군 데이터를 불러오지 못한 축은 중립값(50)과 C 등급으로 표시됩니다.")
    render_twin_radar_sector_summaries(rank)

    competition_name = selected_stats.league_name or "선택 대회"
    with st.expander(f"📍 {filters['season']} · {competition_name} 공간·활동량", expanded=True):
        activity_col, heatmap_col = st.columns([1, 1.45])
        with activity_col:
            render_activity_ratio(player.player_id, player.name, tactical_ratio)
        with heatmap_col:
            render_season_heatmap(
                player.player_id,
                player.name,
                tactical_ratio.get("heatmap_key") if tactical_ratio else None,
            )
    render_player_report(
        player, [filters["season"]], "전체", True, 0,
        show_activity=False, selected_league_id=selected_stats.league_id,
    )
    if not rank or (rank.eligible_players or 0) < 10:
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
