# duel-press-v1 frontend fixtures

- `valid_leaderboard.json`: complete successful leaderboard envelope.
- `valid_player_detail.json`: complete successful detail envelope with canonical context.
- `null_raw_metrics.json`: valid unavailable raw-metric fragment. All source, total, and per90 fields are null.
- `observed_zero.json`: valid observed-zero fragment. Zero remains numeric and has a non-null source.
- `source_variants.json`: the three supported source states.
- `invalid_discriminator.json`: intentionally invalid and must fail a strict `duel-press-v1` parser.
- `cross_season_competition.json`: two independent requests and the contexts each response must echo.

These files are contract fixtures, not mutable production snapshots. Player ids use the
`fotmob` namespace and are compatible with legacy player, detail, compare, and Watchlist ids.
