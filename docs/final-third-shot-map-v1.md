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
unavailable tiles, never a fabricated zero-volume result. Current committed
shot snapshots are domestic league-season sessions; Europe responses are thus
explicitly unavailable until competition-scoped event snapshots are loaded.

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
