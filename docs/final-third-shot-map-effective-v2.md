# Final Third Shot Map — Effective conversion v2

`GET /api/v2/players/{playerId}/final-third-shot-map` keeps its released v1
meaning by default: `conversionRatePct = goals / shotsTotal * 100`.

Clients that have a strict v2 parser may opt in with
`conversionVersion=effective-shot-v2`.  That request returns the independent
envelope below and must not be parsed as v1:

```text
schemaVersion: 2.0.0
chartTaxonomyVersion: final-third-shot-map-effective-v2
data.conversionDefinition: effective-on-target-plus-goal-divided-by-shots-v2
```

For each of the fixed ten `front2` zones, v2 additionally returns
`effectiveShotCount`.  The server applies the following formula, rounded to
two decimal places:

```text
effectiveShotCount = count(status in {goal, on_target})
conversionRatePct = effectiveShotCount / shotsTotal * 100
```

Shot event statuses are canonical, mutually exclusive values (`goal`,
`on_target`, `off_target`, `blocked`), so a goal is never counted twice as an
on-target attempt.  `shotsTotal=0` is an observed zero volume:
`effectiveShotCount=0` and `conversionRatePct=null`.  An unavailable source
keeps both volume and numerator `null` with explicit field state/reason.

`fieldStates.effectiveShotCount` is v2-only provenance. It has the same
`observed | partial | unavailable` semantics as the other server-owned zone
fields, and declares formula `status-goal-or-on-target-v2`.  No client may
derive this numerator from the returned shot list.

All context validation, fixed zone order, partial xG/xGOT quality rules,
blocked endpoint handling, static snapshot cache behaviour, and CORS policy
are otherwise unchanged. The canonical source-math fixture is
`docs/fixtures/final_third_shot_map_effective_v2/source_cases.json`.
