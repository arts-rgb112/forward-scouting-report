# Pitch selection and full-activity display — 2026-09-09

Normative additive contracts, implemented locally; final independent gate and owner release approval remain required. Existing `native-pitch-events`, body-part, box-subregion, and full-activity-heatmap endpoints retain their existing shapes and semantics.

## Common request and failure rules

Both GET routes accept positive `playerId`, consecutive-year `season`, `mode=league|europe`, domestic scope 3/5/7/8 (default 8), and competition all/ucl/uel/uecl. League requires competition all and returns null competition. Europe must omit scope and returns null scope. Unknown or duplicate query keys are 422. Unsupported season or player outside the selected cohort is 404. Invalid/corrupt source or contradictory transport is sanitized 500, not invented zero. Successful responses are `Cache-Control: no-store`.

Clients validate the exact requested player, season, mode, scope, competition and PK filter, use abort/generation guards, and cannot show a preceding context's response while loading a new one. No approximate FotMob/SportsAPI event joins or fallback to v1 endpoint semantics are permitted.

## Native selection endpoint

`GET /api/v2/players/{playerId}/native-pitch-events-v2` also accepts `includePenalties=true|false`, default true.

Strict root: `schemaVersion=native-pitch-events-v2`, `context`, `provider=sportsapi`, raw `snapshotRevision`, `includePenalties`, `coordinateDefinition=sportsapi-draw-pitch-display-v1`, `trajectoryDefinition=source-validated-terminal-planar-schematic-v2`, `events`, unchanged convenience envelopes `bodyParts` and `box`, plus `selectionZones`.

Each event retains its own key/identity, bodyPart, shotType/outcome, penalty flag, unrounded source xg/xgot, plot, destination and server-owned paired quality. Events are sorted by mappingKey/matchId/shotId and unique. Public quality is `{xg,xgot,delta,eligible,state}`: each paired operand rounds to four decimals before the server subtracts xGOT−xG; unpaired metrics are null, eligible 0, state unavailable. The UI displays this result; it does not recalculate a public metric from rounded group values.

Destination is `{kind,x,y,observedHeightMeters,reason}`. Height is always null, not a measured flight coordinate.

- Goal: only validated goal-plane projection (`kind=goal_plane`, x=100).
- Save/block: only `kind=block` when BOTH draw.block and blockCoordinates are valid and agree under the provider transform.
- Miss/post: unavailable terminal. A goal-mouth drawing is not evidence of a miss/post terminal.
- Missing, malformed or disagreeing coordinates: unavailable with null x/y and a reason. The record, marker when located, body part and counts remain available.
- Rendering may use explicitly schematic vertical heights and low-arc interpolation, never describe them as recorded flight. Replay and all-trajectories use the same endpoint policy.

### Exact selection geometry

`selectionZones` contains ordered `grid` (30), ordered `box` (4), `gridAccounting`, `boxAccounting`. Grid IDs are depth1_lane1 through depth6_lane5; box IDs L4, L3L, L3R, L2 mean 박스 좌, 박스 중좌, 박스 중우, 박스 우.

Bounds: `{xMinInclusive,xMax,includeMaxX,yMinInclusive,yMax,includeMaxY}`. Each axis tests `value >= min && (value < max || includeMax && value === max)`. Only final grid depth/lane includes 100. Box x is [84.29,100]; y intervals respectively [63,78.18), [50,63), [37,50), [21.82,37). No boundary is double-counted.

Each zone provides id, label, bounds, shots, goals, xg, xgEligible, paired quality, exact five-part summaries (head/rightFoot/leftFoot/other/unknown), shootingSharePct and source `{state,records}`. Observed empty is 0; unobserved is null. Source completeness and metric pairing completeness are separate.

Grid follows the requested PK filter. Box always uses the same raw selected source's non-PK denominator, even when marker/grid view includes PK. Unlocated events retain an accounting bucket. Grid source=assigned+unlocated; box source−penalties=denominator=inRegions+outside+unlocated. Body-part counts reconcile within every zone; zone totals are not approximations of another grid.

Selection card: one event displays only its recorded part and quality; selected zone displays only that zone's server part summaries. Never substitute player totals for a zone. Activity share remains unavailable unless a separately versioned exact server activity-region aggregate is supplied. The 3D anatomical part uses the selected event, not screen-left/screen-right or preferred foot.

## Full-source activity display endpoint

`GET /api/v2/players/{playerId}/full-activity-display-v1` returns strict `{schemaVersion:full-activity-display-v1,context,fullHeat,fullSourceCca}`. It does not accept a PK filter because activity is not a shot event collection.

`fullHeat` preserves the existing full Tier-3 32×22 count histogram: available/reason, definitionVersion, columns/rows, 704 cellCounts, validPointCount, activitySnapshotCount, sourceDefinitionVersion. It never falls back to max-180 score input.

`fullSourceCca` contains available/reason; definitionVersion `full-source-continuous-core-v1`; formulaVersion `fixed-n60-r20-v2`; inputDefinition `sportsapi-data-points-count-expanded-v1`; heatmapDefinition `full-tier3-count-weighted-histogram-32x22-v1`; sourceRevision; coverage expected/observed/missing keys; gridColumns/gridRows; validPointCount; standardizedTarget; raw densityThreshold; normalized thresholdOfPeak; coreAreaPct/ccaAreaPct; containedMassPct; lowSample.

Canonical selected mappings plus exact raw payloads define sourceRevision and the deterministic sampling seed. Count-expanded raw source order is preserved. The reconstructed histogram MUST equal the published fullHeat histogram exactly before CCA is available. Missing/malformed/mismatching raw data leaves the published heat intact and CCA unavailable. The factory requires an explicit published-grid provider and verifies its context before combining it with its raw source provider.

The contour uses the same response's fullHeat with established edge-replicated [1,4,6,4,1]/16 smoothing and that response's normalized thresholdOfPeak. Do not overlay max-180 score CCA onto this full-density layer. Original score CCA, score formulas, CSV and raw/index bytes are unchanged.

Actual Kane evidence: 1,401 points, sourceRevision `87b0d583a5d62b92abf2169476353032e5ef1a174faf04c07dc4a6d6eff2fbf0`, normalized threshold 0.48658798, area 15.4830%. Values computed with the old mapping-key seed are a different comparator, not this endpoint's expected values.

## Reproducible contract evidence

Strict server definitions: native_pitch_v2_contract.py and full_activity_display_contract.py; strict matching browser decoders under src/api. Native source-terminal/canonical fixtures under docs/fixtures/native_pitch_v2; full display scalar proof under docs/fixtures/full_activity_display_v1. Existing five v1 payload fixtures remain byte-identical; provider-only provenance refresh requires validate.py --check-provider-only-refresh to prove every other source pin and payload unchanged before changing only providerSha256.
