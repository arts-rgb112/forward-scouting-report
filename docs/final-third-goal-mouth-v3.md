# Final Third Shot Chart: Goal-Mouth v3

`GET /api/v2/players/{playerId}/final-third-shot-map` supports the opt-in
query `conversionVersion=goal-mouth-v3`.

It preserves the effective-shot v2 zones, shots, endpoint rules and exact
`front2` context, while returning this additional, server-owned caption
object:

```json
"shootingQuality": {
  "totalShotCount": 118,
  "eligibleShotCount": 90,
  "xgTotal": 15.42,
  "xgotTotal": 17.01,
  "xgotMinusXg": 1.59,
  "state": "partial",
  "reason": "xgot_or_xg_unavailable_for_28_front_two_shots",
  "source": "player_season_shot_events",
  "formulaVersion": "sum-xgot-minus-sum-xg-v1"
}
```

`xgotMinusXg` is `sum(xGOT) - sum(xG)` over only source events that contain
both finite values. It is never calculated in the browser. `state=partial`
keeps the eligible-event total and names the omitted records; `unavailable`
uses null values and an explicit reason. Observed numeric zero remains zero.

The endpoint does not change source pitch coordinates, goal-mouth endpoints,
blocked-shot handling, ten-zone order, or the v1/v2 contracts. Clients must
only request v3 after validating schema `3.0.0` and taxonomy
`final-third-shot-map-goal-mouth-v3`.
