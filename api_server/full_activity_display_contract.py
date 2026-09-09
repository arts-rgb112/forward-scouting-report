"""Strict transport for the display-only full-source activity CCA readout.

This endpoint is deliberately separate from scored/static CCA.  Its only job
is to make the live 32x22 full-activity display auditable against the same
raw SportsAPI heatmap records from which it is drawn.
"""
from __future__ import annotations

from typing import Annotated, Literal

from pydantic import Field, model_validator

from api_server.box_subregion_contract import BoxContext, StrictModel


COUNT = Annotated[int, Field(ge=0)]
SHA256 = Annotated[str, Field(pattern=r"^[a-f0-9]{64}$")]
SOURCE_KEY = Annotated[str, Field(pattern=r"^[1-9][0-9]*:[1-9][0-9]*:[1-9][0-9]*$")]


class FullActivityDisplayHeatmap(StrictModel):
    """The pre-existing full-activity grid, copied without recalculation."""

    available: bool
    reason: str | None
    definitionVersion: Literal["full-tier3-count-weighted-histogram-32x22-v1"]
    columns: Literal[32]
    rows: Literal[22]
    cellCounts: list[COUNT] = Field(min_length=704, max_length=704)
    validPointCount: COUNT
    activitySnapshotCount: COUNT
    sourceDefinitionVersion: Literal["sportsapi-heatmap-points-count-weighted-full-v1"]

    @model_validator(mode="after")
    def reconcile(self):
        if self.available:
            if self.reason is not None or sum(self.cellCounts) != self.validPointCount or self.activitySnapshotCount < 1:
                raise ValueError("available full activity grid is inconsistent")
        elif self.reason is None or any(self.cellCounts) or self.validPointCount or self.activitySnapshotCount:
            raise ValueError("unavailable full activity grid must be empty with a reason")
        return self


class FullActivityDisplayCoverage(StrictModel):
    expectedKeys: list[SOURCE_KEY]
    observedKeys: list[SOURCE_KEY]
    missingKeys: list[SOURCE_KEY]

    @model_validator(mode="after")
    def partition(self):
        values = (self.expectedKeys, self.observedKeys, self.missingKeys)
        if any(group != sorted(set(group)) for group in values):
            raise ValueError("full-source coverage keys must be sorted and unique")
        expected, observed, missing = map(set, values)
        if observed & missing or observed | missing != expected:
            raise ValueError("full-source coverage must partition the selected mappings")
        return self


class FullSourceCca(StrictModel):
    """CCA derived from count-expanded raw activity, never score input CCA."""

    available: bool
    reason: str | None
    definitionVersion: Literal["full-source-continuous-core-v1"]
    formulaVersion: Literal["fixed-n60-r20-v2"]
    inputDefinition: Literal["sportsapi-data-points-count-expanded-v1"]
    heatmapDefinition: Literal["full-tier3-count-weighted-histogram-32x22-v1"]
    sourceRevision: SHA256 | None
    coverage: FullActivityDisplayCoverage
    gridColumns: Literal[32]
    gridRows: Literal[22]
    validPointCount: COUNT
    standardizedTarget: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    densityThreshold: float | None = Field(default=None, ge=0, allow_inf_nan=False)
    thresholdOfPeak: float | None = Field(default=None, ge=0, le=1, allow_inf_nan=False)
    coreAreaPct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    ccaAreaPct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    containedMassPct: float | None = Field(default=None, ge=0, le=100, allow_inf_nan=False)
    lowSample: bool

    @model_validator(mode="after")
    def availability(self):
        measures = (self.standardizedTarget, self.densityThreshold, self.thresholdOfPeak, self.coreAreaPct, self.ccaAreaPct, self.containedMassPct)
        full_coverage = not self.coverage.missingKeys
        if self.available:
            if self.reason is not None or self.sourceRevision is None or not full_coverage or self.validPointCount < 1:
                raise ValueError("available full-source CCA requires complete raw source identity")
            if any(value is None for value in measures) or self.ccaAreaPct != self.coreAreaPct:
                raise ValueError("available full-source CCA metrics are inconsistent")
        elif self.reason is None or self.validPointCount != 0 or any(value is not None for value in measures):
            raise ValueError("unavailable full-source CCA must fail closed")
        return self


class FullActivityDisplayEnvelope(StrictModel):
    schemaVersion: Literal["full-activity-display-v1"]
    context: BoxContext
    fullHeat: FullActivityDisplayHeatmap
    fullSourceCca: FullSourceCca
