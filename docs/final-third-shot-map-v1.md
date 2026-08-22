# Final Third Shot Map v1

`GET /api/v2/players/{playerId}/final-third-shot-map` is an additive,
snapshot-only player companion endpoint. It does not make a provider request.

## Context

Query parameters are `season`, `mode`, `scope`, `competition`, and
`depthBand`. `depthBand=front2` is the only accepted value; `front3` and all
other values receive HTTP 422. League requests require `competition=all` and
echo a numeric `scope` with `competition: null`. Europe requests echo
`scope: null` and the selected `all|ucl|uel|uecl` competition.

The envelope is strict (`schemaVersion: 1.0.0`,
`chartTaxonomyVersion: final-third-shot-map-v1`). It always contains these
taxonomy tiles in exactly this order:

```text
depth6_lane1 ... depth6_lane5
depth5_lane1 ... depth5_lane5
```

They are server-owned positional-grid identities. A presentation may rotate
and reflect them or use equal hex tiles, but that does not change their
physical-grid provenance.

## Null, zero, and coverage semantics

`shotsTotal: 0` and `goals: 0` mean an observed zero-attempt tile. Its
`conversionRatePct` and `qualityScore` are `null` with an explicit
`no_attempts_in_zone` field state; a client must not turn either into zero.
For positive volume, zero goals produces numeric `conversionRatePct: 0`.

Quality uses only source events with both finite xG and xGOT:

```text
average(xGOT) - average(xG)
```

Missing xGOT/xG is never coerced to zero. The affected zone's quality field is
`partial` or `unavailable`, and `partialCoverage` names the zone and cause.
No selected-context snapshot returns an unavailable envelope and ten
unavailable tiles, never a fabricated zero-volume result. Snapshot keys are
competition-scoped: an exact Europe request may only read its matching
UEFA-session key, never a domestic league-season key. `competition=all` is a
union of the player's exact UCL, UEL, and UECL session shards for that season;
it never chooses an arbitrary first tournament. A missing member makes a
non-empty union `partial` and is named in `partialCoverage`; a union with no
committed member returns the explicit unavailable envelope.
Because a partial union's counts and rates describe only a known subset, every
tile's `volume` and `conversionRatePct` field state (and the tile state) is
`partial` with the same missing-competition reason. `qualityScore` is likewise
`partial` when the available member supplies an eligible xG/xGOT subset; it
remains explicitly `unavailable` when that subset has no eligible quality
events. Numeric values remain the authoritative observed subset rather than
fabricated whole-context estimates.

## Goal-mouth coordinates and identifiers

`pitchX`/`pitchY` are source normalized pitch coordinates. For valid
`goal_mouth` trajectories, `goalMouthY` maps provider goal-line position to a
normalized 7.32m goal width, and `goalMouthZ` maps metres to the 2.44m
crossbar height. Values are intentionally not clamped: off-post/off-crossbar
shots remain representable outside `0..1`.

Blocked trajectories are pitch terminal-block locations, not goal-mouth
coordinates. Blocked shots therefore retain their event, xG, status and zone
total while exposing null goal-mouth coordinates and
`blocked_has_no_goal_mouth_endpoint`. `endpointUnavailableCount` and
`endpointUnavailableShotIds` support a visible unplotted list. A non-blocked
source endpoint missing a valid crossing/height is listed in `partialCoverage`.

The original snapshot format did not retain FotMob event IDs. New ETL runs
preserve an explicit provider `eventId`/`shotId`/`id` when supplied and expose
`shotIdSource: provider_event`. Existing shards expose
`shotIdSource: snapshot_record`: a SHA-256 identity over the complete stored
record plus an occurrence suffix for byte-identical records. This is stable
for the immutable committed snapshot and is deliberately not labelled a
provider event ID. The snapshot builder preserves source-list order, so the
suffix only disambiguates otherwise indistinguishable records.

## Cache and CORS

Aggregates are cached by player/context and the target season shard's
mtime/size revision. A static refresh invalidates the aggregate without
provider fan-out. The endpoint uses the existing exact production/immutable
preview CORS allowlist with `allow_credentials=false`; hostile origins receive
no `Access-Control-Allow-Origin` header.

## Snapshot coverage audit

`scripts/audit_final_third_shotmap_coverage.py` reads only committed tactical
rows and shotmap shards. It writes
`data/final_third_shotmap_coverage.csv` (coverage by exact API context family)
and `data/final_third_shotmap_unavailable_contexts.csv` (player/context keys
that still have no source snapshot). Domestic scope entries are repeated only
where that league is eligible for the requested comparison scope. European
entries retain their exact `ucl`, `uel`, or `uecl` code and also include the
real `all` union context. The report distinguishes full availability,
partially sourced unions, and unavailable contexts, and reads each season
shard with the same lookup used by the API.
