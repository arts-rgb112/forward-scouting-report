# M.E.S.S.I. 2.0 API 연동 및 스테이징 요구사항 명세

작성일: 2026-08-10  
단계: `frontend-analyst`  
범위: 요구사항·현재 상태 분석만 수행. 애플리케이션 코드는 수정하지 않음.

## 1. 결론과 의사결정 게이트

실제 2025/2026 정적 코호트와 6-sector M.E.S.S.I. 계산 로직은 로컬 저장소에 존재하며 API로 노출할 수 있다. 직전 중단된 작업에서 FastAPI 골격도 생성되었지만 아직 추적되지 않은 부분 변경이며, 프론트는 여전히 샘플 데이터를 기본값으로 사용한다.

구현·로컬 통합 QA는 아래 계약을 기준으로 계속할 수 있다. 그러나 실제 스테이징 배포 전에 다음 선택은 사용자 승인이 필요하다.

1. **프론트 배포 사업자**: Vercel, Netlify, AWS S3+CloudFront 중 선택.
2. **API 호스팅 방식**: 별도 상시 FastAPI 호스트, 프론트 사업자의 Python serverless, 또는 정적 JSON snapshot 중 선택. 정적 snapshot은 실시간 API 요구를 충족하지 않으므로 기본 권고안이 아니다.
3. **접근 공개 수준**: 인터넷 공개 staging인지, 인증/접근 제한이 있는 preview인지 결정.
4. **비용·계정·도메인 사용 권한**: 배포 프로젝트/조직, 과금 가능 리소스, staging 도메인과 API 도메인 확정.
5. 확정된 staging origin을 `MESSI_CORS_ORIGINS`에 추가하는 외부 환경 설정.

권고안은 **Vercel 정적 프론트 + 별도 HTTPS FastAPI staging + 공개 읽기 전용 API**이다. QA 접근성이 가장 좋지만, 선수 데이터의 공개 범위와 호스팅 비용을 먼저 승인받아야 한다. 승인이 없으면 외부 배포와 공개 URL 생성에서 멈춘다.

## 2. 조사된 현재 상태

### 2.1 프론트엔드

- 위치: `C:\Users\USER\Downloads\files\messi-2-dashboard`
- React 19.2, TypeScript 7.0, Vite 8.1, Tailwind CSS 4.3, Vitest/jsdom.
- 이 폴더 자체는 Git 저장소가 아니다.
- `src/main.tsx`는 루트 호환 파일을 통해 대시보드를 렌더링한다.
- 실제 화면 구현은 `src/dashboard/MessiScoutingDashboard.tsx`와 하위 컴포넌트에 분리되어 있다.
- `samplePlayers.ts`의 8명 placeholder 데이터가 기본 props로 주입된다.
- 현재 UI 계약은 5개 가상 지표(`boxThreat`, `dangerZone`, `linkPlay`, `pressing`, `progression`)와 3개 티어만 허용한다. 실제 알고리즘의 6개 지표 및 6개 티어와 불일치한다.
- `age`, `face`, 국적/리그/클럽 아이콘은 non-null로 가정한다. 실제 데이터에는 나이·국적·에셋 URL이 없다.
- 검색, 포지션 필터, 정렬, 관심선수 localStorage, 2~4명 비교, 모바일 카드, 이미지 fallback과 접근성 단위 테스트가 구현되어 있다.
- 현재 테스트는 UI 상태·유틸 중심이다. 네트워크 loading/error/schema failure/error boundary 테스트와 브라우저 E2E는 없다.
- `dist`는 기존 샘플 데이터 빌드 결과다. 배포 설정 파일과 배포 CLI는 확인되지 않았다.

### 2.2 실제 데이터와 알고리즘

- 위치: `C:\Users\USER\Downloads\files\forward-scouting-report`
- 현재 브랜치: `agent/fallback-expanded-tournament-ids`.
- 작업 트리는 기존 변경으로 더럽다. `rankings.py` 수정, `api_server/`, `tests/test_api.py`, `requirements-api.txt`, `.env.api.example`, `docs/` 등이 추적되지 않은 상태다. `__pycache__`도 다수 존재한다.
- `data/spear_cohort.csv`는 5,450행이며 시즌은 2021/2022~2025/2026이다.
- 2025/2026 원천은 1,170행, 선수 ID 기준 1,014명이다. 대회별 행 수는 Premier League 155, Ligue 1 108, Bundesliga 141, Serie A 135, Eredivisie 137, Liga Portugal 100, LaLiga 134, Champions League 134, Europa League 126이다.
- 국내 7리그에서 현재 자격 조건(xG >= 2.0, 출전 450분 이상)을 통과하는 원천 선수는 910명이다. 3리그는 424명, 5리그는 673명이다. 전술 공간 데이터와 6개 섹터 계산을 모두 통과한 최종 API 모집단은 이보다 작을 수 있으므로 API의 `meta.population`을 최종 진실 공급원으로 사용한다.
- 국내 비교 scope: 3 = league IDs 47/55/87, 5 = 47/53/54/55/87, 7 = 47/53/54/55/57/61/87. UEFA 컵은 별도 모집군 정책이며 7리그 목록에 섞지 않는다.
- 데이터에 실제로 있는 식별/표시 필드는 `player_id`, `player_name`, `league_id/name`, `team_id/name`, `position`, `position_group`, `minutes_played` 등이다.
- `age`, `nation`, face image, club/league/nation icon URL은 이 코호트에 없다.

### 2.3 직전 중단으로 생긴 partial API

다음 파일이 이미 생성되었으나 아직 완료/커밋 상태가 아니다.

- `api_server/main.py`: `/health`, `/api/v1/players`, `/docs`, `/redoc`, OpenAPI, localhost CORS.
- `api_server/schemas.py`: Pydantic response 모델.
- `api_server/service.py`: leaderboard → response 변환.
- `api_server/export_snapshot.py`: 정적 JSON/OpenAPI export.
- `tests/test_api.py`: health, 6개 sector key, localhost preflight, tier 경계 일부.
- `rankings.py`: `league_id`, `minutes_played`, 6개 numeric sector score를 leaderboard 결과에 추가한 미커밋 변경.

좋은 출발점이지만 다음 문제가 남아 있다.

- 프론트가 이 API를 전혀 호출하지 않는다.
- API의 `role`은 실제 Type A/B 역할이 아니라 `position`을 넣고 있어 의미가 섞인다.
- backend tier는 6개 band code만 내보내며 알고리즘의 1~5 sub-tier를 잃는다.
- age/nation/assets는 `null` 또는 “정보 없음”으로 채우지만 프론트 타입은 이를 허용하지 않는다.
- 요청 가능한 모든 시즌 문자열을 받지만 지원하지 않는 시즌의 의미 있는 오류 계약이 없다.
- limit 기본값 100은 전체 클라이언트 검색·필터를 사용할 때 모집단을 누락한다.
- API 예외 응답, schema version, 데이터 최신성/coverage 메타데이터가 부족하다.
- CORS staging origin은 아직 알 수 없어 localhost만 기본 허용한다.

## 3. 데이터 진실성 정책

1. 데이터에 없는 `age`, `nation`, `face`, club/league/nation icon은 **추정하거나 꾸며내지 않는다**.
2. 불명 값을 실제 사실처럼 보이는 문자열로 변환하지 않는다. API는 nullable로 전달하고 UI는 `—`, 이니셜, 일반 fallback 아이콘으로 표시한다.
3. `team_name`, `league_name`, `position`, `minutes_played`는 코호트의 실제 값을 사용한다.
4. 수집 에셋은 별도 검수된 manifest가 안정적인 `player_id`, `team_id`, `league_id`에 연결된 경우에만 URL을 넣는다. 이름 fuzzy match만으로 자동 결합하지 않는다.
5. 원천에서 누락된 계산 성분은 알고리즘의 기존 보수적 20점 imputation을 유지하되, 향후 API가 coverage/imputation 정보를 제공할 수 있도록 확장 여지를 둔다. 프론트가 자체 보정하거나 재계산하지 않는다.
6. 전체 M.E.S.S.I. 점수와 sector 점수는 백엔드 결과를 그대로 표시한다. 프론트는 반올림 표시 외에 산식을 복제하지 않는다.

## 4. 실제 6-sector 매핑

모든 sector 값은 현재 비교 모집단 내 0~100 백분위 축이다. source 누락 시 계산기 내부의 보수적 component score 20이 사용된다.

| API/UI key | 한국어 표기 | 실제 계산 |
|---|---|---|
| `outsideShot` | 박스 밖 슈팅 | 박스 밖 슈팅 시도 볼륨 백분위 50% + 박스 밖 슈팅 품질 백분위 50% |
| `boxThreat` | 딥 박스 위협 | 박스 안 슈팅 볼륨 50% + 딥 박스 점수 50%. 딥 박스 점수는 박스 안 마무리 70% + micro-zone 30% |
| `dangerZone` | 위험 구역 전진 | 드리블 시도 볼륨 50% + progression 50%. progression은 드리블 마진 70% + danger-zone density 30% |
| `aerial` | 공중 경합 | 공중 경합 시도 볼륨 50% + 공중 경합 마진 50% |
| `groundDuel` | 지상 경합 | 지상 경합 시도 볼륨 50% + 지상 경합 마진 50% |
| `spaceControl` | 공간 지배 | CCA area 비율 50% + danger-zone density 50% |

전체 점수 가중치는 딥 박스 30%, 박스 밖 슈팅 20%, 위험 구역 15%, 공간 지배 15%, 공중 경합 10%, 지상 경합 10%다. 기존 UI의 `linkPlay`, `pressing`, `progression`은 실제 공개 sector가 아니므로 제거하며 임의 변환하지 않는다.

## 5. 목표 API 계약

### 5.1 엔드포인트

- `GET /health`: 프로세스와 기본 데이터셋 가용성 확인.
- `GET /api/v1/players?season=2025/2026&scope=7&limit=1000`: leaderboard 조회.
- `GET /openapi.json`: 기계 판독 OpenAPI.
- `GET /docs`: Swagger UI.
- `GET /redoc`: ReDoc.

초기 릴리스는 읽기 전용이다. 인증·쿠키가 없으므로 `allow_credentials=false`를 유지한다. 프론트 검색/필터/정렬을 전체 모집단에 적용하기 위해 초기 요청은 `limit=1000`으로 하되 `returned < population`이면 UI에 부분 데이터임을 명시한다. 장기적으로는 pagination과 서버 검색 계약을 별도 버전으로 추가한다.

### 5.2 제안 response JSON

```json
{
  "data": [
    {
      "id": 942368,
      "rank": 1,
      "name": "실제 원천 선수명",
      "position": "Left Winger",
      "archetype": "Type A",
      "age": null,
      "minutes": 1784,
      "tier": { "code": "diamond", "level": 1, "label": "다이아몬드 1" },
      "score": 87.25,
      "face": null,
      "nation": null,
      "league": { "id": 47, "name": "Premier League", "icon": null },
      "club": { "id": 8456, "name": "Manchester City", "icon": null },
      "stats": {
        "outsideShot": 0.0,
        "boxThreat": 0.0,
        "dangerZone": 0.0,
        "aerial": 0.0,
        "groundDuel": 0.0,
        "spaceControl": 0.0
      }
    }
  ],
  "meta": {
    "schemaVersion": "1.0.0",
    "season": "2025/2026",
    "scope": 7,
    "population": 0,
    "returned": 0,
    "generatedAt": "2026-08-10T00:00:00Z",
    "source": "messi-static-cohort"
  }
}
```

예시는 구조 설명용이며 예시 점수와 순위를 실제 선수 사실로 사용하지 않는다. 실제 응답은 `rankings.py` 결과만 직렬화한다.

### 5.3 validation 및 오류

- 서버 Pydantic 모델은 `extra=forbid`, score 범위 0..100, rank >= 1, minutes >= 0, tier code/level 범위를 검증한다.
- 클라이언트는 TypeScript 타입 주장만 하지 않고 runtime schema parser를 거친다. Zod 등 라이브러리 선택은 설계 단계에서 확정할 수 있다.
- 400/422: 잘못된 season/scope/limit. 사용자에게 요청 조건 오류로 표시.
- 404 또는 명시적 200-empty: 지원되지만 데이터가 없는 시즌. 두 방식 중 하나를 API 문서에 고정하며, 권고는 `200` + 빈 data + 정상 meta다.
- 500/503: 계산/데이터셋 가용성 실패. 내부 예외/경로/스택은 외부 response에 노출하지 않는다.
- schema parse failure는 일반 network failure와 구분해 로깅하고 사용자에게 “응답 형식을 확인할 수 없음”으로 안내한다.
- 응답은 `Cache-Control: public, max-age=300, stale-while-revalidate=3600`을 사용할 수 있다. `generatedAt`은 요청 시각이 아니라 데이터 snapshot 생성/계산 시각으로 정의해야 한다.

## 6. 프론트 기능 요구사항

1. `samplePlayers` 기본 fallback을 production 경로에서 제거하고 API 성공 데이터만 표시한다. 테스트 fixture는 유지할 수 있다.
2. API base URL은 `VITE_MESSI_API_BASE_URL` 환경변수로 주입한다. 코드에 staging URL을 하드코딩하지 않는다.
3. 첫 로드에는 실제 테이블/카드 구조와 유사한 skeleton을 표시해 layout shift를 줄인다.
4. fetch 실패에는 인라인 오류 상태, 재시도 버튼, 오류 코드가 아닌 사용자가 이해할 수 있는 메시지를 제공한다.
5. React Error Boundary는 렌더링 오류를 포착하고 재시도/새로고침 복구 UI를 제공한다. fetch 오류는 별도 async state로 처리한다.
6. API 응답 runtime validation 실패 시 잘못된 레코드를 조용히 섞지 않고 전체 응답을 fail-closed 한다.
7. 요청 교체/언마운트 시 `AbortController`로 이전 요청을 취소하며 stale response가 최신 상태를 덮지 않게 한다.
8. nullable age/assets/nation을 모든 데스크톱·모바일·비교 컴포넌트가 안전하게 처리한다.
9. UI 지표를 실제 6개로 교체하고 비교표/모바일 확장/툴팁/테이블 열을 동일한 config에서 파생한다.
10. 서버 rank와 모집단/시즌/scope/generatedAt을 헤더 또는 footer에 사실대로 표시한다. 기존 `LIVE`, `min. 900 minutes`, `티어 3` 같은 부정확한 하드코딩은 제거한다.
11. API 데이터 갱신 후 존재하지 않는 ID는 관심선수와 비교 목록에서 정리한다. localStorage 손상은 현재처럼 무시한다.
12. 빈 데이터셋과 검색 결과 0건을 다른 화면으로 구분한다.

## 7. 비동기 상태 머신

```text
idle
  -> loading
      -> success(data)
      -> empty(dataset has zero records)
      -> error.network
      -> error.http
      -> error.schema
      -> error.unknown

success -> refreshing -> success | previous-data-with-warning
error/empty -> retry -> loading
unmount/parameters changed -> aborted (no user-facing error)
```

- 최초 `loading`: 목록 skeleton, 검색/필터는 disabled 또는 `aria-disabled`.
- `success`: 정상 목록과 meta 표시.
- `empty`: “해당 시즌/scope 데이터가 없음”, 재시도와 조건 안내.
- `error`: 대시보드 shell은 유지하고 retry 제공. 화면 전체를 빈 흰 화면으로 만들지 않는다.
- `refreshing`: 기존 데이터가 있다면 유지하며 비차단 갱신 표시를 사용한다.
- 상태 변경은 하나의 `aria-live` 영역에서 중복 없이 알린다.

## 8. CORS 및 보안 요구사항

- 정확한 origin allowlist만 사용한다. `*` 및 임의의 광범위 regex는 사용하지 않는다.
- 로컬 허용: `http://localhost:5173`, `http://127.0.0.1:5173`, preview용 `:4173` 두 origin.
- staging은 최종 HTTPS origin을 환경변수 `MESSI_CORS_ORIGINS`에 추가한다.
- method는 `GET`, `OPTIONS`; headers는 필요한 `Accept`, `Content-Type`만 허용한다.
- 현재 쿠키/인증이 없으므로 credentials를 허용하지 않는다.
- API 키, 데이터 공급자 credential, 내부 파일 경로를 Vite 환경변수나 응답/OpenAPI에 포함하지 않는다. `VITE_` 변수는 공개 값이라는 전제로 API base URL만 둔다.
- rate limit/edge protection과 관측 로그는 공개 staging API 호스트에서 설정한다. 로그에는 사용자 검색어나 credential을 불필요하게 저장하지 않는다.
- 에셋은 검수된 HTTPS URL만 허용하고 CSP/img-src 정책을 배포 설정과 함께 검토한다.

## 9. 배포 전제와 권고 워크플로우

1. 로컬 FastAPI 실행 및 OpenAPI 생성 검증.
2. 프론트 env가 로컬 API를 가리키도록 설정하고 통합 테스트.
3. 단위/컴포넌트 테스트, TypeScript, production build, backend pytest 통과.
4. 실제 2025/2026 응답으로 desktop/mobile 브라우저 QA.
5. 사용자에게 provider/API host/public access 승인을 요청.
6. 승인된 API를 먼저 HTTPS staging에 배포하고 `/health`, `/docs`, `/redoc`, CORS preflight 검증.
7. 확정 API URL로 프론트를 배포하고 실제 staging origin을 backend allowlist에 추가.
8. PC/mobile smoke test, schema/meta/asset 육안 검수 후 URL 전달.

정적 JSON export는 backend host가 없는 preview 또는 장애 시 fallback artifact로는 유용하지만 “API 실시간 응답으로 전면 교체”의 완료 증거로 사용하지 않는다.

## 10. 테스트와 통합 QA

### Backend

- 2025/2026, scope 3/5/7의 실제 population과 6-sector 범위 검증.
- 전체 점수 재계산 결과와 직렬화 값의 일치 검증.
- tier band 및 sub-tier 경계 검증.
- nullable 필드, unsupported season, invalid query, 빈 데이터셋, 내부 오류 계약.
- localhost와 staging allowed preflight 성공, 미허용 origin 실패.
- OpenAPI schema와 실제 response 일치.

### Frontend

- loading skeleton, success, dataset empty, HTTP error, malformed JSON, runtime schema mismatch, retry, abort.
- nullable age/nation/assets fallback.
- 6개 지표가 desktop/mobile/tooltip/compare에 동일하게 표시됨.
- 전체 모집단 기반 검색·필터와 server rank 보존.
- Error Boundary fallback과 복구.
- watchlist/comparison reconcile.

### Staging smoke test

- 실제 HTTPS에서 `/health`, `/api/v1/players`, `/openapi.json`, `/docs`, `/redoc` 접근.
- 프론트 origin의 preflight 및 GET 성공, 브라우저 콘솔 CORS/mixed-content 오류 없음.
- 모바일/PC에서 skeleton → 실제 목록 → 검색 → 비교 → 저장 → 새로고침 플로우.
- 선수 이름, club/league, rank, score, 6-sector가 API와 동일함.
- 에셋이 없을 때 placeholder가 사실을 꾸미지 않고 안정적으로 표시됨.

## 11. 수용 기준

- production 앱 번들에서 `samplePlayers`를 가져오거나 placeholder URL을 요청하지 않는다.
- 실제 API 응답이 runtime schema를 통과해야만 목록으로 렌더링된다.
- 실제 6-sector와 전체 점수의 key/라벨/값이 backend 알고리즘과 1:1 대응한다.
- 데이터에 없는 age/nation/assets는 null-safe fallback이며 추정값이 없다.
- 초기 loading, empty dataset, fetch failure, schema failure, render failure에 각각 복구 가능한 UI가 있다.
- Swagger, ReDoc, OpenAPI JSON과 CORS local preflight가 자동 테스트로 검증된다.
- frontend/backend 테스트, 타입 검사, production build가 모두 통과한다.
- 승인된 staging origin에서 실제 API 호출이 성공하고 미허용 origin은 허용되지 않는다.
- QA에 프론트 URL, API base URL, Swagger/ReDoc URL, 테스트 결과, 알려진 데이터 coverage를 함께 전달한다.
- 외부 배포는 provider/API host/public access 승인을 받은 뒤에만 수행한다.

## 12. 다음 단계 입력

`frontend-designer`는 이 문서를 기준으로 API client/runtime schema, data adapter, async state, skeleton/error boundary, nullable UI, 6-sector config의 컴포넌트 경계를 설계한다. 구현 전에 외부 배포 선택은 필요하지 않지만, 실제 배포 단계 진입 전에는 1절의 승인 항목이 반드시 확정되어야 한다.
