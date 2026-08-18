# M.E.S.S.I. v2 frontend handoff — combined duels and forward pressing

## Goal

Replace the two separate `aerial` and `groundDuel` dashboard sectors with:

1. `combinedDuel` — combined ground/aerial duel influence
2. `forwardPress` — recoveries plus possession won in the final third

The existing `/api/v2/leaderboards` contract remains unchanged during the
rollout. The frontend must explicitly switch to the companion contract only
after its strict Zod schemas and UI labels are ready.

## Backend endpoints

```http
GET /api/v2/leaderboards/duel-press
GET /api/v2/players/{playerId}/duel-press
```

The leaderboard endpoint accepts the existing server-pagination and filter
parameters:

```text
season, mode, scope, competition, page, pageSize, sort, order,
role, position, ageBand, minutesBand, q
```

New sortable metric keys:

```text
combinedDuel
forwardPress
```

Every new response explicitly carries:

```json
{
  "metricTaxonomyVersion": "duel-press-v1"
}
```

## Six-sector contract

```json
{
  "stats": {
    "outsideShot": 75.2,
    "boxThreat": 81.4,
    "dangerZone": 69.8,
    "combinedDuel": 62.7,
    "spaceControl": 73.1,
    "forwardPress": 78.5
  }
}
```

The overall M.E.S.S.I. score uses:

| Sector | Weight |
|---|---:|
| `boxThreat` | 30% |
| `outsideShot` | 20% |
| `dangerZone` | 15% |
| `spaceControl` | 15% |
| `combinedDuel` | 10% |
| `forwardPress` | 10% |

Do not recalculate the overall score in the browser. Display the server's
`score`, `rank`, and `tier` values.

## Component and raw values

```json
{
  "components": {
    "combinedDuelVolume": 64.2,
    "combinedDuelEfficiency": 61.2,
    "recoveries": 72.4,
    "finalThirdPossessionsWon": 84.6
  },
  "pressingRawMetrics": {
    "recoveries": 77,
    "recoveriesPer90": 2.91,
    "recoveriesSource": "player_season_total",
    "finalThirdPossessionsWon": 15,
    "finalThirdPossessionsWonPer90": 0.57,
    "finalThirdPossessionsWonSource": "player_season_total"
  }
}
```

`components` are already-normalized 0–100 scores. `pressingRawMetrics` are
source totals and per-90 values for detail tooltips and tables.

Valid source values are:

```text
player_season_total
league_per90_fallback
null
```

`null` means unavailable. It must not be rendered as a measured zero.

## Labels

Recommended Korean labels:

| API key | Main label | Short label |
|---|---|---|
| `combinedDuel` | 통합 경합 | 경합 |
| `forwardPress` | 전방 압박 효율 | 전방 압박 |

Recommended forward-press tooltip:

> 파이널 서드에서의 소유권 획득과 경기 전체의 볼 회수 빈도를 동일
> 코호트 백분위로 변환한 뒤 50:50으로 결합한 압박·세컨드볼 회수 지표입니다.

Recommended combined-duel tooltip:

> 지상·공중 경합의 시도량과 승패 마진을 각각 정규화해 균등 결합한
> 종합 경합 영향력입니다.

## Frontend changes

1. Add a new strict `duel-press-v1` Zod response schema. Do not loosen the
   existing legacy schema.
2. Replace `aerial` and `groundDuel` columns/cards with `combinedDuel` and
   `forwardPress` only for versioned `duel-press-v1` responses.
3. Add the two new sort keys to URL/query state and API serialization.
4. Preserve the existing 50-player server pagination behavior.
5. Use `pressingRawMetrics.*Per90` in the detail view; show `-` with an
   unavailable explanation for `null`.
6. Keep existing Watchlist snapshots under their original taxonomy. Do not
   silently relabel stored `aerial` or `groundDuel` values.
7. When a saved player is opened, request the companion player endpoint using
   the saved season/mode/scope/competition context.
8. For Compare, request each selected player's companion endpoint independently
   so cross-season and cross-competition contexts remain isolated.

## Acceptance tests

1. A `duel-press-v1` leaderboard renders exactly six new-taxonomy sectors.
2. Legacy v2 payloads continue to render the old sectors without relabeling.
3. The displayed overall score equals the server response and is not recomputed.
4. Sorting by `combinedDuel` and `forwardPress` uses server pagination.
5. Korean name search and all existing filters continue to work.
6. `null` raw metrics are distinguished from observed zeroes.
7. Player detail and Compare use the correct independent competition context.
8. Existing Watchlist snapshots are not mutated during rollout.
9. Desktop and mobile layouts do not introduce horizontal clipping.
10. Production and Preview Vercel origins pass browser integration QA.

## Activation order

1. Backend code and five-season source snapshots deploy.
2. Frontend adds versioned contracts and UI support.
3. Frontend switches its leaderboard request to the companion endpoint.
4. After production QA, the old metric taxonomy can be deprecated in a
   separate release; it must not be removed as part of this change.
