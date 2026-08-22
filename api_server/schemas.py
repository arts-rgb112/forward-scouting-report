from __future__ import annotations

from datetime import datetime
import math
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, HttpUrl, model_validator


# Crystal v2 keeps the established percentile bands, but gives each band its
# new display identity.  The version is carried with every tier so a client
# never has to infer whether (for example) ``platinum`` is legacy or Crystal.
TierCode = Literal["diamond", "emerald", "platinum", "gold", "silver", "bronze"]
TierTaxonomyVersion = Literal["crystal-v2"]
MetricTaxonomyVersion = Literal["duel-press-v1"]
RawMetricSource = Literal["player_season_total", "league_per90_fallback"]
DetailReadoutVersion = Literal["detail-readout-v1"]
DetailReadoutState = Literal[
    "observed", "server_derived", "imputed", "unavailable", "legacy_partial",
]
DetailReadoutSource = Literal[
    "player_season_total", "league_per90_fallback", "tactical_ratio_static",
    "server_derived", "unavailable",
]
DetailComparisonDirection = Literal["higher_is_better", "lower_is_better", "neutral"]
DetailComparisonState = Literal["available", "unavailable", "not_applicable"]


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


class DuelPressPlayerStats(BaseModel):
    """Opt-in six-sector taxonomy; legacy PlayerStats remains unchanged."""

    model_config = ConfigDict(extra="forbid")

    outsideShot: float = Field(ge=0, le=100)
    boxThreat: float = Field(ge=0, le=100)
    dangerZone: float = Field(ge=0, le=100)
    combinedDuel: float = Field(ge=0, le=100)
    spaceControl: float = Field(ge=0, le=100)
    forwardPress: float = Field(ge=0, le=100)


class DuelPressComponents(BaseModel):
    model_config = ConfigDict(extra="forbid")

    combinedDuelVolume: float = Field(ge=0, le=100)
    combinedDuelEfficiency: float = Field(ge=0, le=100)
    recoveries: float = Field(ge=0, le=100)
    finalThirdPossessionsWon: float = Field(ge=0, le=100)


class DuelPressRawMetrics(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "description": (
                "For each metric, a non-null source requires non-null total and per90 values. "
                "A null source requires both values to be null. Numeric zero is an observed zero, "
                "never an unavailable sentinel."
            ),
        },
    )

    recoveries: float | None = Field(
        default=None, ge=0, description="Season-compatible total; null only when the source is unavailable.",
    )
    recoveriesPer90: float | None = Field(
        default=None, ge=0, description="Per-90 recovery rate; null only when the source is unavailable.",
    )
    recoveriesSource: RawMetricSource | None = Field(
        default=None, description="Null means recoveries are unavailable, not zero.",
    )
    finalThirdPossessionsWon: float | None = Field(
        default=None, ge=0, description="Season-compatible total; null only when the source is unavailable.",
    )
    finalThirdPossessionsWonPer90: float | None = Field(
        default=None, ge=0, description="Per-90 final-third possession-win rate; null only when unavailable.",
    )
    finalThirdPossessionsWonSource: RawMetricSource | None = Field(
        default=None, description="Null means final-third possession wins are unavailable, not zero.",
    )

    @model_validator(mode="after")
    def validate_source_value_pairs(self) -> "DuelPressRawMetrics":
        pairs = (
            ("recoveries", self.recoveriesSource, self.recoveries, self.recoveriesPer90),
            (
                "finalThirdPossessionsWon",
                self.finalThirdPossessionsWonSource,
                self.finalThirdPossessionsWon,
                self.finalThirdPossessionsWonPer90,
            ),
        )
        for label, source, total, per90 in pairs:
            if source is None and (total is not None or per90 is not None):
                raise ValueError(f"{label} values must both be null when source is null")
            if source is not None and (total is None or per90 is None):
                raise ValueError(f"{label} values must both be numeric when source is present")
        return self


class DuelPressPlayerResponse(PlayerResponse):
    stats: DuelPressPlayerStats
    idNamespace: Literal["fotmob"] = Field(
        default="fotmob",
        description="The player id is the same FotMob id used by legacy player/detail/watchlist routes.",
    )
    components: DuelPressComponents
    pressingRawMetrics: DuelPressRawMetrics


class DatasetMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.0.0"] = "1.0.0"
    season: str
    scope: Literal[3, 5, 7, 8]
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
DuelPressLeaderboardSort = Literal[
    "rank", "score", "name", "minutes", "age", "outsideShot", "boxThreat",
    "dangerZone", "combinedDuel", "spaceControl", "forwardPress",
]
SortOrder = Literal["asc", "desc"]


class LeaderboardScopeOption(BaseModel):
    model_config = ConfigDict(extra="forbid")

    value: Literal[3, 5, 7, 8]
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
    scope: Literal[3, 5, 7, 8] | None = None
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


class DuelPressAppliedFilters(BaseModel):
    model_config = ConfigDict(extra="forbid")

    role: Literal["Type A", "Type B"] | None = None
    position: str | None = None
    q: str | None = None
    ageBand: AgeBand = "all"
    minutesBand: MinutesBand = "all"
    sort: DuelPressLeaderboardSort = "rank"
    order: SortOrder = "asc"


class DuelPressLeaderboardMeta(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.1.0"] = "1.1.0"
    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7, 8] | None = None
    competition: CompetitionCode | None = None
    population: int = Field(ge=0)
    returned: int = Field(ge=0)
    page: int = Field(ge=1)
    pageSize: Literal[50] = 50
    totalItems: int = Field(ge=0)
    totalPages: int = Field(ge=0)
    hasNextPage: bool
    applied: DuelPressAppliedFilters
    generatedAt: datetime
    source: Literal["messi-static-cohort"] = "messi-static-cohort"


class DuelPressLeaderboardEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metricTaxonomyVersion: MetricTaxonomyVersion = "duel-press-v1"
    data: list[DuelPressPlayerResponse]
    meta: DuelPressLeaderboardMeta


class DuelPressRequestContext(BaseModel):
    """Canonical context actually used to resolve a companion player."""

    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(
        gt=0, description="FotMob player id; identical to data.id and legacy player identity.",
    )
    idNamespace: Literal["fotmob"] = "fotmob"
    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    mode: LeaderboardMode
    scope: Literal[3, 5, 7, 8] | None = Field(
        default=None, description="Applied domestic scope; null for mode=europe.",
    )
    competition: CompetitionCode | None = Field(
        default=None, description="Applied European competition; null for mode=league.",
    )

    @model_validator(mode="after")
    def validate_active_dimension(self) -> "DuelPressRequestContext":
        if self.mode == "league" and (self.scope is None or self.competition is not None):
            raise ValueError("league context requires scope and null competition")
        if self.mode == "europe" and (self.scope is not None or self.competition is None):
            raise ValueError("europe context requires competition and null scope")
        return self


class DuelPressPlayerEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    metricTaxonomyVersion: MetricTaxonomyVersion = "duel-press-v1"
    context: DuelPressRequestContext
    data: DuelPressPlayerResponse


class DetailReadoutComparison(BaseModel):
    """A server-authored comparison in the exact requested cohort.

    ``neutral`` readouts (the context indicators) still expose distribution
    position, but clients must not interpret a high percentile as better.
    """

    model_config = ConfigDict(extra="forbid")

    state: DetailComparisonState
    median: float | None = None
    rank: int | None = Field(default=None, ge=1)
    percentile: float | None = Field(default=None, ge=0, le=100)
    population: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_availability(self) -> "DetailReadoutComparison":
        populated = (self.median, self.rank, self.percentile)
        if self.state == "available":
            if any(value is None for value in populated) or self.population < 1:
                raise ValueError("available comparison requires median, rank, percentile, and population")
            if self.rank is not None and self.rank > self.population:
                raise ValueError("comparison rank must not exceed population")
        elif self.state == "unavailable":
            if self.rank is not None or self.percentile is not None:
                raise ValueError("unavailable comparison cannot have rank or percentile")
            if self.population == 0 and self.median is not None:
                raise ValueError("empty unavailable comparison cannot have a median")
            if self.population > 0 and self.median is None:
                raise ValueError("non-empty unavailable comparison requires a cohort median")
        elif any(value is not None for value in populated) or self.population != 0:
            raise ValueError("not_applicable comparison must be null with zero population")
        return self


class DuelPressDetailReadout(BaseModel):
    """One raw, server-owned readout. Numeric zero is an observed value."""

    model_config = ConfigDict(extra="forbid")

    id: str = Field(pattern=r"^[a-z][A-Za-z0-9]*$")
    label: str = Field(min_length=1)
    value: float | None = None
    unit: Literal["count", "per90", "goals", "percent", "score"]
    direction: DetailComparisonDirection
    source: DetailReadoutSource
    state: DetailReadoutState
    comparison: DetailReadoutComparison
    formulaId: str | None = None
    formulaVersion: str | None = None
    missingComponents: list[str] | None = None

    @model_validator(mode="after")
    def validate_value_state(self) -> "DuelPressDetailReadout":
        if (self.formulaId is None) != (self.formulaVersion is None):
            raise ValueError("formulaId and formulaVersion must be supplied together")
        has_formula = self.formulaId is not None
        has_missing = bool(self.missingComponents)

        if self.state == "imputed":
            if self.value is None or self.source != "unavailable" or not has_missing:
                raise ValueError(
                    "imputed readouts require a numeric value, unavailable source, and missingComponents"
                )
            if has_formula:
                raise ValueError("imputed readouts cannot carry formula metadata")
            if self.comparison.state == "available":
                raise ValueError("imputed readouts cannot have an available player comparison")
            return self

        if self.value is None:
            if self.state not in {"unavailable", "legacy_partial"} or self.source != "unavailable":
                raise ValueError("null readouts must be unavailable/legacy_partial with unavailable source")
            if self.comparison.state == "available":
                raise ValueError("null readouts cannot have an available player comparison")
            if self.state == "legacy_partial" and not has_missing:
                raise ValueError("legacy_partial readouts require missingComponents")
        elif self.state in {"unavailable", "legacy_partial"} or self.source == "unavailable":
            raise ValueError("numeric non-imputed readouts cannot use unavailable semantics")

        if self.source == "server_derived":
            if self.state != "server_derived" or not has_formula:
                raise ValueError(
                    "server_derived source requires server_derived state and formula metadata"
                )
        elif self.source in {"player_season_total", "tactical_ratio_static"}:
            if self.state != "observed" or has_formula:
                raise ValueError("direct observed sources require observed state and no formula")
        elif self.source == "league_per90_fallback":
            if self.state == "observed" and has_formula:
                raise ValueError("observed league_per90_fallback cannot carry formula metadata")
            if self.state == "server_derived" and not has_formula:
                raise ValueError("derived league_per90_fallback requires formula metadata")
            if self.state not in {"observed", "server_derived"}:
                raise ValueError("league_per90_fallback has invalid state")
        elif self.source == "unavailable":
            if self.state not in {"unavailable", "legacy_partial"}:
                raise ValueError("unavailable source has invalid state")

        if self.state == "server_derived" and not has_formula:
            raise ValueError("server-derived readouts require formula metadata")
        if self.state not in {"server_derived", "unavailable"} and has_formula:
            raise ValueError("formula metadata is invalid for this readout state")
        if has_missing and self.state not in {"legacy_partial"}:
            raise ValueError("missingComponents is only valid for imputed or legacy_partial readouts")
        return self


DUEL_PRESS_DETAIL_CATEGORY_READOUT_IDS = {
    "outsideShot": (
        "outsideBoxShots", "outsideBoxXg", "outsideBoxXgot",
        "outsideBoxShotQualityGoals",
    ),
    "boxThreat": (
        "inBoxShots", "inBoxXg", "inBoxXgot", "inBoxFinishingGoals",
        "inBoxFinishingPer90", "deepBoxZoneScore",
    ),
    "dangerZone": (
        "successfulDribblesPer90", "failedDribblesPer90",
        "dribbleMarginPer90", "dribbleAttempts", "dribbleSuccessRate",
        "dangerZoneDensity",
    ),
    "combinedDuel": (
        "groundDuelAttempts", "groundWonPer90", "groundLostPer90",
        "duelMarginPer90", "groundDuelWinRate", "aerialDuelAttempts",
        "aerialWonPer90", "aerialLostPer90", "aerialMarginPer90",
        "aerialDuelWinRate",
    ),
    "spaceControl": ("ccaAreaPct", "dangerZoneDensity"),
    "forwardPress": (
        "recoveries", "recoveriesPer90", "finalThirdPossessionsWon",
        "finalThirdPossessionsWonPer90",
    ),
}
DUEL_PRESS_DETAIL_LOWER_BETTER_IDS = {
    "failedDribblesPer90", "groundLostPer90", "aerialLostPer90",
}


class DuelPressDetailCategory(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: Literal["outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress"]
    label: str = Field(min_length=1)
    score: float | None = Field(default=None, ge=0, le=100)
    scoreState: Literal["observed", "imputed", "unavailable"]
    imputedComponents: list[str] = Field(default_factory=list)
    comparison: DetailReadoutComparison
    readouts: list[DuelPressDetailReadout] = Field(min_length=1)

    @model_validator(mode="after")
    def validate_score_state(self) -> "DuelPressDetailCategory":
        if self.score is None and self.scoreState != "unavailable":
            raise ValueError("null category scores require unavailable scoreState")
        if self.score is not None and self.scoreState == "unavailable":
            raise ValueError("numeric category scores cannot be unavailable")
        if self.scoreState == "imputed" and not self.imputedComponents:
            raise ValueError("imputed category scores require imputedComponents")
        if self.scoreState != "imputed" and self.imputedComponents:
            raise ValueError("only imputed category scores may list imputedComponents")
        expected_ids = DUEL_PRESS_DETAIL_CATEGORY_READOUT_IDS[self.id]
        if tuple(readout.id for readout in self.readouts) != expected_ids:
            raise ValueError(f"{self.id} readouts must use the exact required ownership and order")
        for readout in self.readouts:
            expected_direction = (
                "lower_is_better"
                if readout.id in DUEL_PRESS_DETAIL_LOWER_BETTER_IDS
                else "higher_is_better"
            )
            if readout.direction != expected_direction:
                raise ValueError(f"{readout.id} must use direction={expected_direction}")
        if self.id == "forwardPress":
            readouts = {readout.id: readout for readout in self.readouts}
            self._validate_press_pair(
                "recoveries", readouts["recoveries"], readouts["recoveriesPer90"],
            )
            self._validate_press_pair(
                "finalThirdPossessionsWon",
                readouts["finalThirdPossessionsWon"],
                readouts["finalThirdPossessionsWonPer90"],
            )
        return self

    @staticmethod
    def _validate_press_pair(
        label: str, total: DuelPressDetailReadout, per90: DuelPressDetailReadout,
    ) -> None:
        total_available = total.value is not None
        per90_available = per90.value is not None
        if total_available != per90_available:
            raise ValueError(f"{label} total and per90 must both be numeric or both unavailable")
        if not total_available:
            if any(
                item.source != "unavailable" or item.state != "unavailable"
                for item in (total, per90)
            ):
                raise ValueError(f"unavailable {label} pair must use unavailable source/state")
            return
        if total.source != per90.source:
            raise ValueError(f"{label} total/per90 sources must match")
        if total.source == "player_season_total":
            if total.state != "observed" or per90.state != "observed":
                raise ValueError(f"player_season_total {label} pair must be observed")
            return
        if total.source == "league_per90_fallback":
            if (
                total.state != "server_derived"
                or total.formulaId != "league-per90-total-v1"
                or per90.state != "observed"
            ):
                raise ValueError(
                    f"league_per90_fallback {label} requires derived total and observed per90"
                )
            return
        raise ValueError(f"numeric {label} pair has invalid source")


class DuelPressDetailPlayerIdentity(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: int = Field(gt=0)
    idNamespace: Literal["fotmob"] = "fotmob"
    name: str = Field(min_length=1)
    position: str = Field(min_length=1)
    club: AssetRef
    league: AssetRef


class DuelPressDetailReadoutEnvelope(BaseModel):
    """Strict additive detail contract; legacy player and companion DTOs stay intact."""

    model_config = ConfigDict(extra="forbid")

    metricTaxonomyVersion: MetricTaxonomyVersion = "duel-press-v1"
    readoutVersion: DetailReadoutVersion = "detail-readout-v1"
    context: DuelPressRequestContext
    player: DuelPressDetailPlayerIdentity
    categories: list[DuelPressDetailCategory] = Field(min_length=6, max_length=6)
    contextIndicators: list[DuelPressDetailReadout] = Field(min_length=2, max_length=2)

    @model_validator(mode="after")
    def validate_order_and_identity(self) -> "DuelPressDetailReadoutEnvelope":
        category_ids = [category.id for category in self.categories]
        if category_ids != [
            "outsideShot", "boxThreat", "dangerZone", "combinedDuel", "spaceControl", "forwardPress",
        ]:
            raise ValueError("categories must use the exact duel-press-v1 order")
        if [indicator.id for indicator in self.contextIndicators] != [
            "netProgressionPer90", "shootingLuckOrGoalkeeperImpact",
        ]:
            raise ValueError("contextIndicators must use the exact required order")
        expected_indicator_formulas = (
            "net-progression-v1", "goals-minus-xgot-v1",
        )
        for indicator, formula_id in zip(self.contextIndicators, expected_indicator_formulas):
            if (
                indicator.direction != "neutral"
                or indicator.formulaId != formula_id
            ):
                raise ValueError(
                    f"{indicator.id} must be neutral with formulaId={formula_id}"
                )
            if indicator.value is not None and (
                indicator.source != "server_derived" or indicator.state != "server_derived"
            ):
                raise ValueError(f"numeric {indicator.id} must be server-derived")
        if self.player.id != self.context.playerId:
            raise ValueError("player identity must match context playerId")
        return self


class MetricRankPlayerRef(BaseModel):
    """Stable player identity echoed by the metric-ranks batch endpoint."""

    model_config = ConfigDict(extra="forbid")

    idNamespace: Literal["fotmob"]
    playerId: int = Field(gt=0)


class MetricRankContext(BaseModel):
    """The exact browser context used for an all-cohort rank lookup.

    Unlike the legacy watchlist context, domestic requests retain
    ``competition: \"all\"`` so the request can be echoed byte-for-byte in a
    strict client contract.
    """

    model_config = ConfigDict(extra="forbid")

    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    mode: LeaderboardMode
    scope: Literal[3, 5, 7, 8] | None = None
    competition: CompetitionCode

    @model_validator(mode="after")
    def validate_active_dimension(self) -> "MetricRankContext":
        if self.mode == "league" and (self.scope is None or self.competition != "all"):
            raise ValueError("league context requires scope and competition 'all'")
        if self.mode == "europe" and self.scope is not None:
            raise ValueError("europe context requires null scope")
        return self


class MetricRankRequestEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=500)
    player: MetricRankPlayerRef
    metricTaxonomyVersion: MetricTaxonomyVersion
    context: MetricRankContext


class MetricRanksRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    entries: list[MetricRankRequestEntry] = Field(min_length=1, max_length=50)

    @model_validator(mode="after")
    def validate_unique_keys(self) -> "MetricRanksRequest":
        keys = [entry.key for entry in self.entries]
        if len(keys) != len(set(keys)):
            raise ValueError("entries must contain unique key values")
        return self


class MetricRankValue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    rank: int | None = Field(default=None, ge=1)
    population: int = Field(ge=0)

    @model_validator(mode="after")
    def validate_rank_bounds(self) -> "MetricRankValue":
        if self.rank is not None and self.rank > self.population:
            raise ValueError("rank must not exceed population")
        return self


class DuelPressMetricRanks(BaseModel):
    """Exactly the six sectors defined by ``duel-press-v1``."""

    model_config = ConfigDict(extra="forbid")

    outsideShot: MetricRankValue
    boxThreat: MetricRankValue
    dangerZone: MetricRankValue
    combinedDuel: MetricRankValue
    spaceControl: MetricRankValue
    forwardPress: MetricRankValue


class MetricRankResult(BaseModel):
    model_config = ConfigDict(extra="forbid")

    key: str = Field(min_length=1, max_length=500)
    player: MetricRankPlayerRef
    metricTaxonomyVersion: MetricTaxonomyVersion
    context: MetricRankContext
    status: Literal["resolved", "unavailable", "invalid_context"]
    metrics: DuelPressMetricRanks | None = None

    @model_validator(mode="after")
    def validate_metrics_status(self) -> "MetricRankResult":
        if self.status == "resolved" and self.metrics is None:
            raise ValueError("resolved metric-rank results require metrics")
        if self.status != "resolved" and self.metrics is not None:
            raise ValueError("non-resolved metric-rank results must have null metrics")
        return self


class MetricRanksEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.0.0"] = "1.0.0"
    results: list[MetricRankResult] = Field(min_length=1, max_length=50)


class ApiErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: str = Field(min_length=1)


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


class ShotTrajectory(BaseModel):
    """Provider-backed shot endpoint; absent/null means no endpoint evidence."""

    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["shotmap-trajectory-v1"] = "shotmap-trajectory-v1"
    endpointKind: Literal["goal_mouth", "blocked"]
    endX: float = Field(ge=0, le=100)
    endY: float = Field(ge=0, le=100)
    endZMeters: float | None = Field(
        default=None,
        ge=0,
        description=(
            "Provider-observed goal crossing height in metres. Null for blocked "
            "endpoints or when the source does not provide a valid height."
        ),
    )
    source: Literal["fotmob"] = "fotmob"

    @model_validator(mode="after")
    def validate_endpoint_semantics(self) -> "ShotTrajectory":
        if any(
            value is not None and not math.isfinite(value)
            for value in (self.endX, self.endY, self.endZMeters)
        ):
            raise ValueError("trajectory numeric values must be finite")
        if self.endpointKind == "blocked" and self.endZMeters is not None:
            raise ValueError("blocked endpoints cannot contain endZMeters")
        if self.endpointKind == "goal_mouth" and self.endX != 100.0:
            raise ValueError("goal_mouth endpoints must terminate at endX=100")
        return self


class ShotmapPoint(BaseModel):
    model_config = ConfigDict(extra="forbid")

    x: float = Field(ge=0, le=100)
    y: float = Field(ge=0, le=100)
    outcome: Literal["goal", "on_target", "off_target", "blocked"]
    xg: float | None = Field(default=None, ge=0)
    xgot: float | None = Field(default=None, ge=0)
    trajectory: ShotTrajectory | None = Field(
        default=None,
        description=(
            "Optional provider-backed endpoint in the same normalized 0..100 pitch "
            "space as x/y. Null means endpoint coordinates were unavailable or invalid; "
            "clients must not infer a replacement endpoint."
        ),
    )

    @model_validator(mode="after")
    def validate_trajectory_matches_outcome(self) -> "ShotmapPoint":
        if any(
            value is not None and not math.isfinite(value)
            for value in (self.x, self.y, self.xg, self.xgot)
        ):
            raise ValueError("shotmap numeric values must be finite")
        if self.trajectory is None:
            return self
        expected_kind = "blocked" if self.outcome == "blocked" else "goal_mouth"
        if self.trajectory.endpointKind != expected_kind:
            raise ValueError(
                f"{self.outcome} shots require a {expected_kind} trajectory endpoint"
            )
        return self


FinalThirdFieldStateCode = Literal["observed", "partial", "unavailable"]
FinalThirdZoneStateCode = Literal["observed", "partial", "unavailable"]


class FinalThirdFieldState(BaseModel):
    """Provenance for one server-owned final-third metric field."""

    model_config = ConfigDict(extra="forbid")

    state: FinalThirdFieldStateCode
    reason: str | None = None
    source: Literal["player_season_shot_events"] | None = None
    formulaVersion: str | None = None

    @model_validator(mode="after")
    def validate_unavailable_pair(self) -> "FinalThirdFieldState":
        if self.state in {"partial", "unavailable"} and not self.reason:
            raise ValueError("partial/unavailable final-third fields require a reason")
        if self.state == "observed" and self.reason is not None:
            raise ValueError("observed final-third fields cannot contain a reason")
        return self


class FinalThirdZoneFieldStates(BaseModel):
    model_config = ConfigDict(extra="forbid")

    volume: FinalThirdFieldState
    conversionRatePct: FinalThirdFieldState
    qualityScore: FinalThirdFieldState


class FinalThirdShotZone(BaseModel):
    """One taxonomy tile; its counts are never browser-derived."""

    model_config = ConfigDict(extra="forbid")

    zoneId: str = Field(pattern=r"^depth[56]_lane[1-5]$")
    depth: Literal[5, 6]
    lane: Literal[1, 2, 3, 4, 5]
    shotsTotal: int | None = Field(default=None, ge=0)
    goals: int | None = Field(default=None, ge=0)
    conversionRatePct: float | None = Field(default=None, ge=0, le=100)
    qualityScore: float | None = None
    qualityEligibleShots: int | None = Field(default=None, ge=0)
    state: FinalThirdZoneStateCode
    reason: str | None = None
    source: Literal["player_season_shot_events"] | None = None
    qualityFormulaVersion: Literal["avg-xgot-minus-avg-xg-v1"] = "avg-xgot-minus-avg-xg-v1"
    fieldStates: FinalThirdZoneFieldStates

    @model_validator(mode="after")
    def validate_final_third_zone(self) -> "FinalThirdShotZone":
        if self.zoneId != f"depth{self.depth}_lane{self.lane}":
            raise ValueError("zoneId must match depth and lane")
        if self.shotsTotal is None:
            if any(value is not None for value in (
                self.goals, self.conversionRatePct, self.qualityScore,
                self.qualityEligibleShots,
            )):
                raise ValueError("unavailable zone volume cannot contain derived metrics")
        else:
            if self.goals is None or self.goals > self.shotsTotal:
                raise ValueError("zone goals must be present and no greater than shotsTotal")
            if self.shotsTotal == 0 and (
                self.conversionRatePct is not None or self.qualityScore is not None
                or self.qualityEligibleShots != 0
            ):
                raise ValueError("zero-attempt zones have null conversion/quality and zero eligible shots")
        return self


class FinalThirdCoverageIssue(BaseModel):
    model_config = ConfigDict(extra="forbid")

    zoneId: str | None = Field(default=None, pattern=r"^depth[56]_lane[1-5]$")
    shotId: str | None = Field(default=None, min_length=1)
    field: Literal["volume", "conversionRatePct", "qualityScore", "goalMouthEndpoint"]
    reason: str = Field(min_length=1)

    @model_validator(mode="after")
    def validate_target(self) -> "FinalThirdCoverageIssue":
        if self.zoneId is None and self.shotId is None:
            raise ValueError("coverage issue requires a zoneId or shotId")
        return self


class FinalThirdGoalMouthCoordinates(BaseModel):
    model_config = ConfigDict(extra="forbid")

    version: Literal["goal-mouth-v1"] = "goal-mouth-v1"
    unit: Literal["normalized"] = "normalized"
    horizontalMin: Literal[0] = 0
    horizontalMax: Literal[1] = 1
    verticalMin: Literal[0] = 0
    verticalMax: Literal[1] = 1
    origin: Literal["bottom_left_shooter_view"] = "bottom_left_shooter_view"
    horizontalDirection: Literal["shooter_left_to_right"] = "shooter_left_to_right"
    verticalDirection: Literal["ground_to_crossbar"] = "ground_to_crossbar"


class FinalThirdQualityScale(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min: Literal[-0.5] = -0.5
    neutral: Literal[0] = 0
    max: Literal[0.5] = 0.5
    version: Literal["final-third-quality-v1"] = "final-third-quality-v1"


class FinalThirdMarkerSizeScale(BaseModel):
    model_config = ConfigDict(extra="forbid")

    min: Literal[0] = 0
    max: Literal[1] = 1
    version: Literal["xg-natural-0-to-1-v1"] = "xg-natural-0-to-1-v1"


class FinalThirdShot(BaseModel):
    model_config = ConfigDict(extra="forbid")

    shotId: str = Field(min_length=1)
    shotIdSource: Literal["provider_event", "snapshot_record"] = "snapshot_record"
    zoneId: str = Field(pattern=r"^depth[56]_lane[1-5]$")
    pitchX: float = Field(ge=0, le=100)
    pitchY: float = Field(ge=0, le=100)
    xg: float | None = Field(default=None, ge=0)
    xgot: float | None = Field(default=None, ge=0)
    status: Literal["goal", "on_target", "off_target", "blocked"]
    endpointAvailable: bool
    goalMouthY: float | None = None
    goalMouthZ: float | None = None
    endpointReason: str | None = None
    source: Literal["player_season_shot_events"] = "player_season_shot_events"

    @model_validator(mode="after")
    def validate_goal_mouth_endpoint(self) -> "FinalThirdShot":
        if any(
            value is not None and not math.isfinite(value)
            for value in (self.pitchX, self.pitchY, self.xg, self.xgot, self.goalMouthY, self.goalMouthZ)
        ):
            raise ValueError("final-third shot numeric values must be finite")
        coordinates = (self.goalMouthY, self.goalMouthZ)
        if self.endpointAvailable:
            if any(value is None for value in coordinates) or self.endpointReason is not None:
                raise ValueError("available endpoints require both coordinates and no reason")
        elif any(value is not None for value in coordinates) or not self.endpointReason:
            raise ValueError("unavailable endpoints require null coordinates and an explicit reason")
        return self


class FinalThirdShotContext(BaseModel):
    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    idNamespace: Literal["fotmob"] = "fotmob"
    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    mode: Literal["league", "europe"]
    scope: Literal[3, 5, 7, 8] | None = None
    competition: CompetitionCode | None = None
    depthBand: Literal["front2"] = "front2"

    @model_validator(mode="after")
    def validate_dimension(self) -> "FinalThirdShotContext":
        if self.mode == "league" and (self.scope is None or self.competition is not None):
            raise ValueError("league context requires scope and null competition")
        if self.mode == "europe" and (self.scope is not None or self.competition is None):
            raise ValueError("europe context requires null scope and competition")
        return self


class FinalThirdShotData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    available: bool
    completeness: Literal["complete", "partial", "unavailable"]
    reason: str | None = None
    gridVersion: Literal["positional-6x5-v1"] = "positional-6x5-v1"
    attackDirection: Literal["left_to_right"] = "left_to_right"
    includedDepths: list[Literal[5, 6]] = Field(default_factory=lambda: [5, 6], min_length=2, max_length=2)
    qualityScale: FinalThirdQualityScale
    markerSizeScale: FinalThirdMarkerSizeScale
    goalMouthCoordinates: FinalThirdGoalMouthCoordinates
    zones: list[FinalThirdShotZone] = Field(min_length=10, max_length=10)
    shots: list[FinalThirdShot]
    endpointUnavailableCount: int = Field(ge=0)
    endpointUnavailableShotIds: list[str]
    partialCoverage: list[FinalThirdCoverageIssue]

    @model_validator(mode="after")
    def validate_final_third_data(self) -> "FinalThirdShotData":
        if self.includedDepths != [5, 6]:
            raise ValueError("front2 must include depths [5, 6] in canonical order")
        expected = [
            *(f"depth6_lane{lane}" for lane in range(1, 6)),
            *(f"depth5_lane{lane}" for lane in range(1, 6)),
        ]
        if [zone.zoneId for zone in self.zones] != expected:
            raise ValueError("front2 zones must use the canonical fixed order")
        unavailable_ids = [shot.shotId for shot in self.shots if not shot.endpointAvailable]
        if self.endpointUnavailableCount != len(unavailable_ids) or self.endpointUnavailableShotIds != unavailable_ids:
            raise ValueError("endpoint-unavailable count/list must match shots")
        if not self.available and self.completeness != "unavailable":
            raise ValueError("unavailable final-third data must declare unavailable completeness")
        return self


class FinalThirdShotEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.0.0"] = "1.0.0"
    chartTaxonomyVersion: Literal["final-third-shot-map-v1"] = "final-third-shot-map-v1"
    context: FinalThirdShotContext
    data: FinalThirdShotData


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


class ContinuousCoreAnalysis(BaseModel):
    """Continuous 50% highest-density region used as the CCA area."""

    model_config = ConfigDict(extra="forbid")

    available: bool
    definitionVersion: Literal["continuous-hdr-50-v1"] = "continuous-hdr-50-v1"
    targetDensityPct: Literal[50] = 50
    achievedDensityPct: float = Field(ge=0, le=100)
    coreAreaPct: float = Field(ge=0, le=100)
    densityThreshold: float = Field(ge=0)
    thresholdOfPeak: float = Field(ge=0, le=1)
    gridColumns: Literal[32] = 32
    gridRows: Literal[22] = 22


class SpatialAnalysis(BaseModel):
    model_config = ConfigDict(extra="forbid")

    available: bool
    source: Literal["messi-static-cohort"] = "messi-static-cohort"
    heatmapPointCount: int = Field(ge=0)
    heatmapPoints: list[HeatmapPoint]
    shotmapPointCount: int = Field(
        ge=0,
        description="Exact number of records in shotmapPoints.",
    )
    shotmapPoints: list[ShotmapPoint] = Field(
        description=(
            "Every validated source shot in the available snapshot. An empty list means either "
            "a verified zero-shot snapshot when shotmapSnapshotAvailable is true, or no snapshot "
            "when it is false."
        ),
    )
    shotmapSnapshotAvailable: bool = Field(
        description=(
            "False when no snapshot exists for this player-context. True means a snapshot was "
            "loaded and validated; shotmapPoints may still be empty for a verified zero-shot session."
        ),
    )
    inBoxRatio: float | None = Field(default=None, ge=0, le=100)
    outBoxFinalRatio: float | None = Field(default=None, ge=0, le=100)
    midThirdRatio: float | None = Field(default=None, ge=0, le=100)
    finalThirdRatio: float | None = Field(default=None, ge=0, le=100)
    ccaAreaPct: float | None = Field(default=None, ge=0, le=100)
    laneRatios: list[float] = Field(default_factory=list, max_length=5)
    depthRatios: list[float] = Field(default_factory=list, max_length=6)
    positionalGrid: list[PositionalGridCell] = Field(default_factory=list, max_length=30)
    trueCore: TrueCoreAnalysis
    continuousCore: ContinuousCoreAnalysis
    dangerZoneDensity: float | None = Field(default=None, ge=0, le=100)
    deepBoxZoneScore: float | None = Field(default=None, ge=0, le=100)

    @model_validator(mode="after")
    def validate_shotmap_contract(self) -> "SpatialAnalysis":
        if self.shotmapPointCount != len(self.shotmapPoints):
            raise ValueError("shotmapPointCount must equal len(shotmapPoints)")
        if not self.shotmapSnapshotAvailable and self.shotmapPoints:
            raise ValueError("an unavailable shotmap snapshot cannot contain shotmapPoints")
        return self


class ShotmapServiceErrorDetail(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: Literal["shotmap_contract_violation"] = "shotmap_contract_violation"
    message: str = Field(min_length=1)


class ShotmapServiceErrorEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    detail: ShotmapServiceErrorDetail


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
    scope: Literal[3, 5, 7, 8] | None = None
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


ContextualCompareVersion = Literal["contextual-compare-v1"]
ContextualCompareTaxonomy = Literal["legacy-v1", "duel-press-v1"]
ContextualCompareStatus = Literal["resolved", "unavailable", "invalid_context"]
ContextualCompareComponentReason = Literal[
    "available", "exact_context_analysis_unavailable", "unavailable",
]


class ContextualComparePlayerRef(BaseModel):
    """The stable identity submitted for one independently resolved side."""

    model_config = ConfigDict(extra="forbid")

    idNamespace: Literal["fotmob"]
    playerId: int = Field(gt=0)


class ContextualCompareRequestContext(BaseModel):
    """Strict browser context; domestic requests retain ``competition=all``."""

    model_config = ConfigDict(extra="forbid")

    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    mode: LeaderboardMode
    scope: Literal[3, 5, 7, 8] | None = None
    competition: CompetitionCode

    @model_validator(mode="after")
    def validate_active_dimension(self) -> "ContextualCompareRequestContext":
        if self.mode == "league" and (self.scope is None or self.competition != "all"):
            raise ValueError("league context requires scope and competition 'all'")
        if self.mode == "europe" and self.scope is not None:
            raise ValueError("europe context requires null scope")
        return self


class ContextualCompareCanonicalContext(BaseModel):
    """The applied context, with inactive dimensions canonicalised to null."""

    model_config = ConfigDict(extra="forbid")

    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    mode: LeaderboardMode
    scope: Literal[3, 5, 7, 8] | None = None
    competition: CompetitionCode | None = None

    @model_validator(mode="after")
    def validate_active_dimension(self) -> "ContextualCompareCanonicalContext":
        if self.mode == "league" and (self.scope is None or self.competition is not None):
            raise ValueError("league canonical context requires scope and null competition")
        if self.mode == "europe" and (self.scope is not None or self.competition is None):
            raise ValueError("europe canonical context requires null scope and competition")
        return self


class ContextualCompareRequestSide(BaseModel):
    model_config = ConfigDict(extra="forbid")

    player: ContextualComparePlayerRef
    taxonomy: ContextualCompareTaxonomy
    context: ContextualCompareRequestContext


class ContextualCompareRequest(BaseModel):
    """Exactly two independently resolved FotMob contexts, in display order."""

    model_config = ConfigDict(extra="forbid")

    comparisonVersion: ContextualCompareVersion
    left: ContextualCompareRequestSide
    right: ContextualCompareRequestSide

    @model_validator(mode="after")
    def validate_distinct_contexts(self) -> "ContextualCompareRequest":
        left, right = self.left, self.right
        left_identity = (left.player.idNamespace, left.player.playerId, left.context.season,
                         left.context.mode, left.context.scope, left.context.competition)
        right_identity = (right.player.idNamespace, right.player.playerId, right.context.season,
                          right.context.mode, right.context.scope, right.context.competition)
        if left_identity == right_identity:
            raise ValueError("left and right must not use the identical player and context")
        return self


class ContextualCompareComponentAvailability(BaseModel):
    """Per-component provenance for a resolved side's optional companions."""

    model_config = ConfigDict(extra="forbid")

    detail: ContextualCompareComponentReason
    dataQuality: ContextualCompareComponentReason
    tacticalQuadrant: ContextualCompareComponentReason


class ContextualCompareSide(BaseModel):
    """One server-resolved side. Failure never mutates or drops its sibling."""

    model_config = ConfigDict(extra="forbid")

    player: ContextualComparePlayerRef
    taxonomy: ContextualCompareTaxonomy
    context: ContextualCompareCanonicalContext
    status: ContextualCompareStatus
    summary: PlayerResponse | None = None
    componentAvailability: ContextualCompareComponentAvailability
    detail: PlayerDetailResponse | None = None
    dataQuality: MessiDataQuality | None = None
    tacticalQuadrant: TacticalQuadrantAnalysis | None = None
    duelPressPlayer: DuelPressPlayerResponse | None = None
    duelPressDetailReadout: DuelPressDetailReadoutEnvelope | None = None

    @model_validator(mode="after")
    def validate_status_payload(self) -> "ContextualCompareSide":
        companions = (
            ("detail", self.componentAvailability.detail, self.detail),
            ("dataQuality", self.componentAvailability.dataQuality, self.dataQuality),
            ("tacticalQuadrant", self.componentAvailability.tacticalQuadrant, self.tacticalQuadrant),
        )
        duel = (self.duelPressPlayer, self.duelPressDetailReadout)
        if self.status == "resolved":
            if self.summary is None:
                raise ValueError("resolved contextual side requires an exact-context summary")
            for label, reason, value in companions:
                if (reason == "available") != (value is not None):
                    raise ValueError(f"{label} availability must match its payload")
            if self.tacticalQuadrant is not None and not self.tacticalQuadrant.available:
                raise ValueError("contextual tactical quadrant must be available when present")
            if self.taxonomy == "duel-press-v1" and any(value is None for value in duel):
                raise ValueError("resolved duel-press side requires player and detail readout")
            if self.taxonomy == "legacy-v1" and any(value is not None for value in duel):
                raise ValueError("legacy side cannot carry duel-press data")
            if self.taxonomy == "duel-press-v1":
                # A readout is analytical output from the selected cohort, not
                # merely additional player decoration.  Do not let a cached or
                # stale readout from a different season/context be embedded in
                # an otherwise resolved side.
                assert self.duelPressDetailReadout is not None
                readout = self.duelPressDetailReadout
                expected_context = (
                    self.player.playerId,
                    self.player.idNamespace,
                    self.context.season,
                    self.context.mode,
                    self.context.scope,
                    self.context.competition,
                )
                readout_context = (
                    readout.context.playerId,
                    readout.context.idNamespace,
                    readout.context.season,
                    readout.context.mode,
                    readout.context.scope,
                    readout.context.competition,
                )
                if readout_context != expected_context:
                    raise ValueError(
                        "duel-press readout context must match the enclosing contextual side"
                    )
                if (
                    readout.player.id != self.player.playerId
                    or readout.player.idNamespace != self.player.idNamespace
                ):
                    raise ValueError(
                        "duel-press readout player identity must match the enclosing contextual side"
                    )
        elif any(value is not None for value in (self.summary, self.detail, self.dataQuality, self.tacticalQuadrant, *duel)):
            raise ValueError("non-resolved contextual side cannot carry player data")
        elif any(reason != "unavailable" for _, reason, _ in companions):
            raise ValueError("non-resolved contextual side requires unavailable component reasons")
        return self


class ContextualCompareEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    comparisonVersion: ContextualCompareVersion = "contextual-compare-v1"
    left: ContextualCompareSide
    right: ContextualCompareSide


VolumeBenchmarkReason = Literal[
    "complete", "partial_source_imputed", "benchmark_source_unavailable",
]
VolumeBenchmarkAxisId = Literal[
    "outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl",
]


class VolumeBenchmarkSourceContext(BaseModel):
    """Echo the selected player context, not the domestic benchmark context."""

    model_config = ConfigDict(extra="forbid")

    mode: LeaderboardMode
    scope: Literal[3, 5, 7, 8] | None = None
    competition: CompetitionCode | None = None

    @model_validator(mode="after")
    def validate_context(self) -> "VolumeBenchmarkSourceContext":
        if self.mode == "league" and (self.scope is None or self.competition is not None):
            raise ValueError("league source context requires scope and null competition")
        if self.mode == "europe" and (self.scope is not None or self.competition is None):
            raise ValueError("europe source context requires null scope and competition")
        return self


class VolumeBenchmarkDescriptor(BaseModel):
    model_config = ConfigDict(extra="forbid")

    label: Literal["8-league avg"] = "8-league avg"
    mode: Literal["league"] = "league"
    scope: Literal[8] = 8


class VolumeBenchmarkAxis(BaseModel):
    """One volume axis projected onto the domestic eight-league population."""

    model_config = ConfigDict(extra="forbid")

    id: VolumeBenchmarkAxisId
    label: str = Field(min_length=1)
    playerScore: float = Field(ge=0, le=100)
    averageScore: float = Field(ge=0, le=100)
    playerRawValue: float | None = None
    averageRawValue: float | None = None
    playerRank: int | None = Field(default=None, ge=1)
    population: int = Field(ge=0)
    tier: Literal["S", "A", "B", "C", "D"]
    imputed: bool

    @model_validator(mode="after")
    def validate_rank(self) -> "VolumeBenchmarkAxis":
        if self.playerRank is not None and self.playerRank > self.population:
            raise ValueError("playerRank must not exceed population")
        return self


class VolumeBenchmarkData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    idNamespace: Literal["fotmob"] = "fotmob"
    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    sourceContext: VolumeBenchmarkSourceContext
    benchmark: VolumeBenchmarkDescriptor = Field(default_factory=VolumeBenchmarkDescriptor)
    available: bool
    reason: VolumeBenchmarkReason
    axes: list[VolumeBenchmarkAxis] = Field(max_length=6)

    @model_validator(mode="after")
    def validate_axes(self) -> "VolumeBenchmarkData":
        expected = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"]
        actual = [axis.id for axis in self.axes]
        if self.available:
            if self.reason not in {"complete", "partial_source_imputed"}:
                raise ValueError("available volume benchmark requires a complete or imputed source reason")
            if actual != expected:
                raise ValueError("available volume benchmark must return the six canonical axes in order")
        else:
            if self.reason != "benchmark_source_unavailable":
                raise ValueError("unavailable volume benchmark requires benchmark_source_unavailable")
            if actual:
                raise ValueError("unavailable volume benchmark must return an empty axes array")
        return self


class VolumeBenchmarkEnvelope(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal["1.0.0"] = "1.0.0"
    data: VolumeBenchmarkData


RatioBenchmarkReason = Literal[
    "complete", "partial_source_imputed", "benchmark_source_unavailable",
]


class RatioBenchmarkDescriptor(VolumeBenchmarkDescriptor):
    """Fixed domestic benchmark identity for the Ratio radar companion."""

    kind: Literal["ratio"] = "ratio"


class RatioBenchmarkAxis(VolumeBenchmarkAxis):
    """Ratio-axis payload; field semantics intentionally match Volume v1."""


class RatioBenchmarkData(BaseModel):
    """Ratio axes projected onto the exact domestic eight-league cohort."""

    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    idNamespace: Literal["fotmob"] = "fotmob"
    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    sourceContext: VolumeBenchmarkSourceContext
    benchmark: RatioBenchmarkDescriptor = Field(default_factory=RatioBenchmarkDescriptor)
    available: bool
    reason: RatioBenchmarkReason
    axes: list[RatioBenchmarkAxis] = Field(max_length=6)

    @model_validator(mode="after")
    def validate_axes(self) -> "RatioBenchmarkData":
        expected = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"]
        actual = [axis.id for axis in self.axes]
        if self.available:
            if self.reason not in {"complete", "partial_source_imputed"}:
                raise ValueError("available ratio benchmark requires a complete or imputed source reason")
            if actual != expected:
                raise ValueError("available ratio benchmark must return the six canonical axes in order")
        else:
            if self.reason != "benchmark_source_unavailable":
                raise ValueError("unavailable ratio benchmark requires benchmark_source_unavailable")
            if actual:
                raise ValueError("unavailable ratio benchmark must return an empty axes array")
        return self


class RatioBenchmarkEnvelope(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [{
                "schemaVersion": "1.0.0",
                "data": {
                    "playerId": 194165, "idNamespace": "fotmob", "season": "2025/2026",
                    "sourceContext": {"mode": "league", "scope": 8, "competition": None},
                    "benchmark": {"label": "8-league avg", "mode": "league", "scope": 8, "kind": "ratio"},
                    "available": False, "reason": "benchmark_source_unavailable", "axes": [],
                },
            }],
        },
    )

    schemaVersion: Literal["1.0.0"] = "1.0.0"
    data: RatioBenchmarkData


TacticalSummaryReason = Literal[
    "complete", "partial_source_imputed", "summary_source_unavailable",
]
TacticalSummaryLineId = Literal["positioning", "movement", "activity"]


class TacticalSummaryLine(BaseModel):
    """Server-authored display copy from tactical-summary-v1 rules."""

    model_config = ConfigDict(extra="forbid")

    id: TacticalSummaryLineId
    text: str = Field(min_length=1, max_length=280)
    imputed: bool


class TacticalSummaryData(BaseModel):
    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    idNamespace: Literal["fotmob"] = "fotmob"
    season: str = Field(pattern=r"^20\d{2}/20\d{2}$")
    sourceContext: VolumeBenchmarkSourceContext
    available: bool
    reason: TacticalSummaryReason
    lines: list[TacticalSummaryLine] = Field(max_length=3)

    @model_validator(mode="after")
    def validate_lines(self) -> "TacticalSummaryData":
        expected = ["positioning", "movement", "activity"]
        actual = [line.id for line in self.lines]
        if self.available:
            if self.reason not in {"complete", "partial_source_imputed"}:
                raise ValueError("available tactical summary requires a complete or imputed source reason")
            if actual != expected:
                raise ValueError("available tactical summary must return three canonical lines in order")
            imputed = [line.imputed for line in self.lines]
            if self.reason == "complete" and any(imputed):
                raise ValueError("complete tactical summary cannot contain imputed lines")
            if self.reason == "partial_source_imputed" and not any(imputed):
                raise ValueError("partial tactical summary requires an imputed line")
        else:
            if self.reason != "summary_source_unavailable":
                raise ValueError("unavailable tactical summary requires summary_source_unavailable")
            if actual:
                raise ValueError("unavailable tactical summary must return an empty lines array")
        return self


class TacticalSummaryEnvelope(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        json_schema_extra={
            "examples": [{
                "schemaVersion": "1.0.0",
                "data": {
                    "playerId": 194165, "idNamespace": "fotmob", "season": "2025/2026",
                    "sourceContext": {"mode": "league", "scope": 8, "competition": None},
                    "available": True, "reason": "complete",
                    "lines": [
                        {"id": "positioning", "text": "박스 중심 위치선정형", "imputed": False},
                        {"id": "movement", "text": "중앙 침투형", "imputed": False},
                        {"id": "activity", "text": "핵심 반경 균형형", "imputed": False},
                    ],
                },
            }],
        },
    )

    schemaVersion: Literal["1.0.0"] = "1.0.0"
    data: TacticalSummaryData


class DuelSpatialAnalysis(BaseModel):
    """Opt-in contract; kept outside strict PlayerAnalysis for v2 compatibility."""

    model_config = ConfigDict(extra="forbid")

    playerId: int = Field(gt=0)
    season: str
    mode: LeaderboardMode
    scope: Literal[3, 5, 7, 8] | None = None
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
    scope: Literal[3, 5, 7, 8] | None = None
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
    scope: Literal[3, 5, 7, 8] | None = None
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
    scope: Literal[3, 5, 7, 8] | None = None
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
