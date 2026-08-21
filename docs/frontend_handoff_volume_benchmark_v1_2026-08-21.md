# M.E.S.S.I. 2.0 Volume benchmark companion API handoff

## Release gate

Do not enable the authoritative average polygon until the backend release
containing `GET /api/v2/players/{playerId}/volume-benchmark` is deployed and
the Production player-detail health gate is confirmed.  The existing player
detail DTO is intentionally unchanged.

## Request

```http
GET /api/v2/players/{playerId}/volume-benchmark?season=2025%2F2026&mode=league&scope=8&competition=all&benchmarkScope=8
```

- `benchmarkScope` is required to be `8`; any other value is a `422`.
- League source contexts accept scopes `3|5|7|8`, but `data.benchmark` is
  always domestic `8-league avg`.
- Europe requests must omit `scope`, for example
  `?season=2025%2F2026&mode=europe&competition=ucl&benchmarkScope=8`.
- The response is strict: top-level `schemaVersion` is exactly `1.0.0`, and
  no additional fields should be accepted by the client schema.

## Rendering rules

When `data.available` is `true`, render exactly these axes in this order:

1. `outsideShot`
2. `boxThreat`
3. `dangerZone`
4. `aerial`
5. `groundDuel`
6. `spaceControl`

Use `playerScore` and `averageScore` as the two radar polygons.  The average
is an observed cohort mean on the same 0–100 scale; never substitute `50`.
Show raw values only as supplementary information, and keep a real `0`
distinct from `null`.  If `imputed` is `true`, retain the displayed score but
mark that axis as source-incomplete.

When `available` is `false`, `axes` is guaranteed to be empty and `reason` is
`benchmark_source_unavailable`; render the explicit unavailable state rather
than a placeholder polygon.

## Fixtures and QA

The backend repository includes strict fixtures:

- `docs/fixtures/volume_benchmark_v1/success.json`
- `docs/fixtures/volume_benchmark_v1/unavailable.json`
- `docs/fixtures/volume_benchmark_v1/observed_zero.json`

Use request cancellation keyed by player + season + mode + scope + competition
to avoid stale profile updates during navigation.  Production and approved
immutable Vercel Preview origins use the existing companion API CORS policy;
hostile origins must not receive `Access-Control-Allow-Origin`.
