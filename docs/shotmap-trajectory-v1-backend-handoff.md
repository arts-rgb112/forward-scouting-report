# Shotmap trajectory v1 backend handoff

## Contract

`SpatialAnalysis.shotmapPoints[]` keeps its existing fields and adds one
optional nullable field:

```json
{
  "trajectory": {
    "schemaVersion": "shotmap-trajectory-v1",
    "endpointKind": "goal_mouth",
    "endX": 100.0,
    "endY": 56.795,
    "endZMeters": 1.17,
    "source": "fotmob"
  }
}
```

- `trajectory` absent/null: the source did not provide a complete valid
  endpoint. A client must not infer or draw one.
- `goal_mouth`: non-blocked shot using source `goalCrossedY` and optional
  `goalCrossedZ`; `endX` is exactly 100.
- `blocked`: blocked shot using both source `blockedX` and `blockedY`;
  `endZMeters` is null.
- `x`, `y`, `endX`, and `endY` use the same 0..100 attacking-left-to-right
  pitch space. FotMob's 105x68 source coordinates are normalized by ETL.
- `endZMeters` remains the source height in metres and is not normalized.
- Every object is strict. Out-of-range values, extra fields, mismatched shot
  outcome/endpoint kind, a non-goal-line `goal_mouth.endX`, and a blocked
  endpoint with height are contract errors.

Snapshot availability, verified zero-shot semantics, and
`shotmapPointCount == len(shotmapPoints)` are unchanged. Player detail and
compare expose the same `ShotmapPoint` contract through their existing
`SpatialAnalysis` envelope.

## Source mapping and preservation

The ETL preserves every source shot with a valid origin. Endpoint validation
is independent: invalid, infinite, partial, or out-of-range endpoint fields
cause only `trajectory` to be omitted. A blocked shot never falls back to a
projected goal-mouth endpoint.

A player-season record whose `stats.shotmap` is missing, null, or not a list
does not prove that the player took zero shots. The refresh therefore preserves
the existing session and emits an explicit workflow warning. Only a source
`shotmap: []` may replace a populated session with a verified zero-shot array.

Legacy five-field snapshot records remain valid and serialize with a null
trajectory under the new API schema. No existing snapshot was modified during
development.

## Baseline audit

Read-only audit against the current five-season shards:

- total shots: 282,913
- valid legacy records under the new schema: 282,913
- invalid records: 0
- enriched trajectory records before backfill: 0
- shots awaiting source re-evaluation by season:
  - 2021/2022: 55,181
  - 2022/2023: 55,852
  - 2023/2024: 56,574
  - 2024/2025: 56,470
  - 2025/2026: 58,836

`scripts/audit_shotmap_coverage.py` now reports total/enriched/invalid counts,
endpoint-kind counts, and unenriched shot counts by season.

## Safe rollout order

1. Frontend accepts the optional strict `shotmap-trajectory-v1` object and
   renders no line for null/unavailable endpoints.
2. Deploy the additive backend schema/service contract. Do not enable any
   frontend line renderer until immutable Preview contract QA passes.
3. Dispatch `Refresh shotmap points` sequentially for 2021/2022 through
   2025/2026 with `refresh_existing=true`. This opt-in is required because the
   normal incremental workflow intentionally skips existing sessions.
4. After every shard, run the existing coverage audit and require zero invalid
   records, unchanged snapshot coverage, and explicit trajectory coverage by
   endpoint kind/season.
5. Run player-detail and compare browser QA for goal, saved/on-target,
   off-target, blocked, null-endpoint, unavailable snapshot, and verified
   zero-shot contexts. Only then enable production rendering.

Mass provider refresh, commit, push, PR, merge, and deployment were deliberately
not performed as part of this local backend design/implementation task.

## Bounded backfill acceleration

The workflow defaults to three player-season workers, but every HTTP attempt
shares a process-wide minimum 0.65-second request-start interval. HTTP 429
`Retry-After` values extend a shared cooldown so already-waiting workers cannot
continue hammering the provider. Retry count and timeout remain bounded.

Workers return indexed immutable results. Only the main thread applies updates,
in original target order, and writes an atomic checkpoint every 50 processed
targets. Unexpected worker failures do not interrupt sibling results: successful
results are checkpointed, then the snapshot step fails explicitly for review.
Existing session keys are checked after every applied result and may not be
removed.

The workflow uses `concurrency.group=shotmap-refresh` with
`cancel-in-progress=false`, preventing simultaneous season writers and git push
conflicts. Worker count is restricted to 1 or 3; five-worker and parallel-season
backfills are intentionally unsupported.
