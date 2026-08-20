# M.E.S.S.I. 능력치 전체 순위 Companion API 인계서

## Release gate

- Endpoint: `POST /api/v2/metric-ranks`
- Success discriminator: top-level `schemaVersion: "1.0.0"`
- Metric taxonomy: `duel-press-v1`
- The frontend must keep the all-rank UI disabled until this endpoint is deployed to Production and strict fixtures pass.

## Request

```json
{
  "entries": [
    {
      "key": "stable-browser-key",
      "player": {"idNamespace": "fotmob", "playerId": 194165},
      "metricTaxonomyVersion": "duel-press-v1",
      "context": {
        "season": "2025/2026",
        "mode": "league",
        "scope": 8,
        "competition": "all"
      }
    }
  ]
}
```

Rules:

- 1–50 entries, unique `key`, JSON body at most 64 KiB.
- All request and response objects forbid unknown fields.
- League context: `scope` is 3/5/7/8 and `competition` is `"all"`.
- Europe context: `scope` is `null`; `competition` is `all`, `ucl`, `uel`, or `uecl`.
- A duplicate key or malformed/extra field returns 422. A body over 64 KiB returns 413.

## Response

Results preserve input order and echo `key`, `player`, `metricTaxonomyVersion`, and `context` exactly.

```json
{
  "schemaVersion": "1.0.0",
  "results": [
    {
      "key": "stable-browser-key",
      "player": {"idNamespace": "fotmob", "playerId": 194165},
      "metricTaxonomyVersion": "duel-press-v1",
      "context": {"season": "2025/2026", "mode": "league", "scope": 8, "competition": "all"},
      "status": "resolved",
      "metrics": {
        "outsideShot": {"rank": 14, "population": 673},
        "boxThreat": {"rank": 2, "population": 673},
        "dangerZone": {"rank": 22, "population": 673},
        "combinedDuel": {"rank": 41, "population": 673},
        "spaceControl": {"rank": 31, "population": 673},
        "forwardPress": {"rank": 17, "population": 673}
      }
    }
  ]
}
```

`resolved` returns exactly the six metric keys above. `unavailable` and `invalid_context` always return `metrics: null`.

- `rank` is a positive integer or `null`.
- `population` is a nonnegative integer.
- When rank is present, `rank <= population`.
- `0` is not used as a missing rank sentinel.

## Ranking rules

- Rankings ignore current page, search, role, position, age, minutes, and sort filters.
- The exact season/mode/scope/competition's complete eligible `duel-press-v1` cohort is used.
- Equal scores share rank: `1 + count(score > selectedScore)`.
- The backend groups a batch by taxonomy and context and reads each cohort once.

## CORS and fixtures

- Allowed browser origins: Production `https://forward-scouting-report-6dn7-tau.vercel.app` and immutable project preview hosts matching `https://forward-scouting-report-6dn7-*-messiflick.vercel.app`.
- Credentials are disabled. Hostile origins receive no ACAO header.
- Fixtures: `docs/fixtures/metric_ranks_v1/valid_response.json`, `null_metric.json`, and `invalid_extra_field.json`.
- Swagger/OpenAPI: `/openapi.json` and `/docs` on the deployed API origin.
