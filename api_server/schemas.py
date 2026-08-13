from __future__ import annotations

from datetime import datetime
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl


# Crystal v2 keeps the established percentile bands, but gives each band its
# new display identity.  The version is carried with every tier so a client
# never has to infer whether (for example) ``platinum`` is legacy or Crystal.
TierCode = Literal["diamond", "emerald", "platinum", "gold", "silver", "bronze"]
TierTaxonomyVersion = Literal["crystal-v2"]


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
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [{
                "code": "emerald", "label": "Emerald", "level": 2,
                "taxonomyVersion": "crystal-v2",
            }],
        },
    )

    code: TierCode
    level: int = Field(ge=1, le=5)
    label: str = Field(min_length=1)
    taxonomyVersion: TierTaxonomyVersion = "crystal-v2"


class PlayerResponse(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int = Field(gt=0)
    rank: int = Field(ge=1)
    name: str = Field(min_length=1)
    position: str = Field(min_length=1)
    archetype: Literal["Type A", "Type B"]
    age: int | None = Field(default=None, ge=15, le=60)
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
AgeBand = Literal["all", "u23", "u25", "26-30", "31-plus"]
MinutesBand = Literal[
    "all", "200-499", "500-999", "1000-1499", "1500-1999",
    "2000-2999", "3000-plus",
]
LeaderboardSort = Literal[
    "rank", "score", "name", "minutes", "age", "outsideShot", "boxThreat",
    "dangerZone", "aerial", "groundDuel", "spaceControl",
]
SortOrder = Literal["asc", "desc"]


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


class LeaderboardAppliedFilters(BaseModel):
    """Canonical predicates and ordering actually applied by the server."""

    model_config = ConfigDict(extra="forbid")

    role: Literal["Type A", "Type B"] | None = None
    position: str | None = None
    q: str | None = None
    ageBand: AgeBand = "all"
    minutesBand: MinutesBand = "all"
    sort: LeaderboardSort = "rank"
    order: SortOrder = "asc"


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
    tierTaxonomyVersion: TierTaxonomyVersion = "crystal-v2"


class LeaderboardEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: list[PlayerResponse]
    meta: LeaderboardMeta


class LeaderboardPageMeta(LeaderboardMeta):
    """Additive v2.1 pagination metadata; v2.0 keeps its existing shape."""

    schemaVersion: Literal["2.1.0"] = "2.1.0"
    page: int = Field(ge=1)
    pageSize: int = Field(ge=1, le=250)
    totalItems: int = Field(ge=0)
    totalPages: int = Field(ge=0)
    hasNextPage: bool
    applied: LeaderboardAppliedFilters


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


class PositionalGridCell(BaseModel):
    """One 6-depth × 5-lane tactical-grid occupancy value."""

    model_config = ConfigDict(extra="forbid")

    depth: int = Field(ge=1, le=6)
    lane: int = Field(ge=1, le=5)
    occupancyPct: float = Field(ge=0, le=100)


class TrueCoreZone(BaseModel):
    """One positive-density positional zone selected into the 50% core."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^depth[1-6]_lane[1-5]$")
    depth: int = Field(ge=1, le=6)
    lane: int = Field(ge=1, le=5)
    densityPct: float = Field(gt=0, le=100)
    areaPct: float = Field(gt=0, le=100)


class TrueCoreAnalysis(BaseModel):
    """The minimum positive 30-zone set reaching 50% event share."""

    model_config = ConfigDict(extra="forbid")

    available: bool
    gridVersion: Literal["positional-6x5-v1"] = "positional-6x5-v1"
    definitionVersion: Literal["true-core-50-v1"] = "true-core-50-v1"
    targetDensityPct: Literal[50] = 50
    achievedDensityPct: float = Field(ge=0, le=100)
    zoneIds: list[str] = Field(max_length=30)
    zoneCount: int = Field(ge=0, le=30)
    coreAreaPct: float = Field(ge=0, le=100)
    tieBreak: Literal["density-desc-depth-asc-lane-asc"] = "density-desc-depth-asc-lane-asc"
    zones: list[TrueCoreZone] = Field(max_length=30)


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
    depthRatios: list[float] = Field(default_factory=list, max_length=6)
    positionalGrid: list[PositionalGridCell] = Field(default_factory=list, max_length=30)
    trueCore: TrueCoreAnalysis
    dangerZoneDensity: float | None = Field(default=None, ge=0, le=100)
    deepBoxZoneScore: float | None = Field(default=None, ge=0, le=100)


MessiMetricCode = Literal[
    "outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel",
    "spaceControl",
]
MessiDataQualityReason = Literal[
    "complete", "spatial_session_missing", "source_metric_missing",
    "mixed_source_missing",
]


class MessiDataQuality(BaseModel):
    """Explain which parts of a M.E.S.S.I. score use the 20-point floor."""

    model_config = ConfigDict(extra="forbid")

    qualityVersion: Literal["messi-quality-v1"] = "messi-quality-v1"
    spatialAvailable: bool
    messiScoreComplete: bool
    reason: MessiDataQualityReason
    imputedMetrics: list[MessiMetricCode] = Field(max_length=6)
    imputedComponents: list[str] = Field(max_length=12)
    observedWeightPct: float = Field(ge=0, le=100)
    fallbackComponentScore: Literal[20] = 20


class PlayerDataQuality(BaseModel):
    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7] | None = None
    competition: CompetitionCode | None = None
    dataQuality: MessiDataQuality


class PlayerDataQualityEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: PlayerDataQuality


class PlayerAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    score: MessiScoreAnalysis
    volumeRadar: RadarChart
    ratioRadar: RadarChart
    rawMetrics: RawMetrics
    spatial: SpatialAnalysis


class PlayerDetailResponse(PlayerResponse):
    # This is deliberately detail-only.  The deployed v2.0 dashboard parses
    # the default player response strictly, so adding it to PlayerResponse
    # itself would be a breaking change for existing clients.
    idNamespace: Literal["fotmob"] = "fotmob"
    analysis: PlayerAnalysis


class PlayerEnvelope(BaseModel):
    """Original v2 player detail envelope, retained for deployed v2.0 clients."""

    model_config = ConfigDict(extra="forbid")

    data: PlayerResponse


class PlayerDetailEnvelope(BaseModel):
    """Opt-in detail envelope with server-computed Streamlit analysis data."""

    model_config = ConfigDict(extra="forbid")

    data: PlayerDetailResponse


class DuelSpatialAnalysis(BaseModel):
    """Opt-in contract; kept outside strict PlayerAnalysis for v2 compatibility."""

    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7] | None = None
    competition: CompetitionCode | None = None
    available: bool
    appliedToMessiRating: bool
    reason: Literal["event_coordinates_unavailable", "incomplete_event_coverage"] | None = None
    gridVersion: Literal["positional-6x5-v1"] = "positional-6x5-v1"
    coordinateSystem: Literal["0-100-attacking-left-to-right"] = "0-100-attacking-left-to-right"
    groundWeightedWinsPer90: float | None = Field(default=None, ge=0)
    aerialWeightedWinsPer90: float | None = Field(default=None, ge=0)
    groundSpatialScore: float | None = Field(default=None, ge=0, le=100)
    aerialSpatialScore: float | None = Field(default=None, ge=0, le=100)
    groundBoxDuelsWon: int | None = Field(default=None, ge=0)
    aerialBoxDuelsWon: int | None = Field(default=None, ge=0)
    boxDuelsWon: int | None = Field(default=None, ge=0)
    cohortPopulation: int = Field(default=0, ge=0)


class DuelSpatialEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: DuelSpatialAnalysis


class TacticalQuadrantPoint(BaseModel):
    """One player in the detail page's tactical quadrant cohort."""

    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    playerName: str = Field(min_length=1)
    teamName: str
    netProgressionPer90: float
    inBoxXgotMinusXg: float
    selected: bool = False


class TacticalQuadrantAnalysis(BaseModel):
    """Server-owned quadrant data using the same cohort as detail ranks."""

    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7] | None = None
    competition: CompetitionCode | None = None
    available: bool
    reason: Literal["complete", "axis_metric_missing", "cohort_unavailable"]
    source: Literal["messi-static-cohort"] = "messi-static-cohort"
    cohortPopulation: int = Field(ge=0)
    xAxis: Literal["netProgressionPer90"] = "netProgressionPer90"
    yAxis: Literal["inBoxXgotMinusXg"] = "inBoxXgotMinusXg"
    xMedian: float | None = None
    yMedian: float | None = None
    selectedPoint: TacticalQuadrantPoint | None = None
    points: list[TacticalQuadrantPoint]


class TacticalQuadrantEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: TacticalQuadrantAnalysis


class CompareMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7] | None = None
    competition: CompetitionCode | None = None
    population: int = Field(ge=0)
    generatedAt: datetime
    source: Literal["messi-static-cohort"] = "messi-static-cohort"
    tierTaxonomyVersion: TierTaxonomyVersion = "crystal-v2"


class PlayerComparisonEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    data: list[PlayerDetailResponse] = Field(min_length=2, max_length=4)
    meta: CompareMeta


class WatchlistResolvedPlayer(PlayerResponse):
    """A context-resolved player with the stable external ID namespace."""

    idNamespace: Literal["fotmob"] = "fotmob"
    playerId: int = Field(gt=0)


class WatchlistResolvedContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7] | None = None
    competition: CompetitionCode | None = None


class WatchlistResolveResult(BaseModel):
    """One result per submitted entry; failures never abort sibling entries."""

    model_config = ConfigDict(extra="forbid")

    key: str = Field(max_length=500)
    status: Literal["resolved", "unavailable", "invalid_context"]
    player: WatchlistResolvedPlayer | None = None
    context: WatchlistResolvedContext | None = None


class WatchlistResolveRequest(BaseModel):
    """Keep entries permissive at the transport layer for isolated errors."""

    model_config = ConfigDict(extra="forbid")

    entries: list[dict[str, object]] = Field(min_length=1, max_length=100)


class WatchlistResolveEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[WatchlistResolveResult] = Field(max_length=100)


class WatchlistDataQualityResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(max_length=500)
    status: Literal["resolved", "unavailable", "invalid_context"]
    playerId: int | None = Field(default=None, gt=0)
    context: WatchlistResolvedContext | None = None
    dataQuality: MessiDataQuality | None = None


class WatchlistDataQualityEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    results: list[WatchlistDataQualityResult] = Field(max_length=100)


class HealthResponse(BaseModel):
    status: Literal["ok"] = "ok"
    season: str
    players: int = Field(ge=0)
