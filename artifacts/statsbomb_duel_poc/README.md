# StatsBomb Open Data 공간 가치 경합 PoC

## 결론

PR #173의 6-depth × 5-lane 가중치 엔진은 실제 이벤트 좌표에서도 의도대로 작동했다. 단순 승리 횟수가 같은 경합도 발생 구역에 따라 다른 값을 만들며, 30분 이상 출전 코호트에서 Rodrigo De Paul은 공중 경합 순위가 14위에서 7위, 종합 경합 순위가 20위에서 14위로 상승했다.

다만 한 경기만으로 시즌 M.E.S.S.I. 기준선을 교체할 수는 없다. 이번 결과는 **로직과 어댑터의 타당성 검증**이며, 프로덕션 반영 전에는 여러 대회·시즌 표본과 공급사 시즌 합계 대조가 필요하다.

## 검증 표본

- 데이터 제공: StatsBomb Open Data
- 대회: 2022 FIFA World Cup
- 경기: Argentina vs France, 2022-12-18
- StatsBomb match ID: `3869685`
- 원본 이벤트: 4,407개
- 원본 `Duel` 이벤트: 98개
- 경기 중 분석 대상: period 1–4; 승부차기 period 5의 21개 이벤트 제외
- 출전 선수: 33명; 순위 비교용 30분 이상 코호트: 28명

StatsBomb 공개 데이터의 연구·분석 결과를 외부에 게시할 때는 StatsBomb을 데이터 출처로 명시하고 공식 로고 사용 조건을 따라야 한다.

## 이벤트 해석

StatsBomb에서는 공중 경합 승자가 일반 `Duel` 승리 이벤트로만 기록되지 않는다. 이 어댑터는 다음 원본 필드를 함께 처리한다.

- 지상 승리: `type=Duel`, `duel.type=Tackle`, outcome이 `Won`, `Success`, `Success In Play`, `Success Out`
- 지상 패배: `Lost In Play`, `Lost Out`
- 공중 패배: `type=Duel`, `duel.type=Aerial Lost`
- 공중 승리: `Pass`, `Shot`, `Clearance`, `Miscontrol`의 타입별 payload에 `aerial_won=true`
- 좌표·선수·outcome이 없거나 모호한 이벤트는 추정하지 않고 audit 사유로 제외

원본 120×80 좌표는 `x / 120 × 100`, `100 - (y / 80 × 100)`으로 변환한다. 양 팀과 모든 경기 period의 슈팅 방향을 교차 확인했으며, StatsBomb 이벤트 좌표는 행위 선수의 공격 방향이 왼쪽에서 오른쪽이므로 전·후반/홈·원정 기준 x 반전은 하지 않는다. 다만 StatsBomb과 M.E.S.S.I.의 좌·우 Lane 번호 정의가 반대이므로 y축만 반전한다.

또한 이 PoC의 `ground`는 StatsBomb `Duel/Tackle`이다. 다른 공급사의 포괄적인 `ground duel`과 모집단이 같다고 간주해서는 안 되며, 프리미엄 어댑터 검증 시 공급사 정의와 공식 합계를 별도로 대조해야 한다.

## 결과 요약

전체 출전 선수 기준 분류 결과:

| 항목 | 단순 승리 합계 | 가중 승리 합계 | Tier 1 승리 | Tier 2 승리 |
|---|---:|---:|---:|---:|
| 지상 경합 | 31 | 31.5 | 0 | 1 |
| 공중 경합 | 41 | 47.0 | 2 | 4 |

30분 이상 출전 코호트의 주요 순위 변화:

| 선수 | 단순 종합 순위 | 가중 종합 순위 | 변화 | 해석 |
|---|---:|---:|---:|---|
| Randal Kolo Muani | 2 | 1 | +1 | Tier 1 공중 승리 1회로 공중 가중 승리가 5.0에서 8.0으로 상승 |
| Rodrigo Javier De Paul | 20 | 14 | +6 | 공중 승리 1회가 Tier 1에서 발생해 1.0이 아닌 3.0으로 평가; 공중 순위 14→7 |
| Kylian Mbappé Lottin | 22 | 20 | +2 | Tier 2 공중 승리로 1.0이 1.5로 평가 |
| Enzo Fernandez | 9 | 8 | +1 | 지상 Tier 2 승리로 지상 가중 합계가 5.0에서 5.5로 상승 |

이 경기에서는 위험 구역 지상 경합 승리가 한 번뿐이어서 지상 순위 변화가 작았다. 반면 박스 안 공중 경합 승리는 희소하지만 순위를 실질적으로 바꿨다. 이는 단순 빈도에 묻히던 **득점과 가까운 공간의 승리**를 구분하려는 지표 목적과 일치한다.

## 산출물

- `world_cup_2022_final.json`, `.csv`: 출전 선수 33명 전체, 최소 1분
- `world_cup_2022_final_min30.json`, `.csv`: 순위 비교용 30분 이상 28명
- 각 행: raw/weighted wins, raw/weighted wins per 90, `boxDuelsWon`, ground/aerial 30-cell 분포, 기존/신규 순위와 변화량
- 파이프라인: `scripts/statsbomb_duel_poc.py`
- 테스트: `tests/test_statsbomb_duel_poc.py`

## 재현 방법

공식 이벤트 JSON을 `3869685.json`으로 받은 뒤 다음을 실행한다.

```powershell
python scripts/statsbomb_duel_poc.py 3869685.json `
  --output-prefix artifacts/statsbomb_duel_poc/world_cup_2022_final_min30 `
  --minimum-minutes 30
```

프리미엄 공급사 도입 시에는 공급사별 분류 함수만 `ClassifiedDuel` 계약으로 교체하고, 0..100 공격방향 정규화 이후 기존 `calculate_spatial_duels` 엔진을 그대로 사용한다. 프로덕션 게이트는 시즌 전체 선수의 좌표 완전성과 공급사 공식 경합 합계 대조가 모두 통과된 경우에만 연다.
