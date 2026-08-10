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
