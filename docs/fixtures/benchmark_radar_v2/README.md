# benchmark-radar-v2 fixture contract

`GET /api/v2/players/{playerId}/benchmark-radar-v2` is additive.  It does
not replace `volume-benchmark` or `ratio-benchmark` v1.

- The selected `sourceContext` is exact, including a null league competition
  or null Europe scope.
- `benchmarkContext` is always the same-season domestic league scope 8 frame.
- Axis order is fixed: outsideShot, boxThreat, dangerZone, combinedDuel,
  spaceControl, forwardPress.
- `positionReference` only normalizes Unicode/case/whitespace.  It never
  semantically maps `forward`, `midfielder`, or `defender` to a different role.
- `Coach` remains in the global population, but its position reference is
  unavailable with `position_label_not_player_role`.
- Position samples below 20 keep their measured average with `low_sample` and
  their true population; global values are never substituted.
- `spaceControl` and `forwardPress` Volume axes are explicitly marked
  `radarOnlyRepresentation`; they are benchmark display representations, not
  M.E.S.S.I. scoring inputs.
