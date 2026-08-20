# 프론트엔드 인계서 — Duel/Press Companion API 최종 계약

## 릴리스 식별자

- API release: `2.3.0`
- companion schema: `1.1.0`
- metric discriminator: `duel-press-v1`
- 데이터 준비 신호: `pressing-source-coverage-2026-08-18`
- 5시즌 source coverage: `6061 / 6157 = 98.4408%`

## URL

- API base / Preview integration base: `https://forward-scouting-report.onrender.com`
- Swagger: `https://forward-scouting-report.onrender.com/docs`
- OpenAPI: `https://forward-scouting-report.onrender.com/openapi.json`
- Leaderboard: `GET /api/v2/leaderboards/duel-press`
- Player detail: `GET /api/v2/players/{playerId}/duel-press`

Vercel Production과 이 프로젝트의 immutable Preview origin은 같은 Render API를 사용합니다.

## 최상위 discriminator

두 endpoint 모두 반드시 응답 최상위에서만 다음 필드를 반환합니다.

```json
{"metricTaxonomyVersion": "duel-press-v1"}
```

`meta`나 개별 `data` player에 discriminator가 중복되지 않습니다. 프론트엔드는 최상위
값이 정확히 일치할 때만 신규 UI를 활성화해야 합니다.

## Leaderboard 성공 계약

완전한 JSON fixture:

- `docs/fixtures/duel_press_v1/valid_leaderboard.json`

지원 query:

```text
season, mode, scope, competition, page, pageSize, sort, order,
role, position, ageBand, minutesBand, q
```

- `pageSize`는 정확히 `50`만 허용합니다.
- 신규 sort: `combinedDuel`, `forwardPress`
- 동점은 요청 방향과 무관하게 `rank ASC`, 이후 `id ASC`입니다.
- 필터 적용 후 `totalItems`, `totalPages`, `hasNextPage`를 계산합니다.
- `meta.applied`는 서버가 실제 적용한 canonical 값을 반환합니다.

빈 필터 결과는 HTTP 200입니다.

```json
{
  "metricTaxonomyVersion": "duel-press-v1",
  "data": [],
  "meta": {
    "population": 0,
    "returned": 0,
    "page": 1,
    "pageSize": 50,
    "totalItems": 0,
    "totalPages": 0,
    "hasNextPage": false
  }
}
```

범위를 초과한 page도 HTTP 200과 `data: []`을 반환하며, 요청 page와 실제
`totalItems`/`totalPages`는 유지합니다. `hasNextPage`는 `false`입니다.

## Player detail 성공 계약

완전한 JSON fixture:

- `docs/fixtures/duel_press_v1/valid_player_detail.json`

응답의 `context`는 실제 조회에 사용한 문맥을 echo합니다.

```json
{
  "metricTaxonomyVersion": "duel-press-v1",
  "context": {
    "playerId": 194165,
    "idNamespace": "fotmob",
    "season": "2025/2026",
    "mode": "league",
    "scope": 8,
    "competition": null
  },
  "data": {}
}
```

- `mode=league`: `scope`는 3/5/7/8, `competition`은 `null`
- `mode=europe`: `scope`는 `null`, `competition`은 all/ucl/uel/uecl
- `data.id`, `context.playerId`, legacy player/detail/compare/Watchlist의 player id는 모두
  같은 FotMob id입니다.
- `data.idNamespace`와 `context.idNamespace`는 항상 `fotmob`입니다.

## Raw metric nullability

| Source | Total | Per90 | 의미 |
|---|---|---|---|
| `player_season_total` | 반드시 숫자, 0 허용 | 반드시 숫자, 0 허용 | 실제 선수 시즌 합계 |
| `league_per90_fallback` | 반드시 숫자, 0 허용 | 반드시 숫자, 0 허용 | 리그 per90 fallback으로 복원한 시즌 호환 합계 |
| `null` | 반드시 `null` | 반드시 `null` | unavailable |

서버 Pydantic validator가 위 조합 외 payload를 거부합니다.

- `0`은 실제 관측된 0입니다.
- `null`은 데이터가 없음을 뜻합니다.
- 프론트엔드는 `null`을 0점 또는 0회로 변환하면 안 됩니다.

관련 fixture:

- `null_raw_metrics.json`
- `observed_zero.json`
- `source_variants.json`

## 오류 계약

| 상황 | Status | Body |
|---|---:|---|
| 지원하지 않는 season | 404 | `{"detail":"No static cohort is available for season ..."}` |
| player가 선택 문맥에 없음 | 404 | `{"detail":"Player is not in the selected leaderboard"}` |
| 유럽대회 snapshot 없음 | 404 | `{"detail":"This competition is unavailable for the selected season"}` |
| 잘못된 enum/sort/pageSize | 422 | FastAPI validation detail array |
| `mode=league` + competition != all | 422 | `{"detail":"competition must be 'all' when mode is 'league'"}` |

지원하지 않는 `sort=aerial` 예시:

```json
{
  "detail": [{
    "type": "literal_error",
    "loc": ["query", "sort"],
    "input": "aerial"
  }]
}
```

## 지원 범위와 CORS

- 시즌: 2021/2022~2025/2026
- mode: league/europe
- domestic scope: 3/5/7/8
- scope 8에 Belgian Pro League(`league_id=40`) 포함
- competition 문맥은 요청별로 독립 조회
- 허용 Production origin: `https://forward-scouting-report-6dn7-tau.vercel.app`
- 허용 Preview pattern: `https://forward-scouting-report-6dn7-*-messiflick.vercel.app`
- `allow_credentials=false`
- hostile origin에는 `Access-Control-Allow-Origin`을 반환하지 않음

## 전달 fixture 목록

1. `valid_leaderboard.json`
2. `valid_player_detail.json`
3. `null_raw_metrics.json`
4. `observed_zero.json`
5. `source_variants.json`
6. `invalid_discriminator.json`
7. `cross_season_competition.json`

`invalid_discriminator.json`은 strict parser가 반드시 거부해야 합니다.

## 프론트엔드 활성화 순서

1. 최상위 `metricTaxonomyVersion` discriminator가 있는 별도 strict Zod schema 추가
2. fixture 7종을 frontend contract test에 복사 또는 import
3. leaderboard URL을 companion endpoint로 전환
4. `aerial`/`groundDuel`을 `combinedDuel`/`forwardPress`로 교체
5. detail과 Compare는 저장된 각 context로 독립 호출
6. Preview origin에서 preflight, 빈 결과, page 초과, null/zero 렌더링 QA
7. Production 활성화
