# Native player-detail tactical summary and Ratio benchmark v1

Both contracts are additive companions. They do **not** change
`GET /api/v2/players/{id}`, `tactical-quadrant`, or `volume-benchmark` v1.

## Tactical Summary v1

`GET /api/v2/players/{playerId}/tactical-summary?season=...&mode=league&scope=8&competition=all`

The response is a strict `schemaVersion: "1.0.0"` envelope. For Europe,
omit `scope` and send an allowed competition.

The ordered display lines are backend-owned `tactical-summary-v1` copy:

1. `positioning`: `in_box_ratio >= 30` is box-centred; otherwise it is
   outside-box linking.
2. `movement`: highest share among `lane_1_ratio` … `lane_5_ratio` chooses
   right-wide, right-half-space, central, left-half-space, or left-wide copy.
3. `activity`: continuous 50%-density `cca_area_pct` is concentrated at
   `<=20`, balanced at `<=35`, and wide above `35`.

No browser median, lane, CCA, zone, percentile, or classification calculation
is permitted. If a tactical session is absent, the response is
`available:false`, `reason:"summary_source_unavailable"`, and `lines:[]`.
If only an input line is absent, the response is `partial_source_imputed` and
that line has `imputed:true`.

## Ratio Benchmark v1

`GET /api/v2/players/{playerId}/ratio-benchmark?season=...&mode=league&scope=8&competition=all&benchmarkScope=8`

`benchmarkScope` is required and only `8` is accepted. The response projects
the selected league/Europe raw metrics onto the same fully eligible domestic
8-league cohort used by `get_spear_leaderboard(47, season, 8)`.

Axis calculations mirror `RATIO_RADAR_AXES`:

- outsideShot: shot-quality percentile
- boxThreat: 70% in-box-finishing percentile + 30% deep-box-zone percentile
- dangerZone: 70% dribble-margin percentile + 30% danger-zone-density percentile
- aerial: aerial-margin percentile
- groundDuel: duel-margin percentile
- spaceControl: danger-zone-density percentile

`averageScore` and `averageRawValue` are actual cohort means. Neither is a
fixed 50-point fallback. Observed zero remains `0`; missing raw data is `null`
with `imputed:true`; unavailable cohorts have `axes:[]`.

## Frontend activation gate

Consume the canonical fixtures in `docs/fixtures/tactical_summary_v1/` and
`docs/fixtures/ratio_benchmark_v1/`, validate strict Zod schemas, then pass
build and immutable Preview browser QA. Keep each panel independently
unavailable until its request succeeds; neither companion may block base detail.
