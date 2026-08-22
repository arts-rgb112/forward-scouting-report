# stat-pairs-v2 source coverage and backfill policy

`duel-press-v2` is a static-data API. The leaderboard, player, and
detail-metrics routes read one cached static frame and must never make a
SportsAPI Pro (or other provider) request.

## Coverage policy

A normal v2 cohort contains every player with a canonical static detail row in
the selected context. A field is **observed** only when its named raw source is
present; zero is observed and is never treated as missing. A derived total or
per-90 value is emitted only from those observed inputs and carries its formula
provenance.

If one or more source fields are absent, the player remains in the normal
cohort. The affected datum is `unavailable`, the pair exposes
`pairState`/`pairReason`, the category becomes `scoreState: imputed` with its
raw `imputedComponents`, and the overall rating becomes `imputed`. This exact
category payload is shared by the leaderboard and player/detail endpoints, so
source absence cannot be hidden by a summary score.

No raw detail row for the selected player/context means the v2 player and
detail endpoints return unavailable rather than constructing a substitute
record.

## Ingestion-only backfill gate

`scripts/audit_duel_press_v2_sources.py` writes
`data/missing_duel_press_v2_sources.csv` from the canonical cohort and
tactical static data. Its required fields are:

- `playerId`, `name`, `season`, `mode`, `scope`, and `competition`;
- `missingFields`, `derivableFields`, `requiredProviderInputs`,
  `providerLookupResult`, `reason`, and `timestamp`.

The static audit deliberately reports the currently blocked result
`not_attempted_no_verified_sportsapi_raw_duel_schema`. Existing SportsAPI code
has configured keys and paths for search, tournament metadata, top-player
identity, and heatmaps, but no verified raw aerial wins-and-attempts response
schema. `requiredProviderInputs` names the exact identity, context, raw
wins/attempts, and count-unit evidence required before an adapter can run. The
audit is evidence for a future ingestion run, not a provider probe and not an
authorization to invent a value.

A SportsAPI Pro adapter may backfill a missing field only when all of these
are recorded in the backfill run and release QA evidence:

1. A verified FotMob-to-SportsAPI mapping identifies exactly one player.
2. The provider record has the same season and competition context.
3. The provider field has the same metric semantics, unit, aggregation, and
   observed-zero behavior as the v2 raw field.
4. The adapter persists the provider-observed value and provenance into the
   canonical static source before deployment; it does not calculate a
   replacement from another metric.

The adapter writes its exact duel attempts into the v2 internal detail frame
as `ground_duel_attempts_provider_raw` and
`aerial_duel_attempts_provider_raw`. Legacy `DecisionMetrics`, legacy ranking
inputs, and every v1 DTO continue to use only their original rate-derived
calculation; they never consume those v2-only columns.

### Aerial success rate exception

An aerial success rate is allowed to be calculated only from two
provider-observed totals in the same verified player/season/mode/competition
record: `aerial_duels_won` and `aerial_duel_attempts_raw`. Wins by themselves
are insufficient. When both exist and the provider rate is absent, v2 exposes
the rate as `state: observed`,
`source: provider_wins_attempts_derived_rate`, and
`formulaId: provider_wins_attempts_derived_rate`; the rate is
`wins / attempts * 100`. The audit records this case in `derivableFields`
rather than marking a made-up rate as observed.

If either wins or attempts is absent, the rate stays unavailable and the audit
lists the missing input separately. It must not be reconstructed from a score,
another competition, another season, or a player with a similar identity.

### Explicit zero attempts

An exact-context persisted provider/static attempt total of `0` is an observed
zero, not source absence. For both ground and aerial duels, v2 emits numeric
zero attempts, wins, losses, per-90 values, and a displayable zero success
rate. The zero-derived wins/rate carries `source: zero_attempts_observed` and
`formulaId: zero_attempts_floor` so clients never infer this policy.

A loss of zero produced by zero attempts is not a low-loss achievement. Its
comparison uses `state: zero_attempts_floor` and `percentileScore: 0`, with
the category calculator using the same server-owned floor. Blank attempts are
never coerced to zero. In particular, Yamal's current 2025/26 blank aerial
inputs remain unavailable/imputed until a verified, reproducible zero source
is persisted through ingestion.

## Europe context mapping

The audit maps `Champions League`/`UEFA Champions League`/`UCL` to `ucl`,
`Europa League`/`UEFA Europa League`/`UEL` to `uel`, and
`Conference League`/`UEFA Europa Conference League`/`UECL` to `uecl`. All use
`mode: europe`, null/empty scope, and their canonical UEFA tactical source
name; this prevents domestic-mode labels or alias mismatch from producing
false static tactical gaps.

If any gate fails—provider absence, ambiguous identity/context, or different
metric semantics—the audit records the lookup result and reason, while the API
continues to expose `unavailable`/`imputed`. Provider collection and
normalization are therefore an explicit ingestion/backfill job, never part of
the player-detail request path.

## Release QA

Run the audit after each static cohort/tactical refresh, retain its CSV with
the release evidence, and verify that no new unreviewed source gaps were
introduced. The representative 2025/26 Lamine Yamal fixture and test pin the
important case: his static tactical source exists, but the canonical cohort
lacks both aerial wins and aerial attempts. v2 must expose that absence rather
than silently rerating him from a guessed replacement. The paired
wins+attempts derivable-rate fixture separately guards the allowed formula.
