# Heat Ratio static data

`tactical_3zone_ratio.csv` is the primary Heat Ratio source loaded by the
dashboard; `tactical_ratio.csv` is retained only as a legacy fallback.
Run `python scripts/build_tactical_ratios.py` with `SPORTSAPIPRO_API_KEY` set
to refresh it. The ETL uses `fotmob_player_map.csv` to bridge SportsAPI and
FotMob's different player IDs; rows without a verified mapping are emitted to
`data/unmatched_sportsapi_players.csv` rather than guessed.

`data/missing_tactical_sessions.csv` is the complete comparison-cohort audit.
Each row identifies one player/competition/season session that exists in the
static S.P.E.A.R. cohort but still has no stored tactical heatmap. Unlike the
per-run unmatched report, it is rebuilt across every cached season whenever
the tactical ETL checkpoints data.

The dashboard accepts an empty file. At a final-third slider value of `0%`,
players without an ETL row remain visible for backwards compatibility. At any
higher value, they are excluded until their Heat Ratio has been loaded.

## Spatial duel source contract

Spatially weighted ground/aerial duel scores require provider event records
containing all of: stable event ID, player ID, competition-season, duel type
(`ground` or `aerial`), outcome, x/y coordinates, attacking direction, and
minutes played. Coordinates must be normalized to a 0..100 pitch attacking
left-to-right. Before publication, event win counts must reconcile with the
season aggregate `duels_won` and `aerial_duels_won`; incomplete sessions are
unavailable and must not enter the percentile baseline.

`tactical_heatmap_points.json` is explicitly not a valid source: its points
describe general activity and contain neither duel type nor outcome. Until a
complete event-coordinate snapshot is collected, the opt-in
`/api/v2/players/{id}/duel-spatial` endpoint returns
`event_coordinates_unavailable`, and the existing M.E.S.S.I. duel sectors are
left unchanged.
