# duel-press-v1 detail readouts — frontend handoff

## Additive endpoint

`GET /api/v2/players/{playerId}/duel-press/detail-metrics`

Query semantics are canonical and identical to the existing companion:

- League: `season`, `mode=league`, `scope=3|5|7|8`, `competition=all`.
  Response context echoes `scope` and `competition: null`.
- Europe: `season`, `mode=europe`, `competition=all|ucl|uel|uecl`.
  Response context echoes `scope: null` and the selected competition.
- `playerId` is a FotMob id. The response has `context.idNamespace` and
  `player.idNamespace` set to `fotmob`.

The root discriminators are exact literals:

```json
{
  "metricTaxonomyVersion": "duel-press-v1",
  "readoutVersion": "detail-readout-v1"
}
```

All response objects are strict (`additionalProperties: false`). The endpoint
is GET-only, uses the current companion CORS policy, omits credentials, sends
`Cache-Control: public, max-age=300, stale-while-revalidate=3600`, and only
reads the precomputed static cohort/frame—no player-provider calls occur.

## Ordered payload

`categories` is always exactly:

1. `outsideShot`
2. `boxThreat`
3. `dangerZone`
4. `combinedDuel`
5. `spaceControl`
6. `forwardPress`

`contextIndicators` is separately and exactly ordered as:

1. `netProgressionPer90`
2. `shootingLuckOrGoalkeeperImpact`

The latter is contextual only: it must not be rendered as a sector score or
included in a M.E.S.S.I. total. Its exact server formula is `goals - xGOT`,
with label **득점 운 · 상대 선방** and `formulaId: goals-minus-xgot-v1`.

Each category contains server-owned `score`, `scoreState`,
`imputedComponents`, exact-context comparison, and ordered raw `readouts`.
Every readout exposes `id`, `label`, `value`, `unit`, `direction`, `source`,
`state`, `comparison`, and, for server derivations, `formulaId` and
`formulaVersion`. `comparison` contains exact-context median/rank/percentile/
population when available.

`combinedDuel` has distinct ground and aerial readouts; it never substitutes
legacy AER/GND scores. It includes attempts, won/lost/margin per 90, and the
provider-backed win rate for each subgroup.

## Legacy bar preservation

All former meaningful horizontal bars are server-returned:

- Danger zone: `successfulDribblesPer90`, `failedDribblesPer90` (lower is
  better), `dribbleMarginPer90`, `dribbleAttempts`, and
  `dangerZoneDensity`.
- Combined duel: `groundWonPer90`, `groundLostPer90`, `duelMarginPer90`,
  `aerialWonPer90`, `aerialLostPer90`, `aerialMarginPer90`, and distinct
  ground/aerial attempts.
- Context: `netProgressionPer90`, `inBoxFinishingGoals`,
  `outsideBoxShotQualityGoals`, and `shootingLuckOrGoalkeeperImpact`.

Outside shot, box threat, space control, and forward press additionally carry
their relevant authoritative component totals and spatial/pressing values.

## State and provenance rules

- A numeric `0` is a real observed or server-derived zero—not unavailable.
- Unavailable input is `value: null`, `state: unavailable`,
  `source: unavailable`; it is never coerced to zero.
- Reconstructed attempt/loss/margin, per-90, finishing, net progression, and
  shooting-luck values are `server_derived` and name their formula/version.
- A sector whose score retained the conservative missing-component floor is
  still numeric but has `scoreState: imputed` and names those source fields in
  `imputedComponents`.
- `forwardPress` retains the established paired total/per90/source invariant.
  A `league_per90_fallback` total is explicitly `server_derived` with
  `formulaId: league-per90-total-v1`; its supplied /90 value remains observed.

For `higher_is_better` and `lower_is_better`, rank one is best. `neutral`
context indicators expose location in the distribution but are not a quality
judgment; the client must not colour or aggregate them as a sector score.

## Compatibility

No existing endpoint, legacy detail DTO, `duel-press` DTO, `metric-ranks`,
volume/ratio benchmark, tactical-quadrant, or Spatial Pitch/trajectory
contract has been changed. Frontend parsing should remain feature-gated until
this exact discriminator/readout-version pair is accepted.
