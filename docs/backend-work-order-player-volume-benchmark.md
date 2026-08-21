# 백엔드 업무 요청서 — 선수 상세 8대 리그 평균 레이더

## 목적

M.E.S.S.I. 2.0 네이티브 선수 상세 페이지의 Volume 레이더에 선수와 같은 기준으로 정규화된 `8-league avg` 폴리곤을 제공합니다.

현재 프론트엔드는 선수의 6개 Volume 축만 렌더링하며, 평균값을 임의의 50점이나 Ratio/종합 스탯으로 대체하지 않습니다. API가 배포되기 전까지는 `8-league average benchmark unavailable` 상태를 표시합니다.

## 신규 companion API

```http
GET /api/v2/players/{playerId}/volume-benchmark
```

Query:

- `season`: `2021/2022`~`2025/2026`
- `mode`: `league | europe`
- `scope`: league 문맥에서 `3 | 5 | 7 | 8`, Europe에서는 `null`
- `competition`: league에서는 `all`, Europe에서는 `all | ucl | uel | uecl`
- `benchmarkScope`: 반드시 `8`

## 성공 계약

```json
{
  "schemaVersion": "1.0.0",
  "data": {
    "playerId": 194165,
    "idNamespace": "fotmob",
    "season": "2025/2026",
    "sourceContext": {
      "mode": "league",
      "scope": 8,
      "competition": null
    },
    "benchmark": {
      "label": "8-league avg",
      "mode": "league",
      "scope": 8
    },
    "available": true,
    "reason": "complete",
    "axes": [
      {
        "id": "outsideShot",
        "label": "Outside-box shot attempts",
        "playerScore": 88.4,
        "averageScore": 51.2,
        "playerRawValue": 31.0,
        "averageRawValue": 17.4,
        "playerRank": 12,
        "population": 248,
        "tier": "A",
        "imputed": false
      }
    ]
  }
}
```

## 축 계약

`axes`는 아래 순서와 ID로 정확히 6개를 반환합니다.

1. `outsideShot` — Outside-box shot attempts
2. `boxThreat` — Box hits
3. `dangerZone` — Dribble attempts
4. `aerial` — Aerial duel attempts
5. `groundDuel` — Ground duel attempts
6. `spaceControl` — Core activity radius

각 점수는 동일한 8대 리그 코호트를 기준으로 한 0~100 higher-is-better 값이어야 합니다. 평균은 실제 축별 코호트 평균이어야 하며 고정 50점으로 만들지 않습니다.

Europe 선수 문맥도 해당 시즌 국내 8대 리그 기준 분포에 투영하여 선수와 평균이 같은 축·스케일을 사용해야 합니다.

## 데이터 부재 계약

선수는 존재하지만 benchmark를 생성할 수 없다면 HTTP 오류 대신 다음 형태를 권장합니다.

```json
{
  "schemaVersion": "1.0.0",
  "data": {
    "playerId": 194165,
    "idNamespace": "fotmob",
    "season": "2025/2026",
    "sourceContext": {
      "mode": "europe",
      "scope": null,
      "competition": "ucl"
    },
    "benchmark": {
      "label": "8-league avg",
      "mode": "league",
      "scope": 8
    },
    "available": false,
    "reason": "benchmark_source_unavailable",
    "axes": []
  }
}
```

`null`과 관측된 0은 반드시 구분합니다. 축 일부가 대체값이면 `imputed=true`를 반환하고, 원천값과 평균값의 단위를 동일하게 유지합니다.

## 검증 및 오류

- `playerId`, `idNamespace`, `season`, `sourceContext`를 실제 조회 문맥과 동일하게 echo합니다.
- 잘못된 enum, `benchmarkScope != 8`, league/europe 문맥 불일치는 HTTP 422입니다.
- 선수가 선택 문맥에 없으면 기존 player detail과 동일한 404 계약을 사용합니다.
- strict Pydantic schema와 OpenAPI fixture를 제공합니다.
- 기존 `/api/v2/players/{id}` strict 응답에는 필드를 추가하지 않습니다.
- Production 및 Vercel Preview origin CORS를 기존 player companion API와 동일하게 유지합니다.

## 필수 테스트

1. League scope 3/5/7/8 source context에서 benchmark scope는 항상 8.
2. Europe all/UCL/UEL/UECL 문맥에서 독립 조회 및 source context echo.
3. 축의 길이·순서·ID가 정확히 6개.
4. `playerScore`와 `averageScore`가 유한한 0~100 값.
5. 실제 관측 0, `null`, `imputed`의 구분.
6. 동점 분포에서 rank/population의 결정성.
7. 잘못된 player/context/benchmark scope 오류 계약.
8. hostile origin CORS 차단.

## 백엔드 완료 인계 항목

- Render 배포 버전과 OpenAPI URL
- 성공·미제공·관측 0·대체값 fixture
- Production/Preview CORS 확인 결과
- 최소 두 선수의 League 및 Europe 실응답 예시

백엔드 완료 후 프론트는 strict Zod companion schema, 요청 캐시·취소, authoritative average polygon, 오류/미제공 상태 및 Preview/Production 브라우저 QA를 후속 적용합니다.
