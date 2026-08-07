# Heat Ratio static data

`tactical_ratio.csv` is the only Heat Ratio source loaded by the dashboard.
Run `python scripts/build_tactical_ratios.py` with `SPORTSAPIPRO_API_KEY` set
to refresh it. The ETL uses `fotmob_player_map.csv` to bridge SportsAPI and
FotMob's different player IDs; rows without a verified mapping are emitted to
`data/unmatched_sportsapi_players.csv` rather than guessed.

The dashboard accepts an empty file. At a final-third slider value of `0%`,
players without an ETL row remain visible for backwards compatibility. At any
higher value, they are excluded until their Heat Ratio has been loaded.
