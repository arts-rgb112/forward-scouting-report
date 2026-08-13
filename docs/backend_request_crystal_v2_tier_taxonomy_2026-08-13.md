# 백엔드 업무 요청서 — M.E.S.S.I. Crystal v2 티어 taxonomy 전환

## 목적

대시보드의 새 M.E.S.S.I. 티어 순서는 다음과 같습니다.

```text
Diamond → Emerald → Platinum → Gold → Silver → Bronze
```

프론트엔드는 구형 응답과 Watchlist 저장본을 안전하게 표시하는 호환 처리를 완료했습니다. 이제 API가 구 taxonomy와 새 taxonomy를 명시적으로 구분해 전달하도록 변경해 주세요.

## 변경하지 않는 항목

다음은 이번 요청에서 변경하지 않습니다.

- M.E.S.S.I. 점수 계산식
- 선수 순위 계산식
- 기존 백분위 컷오프: `0–4 / 4–11 / 11–40 / 40–77 / 77–96 / 96–100`
- 각 티어의 Lv.1–Lv.5 레벨 산식
- 리더보드 정렬 및 50명 단위 페이지네이션
- 능력치 색상 구간(프론트엔드 전용): `90–100 / 80–89 / 70–79 / 60–69 / 50–59 / 0–49`

## 새 taxonomy

새 API taxonomy version은 `crystal-v2`입니다.

| 순위 백분위 위치 | 기존 legacy-v1 코드 | crystal-v2 코드 | 표시명 |
| --- | --- | --- | --- |
| 0–4% | `diamond` | `diamond` | Diamond |
| 4–11% | `platinum` | `emerald` | Emerald |
| 11–40% | `gold` | `platinum` | Platinum |
| 40–77% | `silver` | `gold` | Gold |
| 77–96% | `bronze` | `silver` | Silver |
| 96–100% | `iron` | `bronze` | Bronze |

이 변경은 단순히 `iron`을 `emerald`로 이름만 바꾸는 작업이 아닙니다. 기존 백분위 **서수 위치**를 유지하면서 새 명칭·코드 체계로 재배치하는 작업입니다.

## API 계약 요청

### 1. Tier enum 변경

기존 enum:

```text
diamond | platinum | gold | silver | bronze | iron
```

신규 `crystal-v2` enum:

```text
diamond | emerald | platinum | gold | silver | bronze
```

`TierCode`, Player tier response schema, OpenAPI enum 및 모든 serializer를 함께 갱신해 주세요.

### 2. taxonomy version 명시

프론트엔드가 기존 `platinum`과 새 `platinum`의 의미를 혼동하지 않도록, API 응답에 명시적인 version을 포함해 주세요.

권장: 각 player tier에 version을 둡니다.

```json
{
  "tier": {
    "code": "emerald",
    "label": "Emerald",
    "level": 2,
    "taxonomyVersion": "crystal-v2"
  }
}
```

리더보드 meta에 다음 값을 함께 추가하는 것도 권장합니다.

```json
{
  "meta": {
    "tierTaxonomyVersion": "crystal-v2"
  }
}
```

개별 tier version이 있으면 이를 우선하고, 없으면 meta version을 사용하며, 둘 다 없으면 프론트는 기존 응답을 `legacy-v1`으로 처리합니다.

### 3. 적용 endpoint

동일 taxonomy를 제공하는 모든 응답에 일관되게 적용해야 합니다.

- `GET /api/v2/leaderboards`
- 선수 상세 endpoint
- 비교 endpoint
- `POST /api/v2/watchlist/resolve`
- OpenAPI schema 및 예제 response

## 배포 순서

1. 백엔드가 `taxonomyVersion`을 포함한 `crystal-v2` 응답을 배포합니다.
2. 프론트엔드는 version이 명시된 응답만 새 Diamond/Emerald/Platinum/Gold/Silver/Bronze로 표시합니다.
3. version 없는 과거 API 응답과 기존 Watchlist snapshot은 `legacy-v1`으로 보존됩니다.
4. 기존 localStorage Watchlist의 `tier.code`, `tier.label`, `tier.level`은 서버나 프론트에서 자동 변환·덮어쓰기 하지 않습니다.

이 순서를 지키면 mixed deployment 중에도 legacy `platinum`이 새 Platinum으로 잘못 표시되지 않습니다.

## 수용 기준 및 테스트

1. 기존 컷오프와 레벨 산식이 변하지 않음.
2. rank 1은 `diamond` / `Diamond` / `crystal-v2`.
3. 기존 4–11% 위치는 `emerald` / `Emerald` / `crystal-v2`.
4. 기존 11–40% 위치는 `platinum` / `Platinum` / `crystal-v2`.
5. 최하위 96–100% 위치는 `bronze` / `Bronze` / `crystal-v2`.
6. 모든 적용 endpoint에서 tier code, label, level, taxonomyVersion이 일치.
7. Pydantic schema, OpenAPI enum, endpoint contract/unit test를 함께 갱신.
8. `watchlist/resolve`의 resolved player도 같은 version을 반환.
9. version 없는 구형 fixture는 `legacy-v1` 호환 fixture로 별도 유지해 전환 회귀를 검증.

## 프론트엔드 인계 상태

- 프론트엔드는 `legacy-v1`과 `crystal-v2`를 모두 안전하게 렌더링합니다.
- version 없는 기존 응답·Watchlist 저장본은 legacy로 처리됩니다.
- 전체 리더보드가 legacy 데이터일 경우 작은 `Legacy tier taxonomy` 상태를 표시합니다.
- `crystal-v2` 응답이 배포되면 새 시각 체계가 자동으로 활성화됩니다.
