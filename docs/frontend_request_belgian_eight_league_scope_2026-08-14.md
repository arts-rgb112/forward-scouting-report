# 프론트엔드 업무 요청서 — Belgian Pro League 추가 및 8리그 전환

## 목적

M.E.S.S.I. 국내 리그 데이터 범위를 기존 7개 리그에서 8개 리그로 확장합니다. 신규 리그는 Belgian Pro League이며 FotMob league ID는 `40`입니다.

백엔드는 `scope=8` 계약, 벨기에 5개 시즌 코호트 및 트래킹·히트맵 데이터를 반영했습니다. 프론트엔드는 아래 계약에 맞춰 선택 UI, URL 상태, Watchlist 및 상세·비교 이동을 확장해 주세요.

## 1. 리그 범위 선택 및 기본값

- 리그 범위 enum에 `8`을 추가합니다: `3 | 5 | 7 | 8`.
- 선택 라벨은 `8 Leagues` 또는 제품 한국어 표기에 맞춘 `8대 리그`를 사용합니다.
- 신규 사용자와 명시적 설정이 없는 URL의 기본 scope를 `8`로 전환합니다.
- 기존 URL 또는 localStorage에 저장된 `scope=3`, `5`, `7`은 자동으로 덮어쓰지 않고 그대로 복원합니다.
- 서버의 `GET /api/v2/leaderboard-options` 응답을 우선 사용하고, 프론트엔드 하드코딩 값은 fallback으로만 유지합니다.

## 2. Belgian Pro League 표시 계약

- canonical 표시명: `Belgian Pro League`
- provider alias로 다음 이름이 들어와도 하나의 리그로 표시합니다.
  - `First Division A`
  - `Jupiler Pro League`
  - `Jupiler League`
  - `Pro League`
- 리그 ID `40`에 해당하는 벨기에 리그 로고·국기·색상 fallback을 추가합니다.
- 이미지 URL이 없거나 실패하면 기존 공통 fallback 에셋을 사용하며 깨진 이미지 아이콘을 노출하지 않습니다.

## 3. API 요청 및 상태 동기화

- 일반 리더보드 요청에 선택된 `scope=8`을 그대로 전달합니다.
- 대상 예시:
  - `GET /api/v2/leaderboards?season=2024%2F2025&mode=league&scope=8&page=1&pageSize=50`
  - `GET /api/v2/leaderboard-options`
- URL query, 앱 상태, API query, Watchlist context의 scope가 항상 동일해야 합니다.
- `scope=8` 응답이 배포되기 전의 구형 API를 만날 경우 조용히 `7`로 변환하지 말고, 지원하지 않는 범위라는 명시적 상태를 표시합니다.

## 4. Watchlist·상세·비교 이동

- Watchlist key/context schema가 `scope=8`을 보존하도록 타입과 validation을 확장합니다.
- 기존 `scope=7` Watchlist snapshot은 마이그레이션하거나 덮어쓰지 않습니다.
- 벨기에 선수 이름 클릭, 상세 버튼, 비교 버튼에서 다음 컨텍스트가 유실되지 않아야 합니다.
  - `playerId`
  - `season`
  - `mode=league`
  - `scope=8`
  - `leagueId=40` 또는 API가 제공하는 canonical competition context
- Legacy Streamlit 상세·비교 링크를 생성할 때도 `scope=8`을 허용하고 기존 `page`, `player`, `season`, `mode` 계약을 유지합니다.
- 리디렉션을 위해 `share.streamlit.io`를 사용하지 말고 운영 Streamlit URL을 직접 사용합니다.

## 5. 히트맵·슈팅맵 표시

- 상세 응답에 히트맵이 있고 슈팅맵이 있으면 기존 방식대로 중첩 표시합니다.
- 슈팅맵 배열이 빈 배열인 경우 `슈팅 0회`로 표시할 수 있습니다.
- 슈팅맵 필드 자체가 없거나 데이터 품질 상태가 unavailable이면 0회로 오인하지 말고 `원천 슈팅 이력 없음` 상태를 표시합니다.
- 히트맵이 존재하면 슈팅맵 누락 때문에 히트맵 전체를 숨기지 않습니다.
- Belgian Pro League playoff group 명칭은 별도 대회 탭으로 분리하지 않고 같은 시즌의 Belgian Pro League로 표시합니다.

## 6. 필터·페이지네이션 회귀 방지

- `role`, `position`, `ageBand`, `minutesBand`, `q`, `sort`, `order`, `page`, `pageSize=50` 계약은 변경하지 않습니다.
- `scope=8`에서도 서버가 반환한 `totalItems`, `totalPages`, `hasNextPage`, `meta.applied`를 사용합니다.
- 클라이언트가 현재 50명만 다시 필터링하여 전체 population 수를 왜곡하지 않도록 합니다.

## 7. 완료 기준

1. 리그 범위 선택기에 `8 Leagues`가 표시되고 새 사용자의 기본값이 8입니다.
2. 2021/22~2025/26 각 시즌에서 `scope=8` 리더보드 요청이 정상 동작합니다.
3. Belgian Pro League 선수가 리더보드·검색·Watchlist에 나타납니다.
4. 벨기에 선수의 상세·비교 이동에서 시즌과 scope가 유지됩니다.
5. `First Division A`, `Jupiler Pro League`, playoff group 응답이 모두 `Belgian Pro League`로 표시됩니다.
6. 히트맵만 있음, 슈팅 0회, 슈팅 원천 이력 없음의 세 상태가 구분됩니다.
7. 기존 scope 3/5/7 URL과 Watchlist 저장본이 회귀하지 않습니다.
8. Production 및 Preview Vercel 환경에서 리더보드·상세·비교 브라우저 QA를 완료합니다.

## 백엔드 인계 상태

- `scope=8` 및 league ID `40` 지원 완료
- Belgian Pro League 2021/22~2025/26 S.P.E.A.R. 코호트 적재 완료
- 같은 5개 시즌의 트래킹·히트맵 적재 완료
- 슈팅맵 증분 적재 완료 후 잔여 예외를 원천 시즌 이력 부재 또는 선수 ID 매핑 오류로 분류 중
- 프론트엔드는 누락 데이터를 임의 계산하거나 `0`으로 대체하지 않습니다.
