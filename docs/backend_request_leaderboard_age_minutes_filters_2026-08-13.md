# 백엔드 업무 요청서 — 리더보드 Age·Minutes·Position 필터 API

## 목적

M.E.S.S.I. SCOUT INDEX 프런트엔드는 일반 리더보드에서 서버 기반 50명 페이지네이션을 사용합니다. 따라서 Age·Minutes·세부 Position 필터는 현재 페이지의 50명만 브라우저에서 거르는 방식으로 구현할 수 없습니다. 아래 API 확장을 통해 전체 코호트 기준의 정확한 필터·정렬·페이지네이션을 제공해 주세요.

## 대상

- Endpoint: `GET /api/v2/leaderboards`
- 기존 `role`, `position`, `q`, `sort`, `order`, `page`, `pageSize` 계약은 호환성을 유지합니다.

## 요청 Query

| Query | 허용값 | 기본값 |
| --- | --- | --- |
| `ageBand` | `all`, `u23`, `u25`, `26-30`, `31-plus` | `all` |
| `minutesBand` | `all`, `200-499`, `500-999`, `1000-1499`, `1500-1999`, `2000-2999`, `3000-plus` | `all` |

`position`은 이미 predicate가 있는 것으로 확인됐습니다. 응답 메타에도 적용값을 반환하도록 보완해 주세요.

## 필터 기준

### Age

- `all`: 모든 선수 포함. 나이가 없는 값도 포함.
- `u23`: `age <= 22`
- `u25`: `23 <= age <= 25`
- `26-30`: `26 <= age <= 30`
- `31-plus`: `age >= 31`
- 나이가 없으면 `all` 이외의 범위에는 포함하지 않습니다.

### Minutes

- `all`: 모든 선수 포함.
- `200-499`: `200 <= minutes <= 499`
- `500-999`: `500 <= minutes <= 999`
- `1000-1499`: `1000 <= minutes <= 1499`
- `1500-1999`: `1500 <= minutes <= 1999`
- `2000-2999`: `2000 <= minutes <= 2999`
- `3000-plus`: `minutes >= 3000`
- 0–199분은 `all`에서만 포함합니다.

## 처리 순서 및 페이지네이션

다음 순서를 반드시 지켜 주세요.

1. 시즌·mode·scope/competition cohort 선택
2. `role`, `position`, `ageBand`, `minutesBand`, `q` 전체 필터 적용
3. `sort`/`order` 정렬
4. `pageSize=50` 기준 페이지 slice

필터 적용 후의 항목 수로 `totalItems`, `totalPages`, `hasNextPage`를 계산해야 합니다. 프런트엔드는 이 값을 기준으로 `1–50 of N`과 페이지 버튼을 표시합니다.

동점 정렬은 요청 `order`와 관계없이 `rank ASC`, 그 다음 `id ASC`를 tie-breaker로 고정해 주세요. 페이지 경계에서 중복·누락·순서 흔들림이 없어야 합니다.

## Response meta 계약

`meta.applied`에 canonical 적용값을 반드시 echo해 주세요. 프런트엔드는 요청과 echo가 정확히 일치할 때만 해당 서버 필터가 지원된 것으로 간주합니다.

```json
{
  "meta": {
    "applied": {
      "role": "Type A",
      "position": "Striker",
      "q": "son",
      "ageBand": "u25",
      "minutesBand": "1000-1499",
      "sort": "score",
      "order": "desc"
    }
  }
}
```

- 선택하지 않은 `role`, `position`, `q`는 기존 계약에 맞게 `null` 또는 생략 중 하나로 일관되게 처리해 주세요.
- `ageBand`와 `minutesBand`는 항상 canonical value를 반환해 주세요. 기본은 `all`입니다.
- Pydantic response schema와 OpenAPI에도 추가해야 합니다. strict schema 환경에서 service dict만 바꾸면 안 됩니다.

## 오류 처리

- 허용되지 않은 enum 값은 422 validation error로 처리합니다.
- 지원하지 않는 시즌/competition의 기존 404 동작은 유지합니다.
- 응답은 필터를 적용하지 않았는데 적용된 것처럼 표시하면 안 됩니다. 특히 `meta.applied` echo가 실제 실행한 predicate와 항상 같아야 합니다.

## 완료 조건 및 테스트

다음 테스트를 포함해 주세요.

1. Age 경계: 22, 23, 25, 26, 30, 31세.
2. Minutes 경계: 199, 200, 499, 500, 999, 1000, 1499, 1500, 1999, 2000, 2999, 3000분.
3. age null은 `all`에만, 0–199분은 `all`에만 포함.
4. role·position·age·minutes·query 조합 필터.
5. score와 6개 metric 정렬 후에도 pageSize 50, totalItems, totalPages가 필터 결과와 일치.
6. 동일 점수 tie-breaker가 요청 방향과 무관하게 `rank ASC`, `id ASC`인지 검증.
7. `meta.applied.position`, `ageBand`, `minutesBand`의 exact echo 및 OpenAPI schema 검증.

## 프런트엔드 인계 상태

- 프런트엔드는 `ageBand`, `minutesBand` URL/query 상태와 API 파라미터를 준비했습니다.
- 서버가 위 `meta.applied` echo를 제공하기 전까지 일반 리더보드의 Position/Age/Minutes 상세 옵션은 안전하게 비활성화됩니다.
- Watchlist는 서버 leaderboard API와 독립적이며 저장된 전체 컨텍스트에서 동일 필터를 로컬 적용합니다.
