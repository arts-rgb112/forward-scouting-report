# 프론트엔드 업무 요청서 — M.E.S.S.I. 데이터 품질·대체값 표시

## 목적

공간 히트맵 세션이 없는 선수는 M.E.S.S.I. 산식에서 누락 구성요소에
보수적 20점 floor가 적용됩니다. 이 값을 실제 측정 점수처럼 표시하지 않고
`데이터 부족/대체값`으로 구분합니다.

백엔드는 기존 strict 리더보드·상세·Watchlist DTO를 변경하지 않고 아래
companion API를 제공합니다. 따라서 기존 화면은 그대로 동작하며 새 표시를
점진적으로 추가할 수 있습니다.

## 신규 API

### 선수 단건

`GET /api/v2/players/{playerId}/data-quality`

기존 상세 조회와 동일한 `season`, `mode`, `scope`, `competition` query를
전달합니다.

```json
{
  "data": {
    "playerId": 212867,
    "season": "2023/2024",
    "mode": "league",
    "scope": 7,
    "competition": null,
    "dataQuality": {
      "qualityVersion": "messi-quality-v1",
      "spatialAvailable": false,
      "messiScoreComplete": false,
      "reason": "spatial_session_missing",
      "imputedMetrics": ["boxThreat", "dangerZone", "spaceControl"],
      "imputedComponents": [
        "boxThreat.ratio",
        "dangerZone.ratio",
        "spaceControl.volume",
        "spaceControl.ratio"
      ],
      "observedWeightPct": 62.5,
      "fallbackComponentScore": 20
    }
  }
}
```

### Watchlist 일괄 조회

`POST /api/v2/watchlist/data-quality`

- request body는 기존 `/api/v2/watchlist/resolve`와 동일합니다.
- 최대 100개, 입력 순서 유지, 항목별 부분 실패 계약도 동일합니다.
- 허용 Origin과 body 제한도 기존 Watchlist POST와 동일합니다.
- Watchlist 자체를 서버에 저장하지 않습니다.

## 표시 요구사항

1. `messiScoreComplete=false`이면 M.E.S.S.I. 총점 옆에 작은
   `데이터 일부 대체` 상태를 표시합니다.
2. `imputedMetrics`에 포함된 6개 능력치 셀은 숫자를 숨기지 않되 `추정치`
   또는 `데이터 부족` 배지를 함께 표시합니다.
3. 특히 `spaceControl=20`을 실제 측정된 20점으로 표현하지 않습니다.
4. tooltip/popover에는 `관측 반영률 {observedWeightPct}%`와
   `누락 구성요소는 {fallbackComponentScore}점 floor 적용`을 설명합니다.
5. `reason` 문구 권장:
   - `spatial_session_missing`: 공간·히트맵 세션 없음
   - `source_metric_missing`: 원천 지표 일부 없음
   - `mixed_source_missing`: 공간 및 원천 지표 모두 일부 없음
6. companion API 오류 시 기존 화면을 유지하되 품질이 완전하다고 추정하지
   않습니다. 상태를 숨기거나 `품질 정보 확인 불가`로 표시합니다.
7. Watchlist는 저장된 snapshot의 숫자를 자동 덮어쓰지 않습니다. resolve
   결과와 품질 결과를 현재 서버 상태 배지에만 사용합니다.

## 호출 전략

- 상세 화면: 기존 상세 API와 data-quality API를 병렬 호출합니다.
- Watchlist: 현재 표시 중인 최대 100개 context를 한 번의 batch POST로
  조회합니다.
- 일반 리더보드 50행 전체에 단건 API 50회를 호출하지 않습니다. 리더보드
  품질 표시는 후속 batch 계약이 필요할 때 별도 협의합니다.

## 수용 기준

1. 손흥민 21/22~24/25의 복구 전 상태에서 오프더볼 20이 `대체값`으로 표시.
2. 복구 후 해당 세션은 `messiScoreComplete=true`, 품질 배지 자동 해제.
3. 완전 데이터 선수는 기존 디자인과 숫자가 변하지 않음.
4. 상세·비교·Watchlist 저장본 및 legacy taxonomy 회귀 없음.
5. hostile origin에서 Watchlist data-quality POST가 차단됨.
6. strict Zod schema에 신규 companion 응답 schema와 contract test 추가.
