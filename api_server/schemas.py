from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


TierCode = Literal["diamond", "platinum", "gold", "silver", "bronze", "iron"]


class AssetRef(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int
    name: str = Field(min_length=1)
    icon: HttpUrl


class PlayerStats(BaseModel):
    model_config = ConfigDict(extra="forbid")

    outsideShot: float = Field(ge=0, le=100)
    boxThreat: float = Field(ge=0, le=100)
    dangerZone: float = Field(ge=0, le=100)
    aerial: float = Field(ge=0, le=100)
    groundDuel: float = Field(ge=0, le=100)
    spaceControl: float = Field(ge=0, le=100)


class PlayerTier(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: TierCode
    level: int = Field(ge=1, le=5)
    label: str = Field(min_length=1)


class PlayerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int = Field(gt=0)
    rank: int = Field(ge=1)
    name: str = Field(min_length=1)
    position: str = Field(min_length=1)
    archetype: Literal["Type A", "Type B"]
    age: int = Field(ge=15, le=60)
    minutes: int = Field(ge=0)
    tier: PlayerTier
    score: float = Field(ge=0, le=100)
    face: HttpUrl
    nation: AssetRef | None = None
    league: AssetRef
    club: AssetRef
    stats: PlayerStats


class DatasetMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.0.0"] = "1.0.0"
    season: str
    scope: Literal[3, 5, 7]
    population: int = Field(ge=0)
    returned: int = Field(ge=0)
    generatedAt: datetime
    source: Literal["messi-static-cohort"] = "messi-static-cohort"


class PlayersEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: list[PlayerResponse]
    meta: DatasetMeta


LeaderboardMode = Literal["league", "europe"]
CompetitionCode = Literal["all", "ucl", "uel", "uecl"]


class LeaderboardScopeOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Literal[3, 5, 7]
    label: str = Field(min_length=1)
    leagueIds: list[int]


class CompetitionOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: CompetitionCode
    label: str = Field(min_length=1)
    available: bool
    reason: str | None = None


class LeaderboardOptions(BaseModel):
    model_config = ConfigDict(extra="forbid")

    seasons: list[str]
    scopes: list[LeaderboardScopeOption]
    competitions: dict[CompetitionCode, CompetitionOption]


class LeaderboardMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["2.0.0"] = "2.0.0"
    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7] | None = None
    competition: CompetitionCode | None = None
    population: int = Field(ge=0)
    returned: int = Field(ge=0)
    generatedAt: datetime
    source: Literal["messi-static-cohort"] = "messi-static-cohort"


class LeaderboardEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: list[PlayerResponse]
    meta: LeaderboardMeta


class LeaderboardPageMeta(LeaderboardMeta):
    """Additive v2.1 pagination metadata; v2.0 keeps its existing shape."""

    schemaVersion: Literal["2.1.0"] = "2.1.0"
    page: int = Field(ge=1)
    pageSize: int = Field(ge=1, le=250)
    totalPages: int = Field(ge=0)
    hasNextPage: bool


class LeaderboardPageEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: list[PlayerResponse]
    meta: LeaderboardPageMeta


class RadarAxis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str
    label: str
    score: float = Field(ge=0, le=100)
    percentile: float | None = Field(default=None, ge=0, le=100)
    rank: int | None = Field(default=None, ge=1)
    population: int = Field(ge=0)
    rawValue: float | None = None
    tier: Literal["S", "A", "B", "C", "D"]
    imputed: bool


class RadarChart(BaseModel):
    model_config = ConfigDict(extra="forbid")

    kind: Literal["volume", "ratio"]
    axes: list[RadarAxis] = Field(min_length=6, max_length=6)


class MessiScoreAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: float = Field(ge=0, le=100)
    rank: int | None = Field(default=None, ge=1)
    topPercent: float | None = Field(default=None, ge=0, le=100)
    population: int = Field(ge=0)
    archetype: Literal["Type A", "Type B"]


class RawMetrics(BaseModel):
    """The persisted source metrics needed to render the Streamlit detail view."""

    model_config = ConfigDict(extra="forbid")

    goals: float | None = None
    xg: float | None = None
    xgot: float | None = None
    minutesPlayed: float | None = None
    dribblesSucceeded: float | None = None
    dribblesSuccessRate: float | None = None
    dispossessed: float | None = None
    foulsWon: float | None = None
    penaltiesAwarded: float | None = None
    duelsWon: float | None = None
    duelsWonPercentage: float | None = None
    aerialDuelsWon: float | None = None
    aerialDuelsWonPercentage: float | None = None
    inBoxGoals: float | None = None
    inBoxXg: float | None = None
    inBoxXgot: float | None = None
    inBoxShots: float | None = None
    outBoxGoals: float | None = None
    outBoxXg: float | None = None
    outBoxXgot: float | None = None
    outBoxShots: float | None = None


class HeatmapPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)


class SpatialAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    available: bool
    source: Literal["messi-static-cohort"] = "messi-static-cohort"
    heatmapPointCount: int = Field(ge=0)
    heatmapPoints: list[HeatmapPoint]
    inBoxRatio: float | None = Field(default=None, ge=0, le=100)
    outBoxFinalRatio: float | None = Field(default=None, ge=0, le=100)
    midThirdRatio: float | None = Field(default=None, ge=0, le=100)
    finalThirdRatio: float | None = Field(default=None, ge=0, le=100)
    ccaAreaPct: float | None = Field(default=None, ge=0, le=100)
    laneRatios: list[float] = Field(default_factory=list, max_length=5)
    dangerZoneDensity: float | None = Field(default=None, ge=0, le=100)
    deepBoxZoneScore: float | None = Field(default=None, ge=0, le=100)


class PlayerAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    score: MessiScoreAnalysis
    volumeRadar: RadarChart
    ratioRadar: RadarChart
    rawMetrics: RawMetrics
    spatial: SpatialAnalysis


class PlayerDetailResponse(PlayerResponse):
    analysis: PlayerAnalysis


class PlayerDetailEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: PlayerDetailResponse


class CompareMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7] | None = None
    competition: CompetitionCode | None = None
    population: int = Field(ge=0)
    generatedAt: datetime
    source: Literal["messi-static-cohort"] = "messi-static-cohort"


class PlayerComparisonEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: list[PlayerDetailResponse] = Field(min_length=2, max_length=4)
    meta: CompareMeta


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    season: str
    players: int = Field(ge=0)
