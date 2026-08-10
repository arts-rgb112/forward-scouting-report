# M.E.S.S.I. 2.0 API 바인딩 명세

작성일: 2026-08-10  
대상 시즌: `2025/2026`  
프론트: `C:\Users\USER\Downloads\files\messi-2-dashboard`  
백엔드: `C:\Users\USER\Downloads\files\forward-scouting-report`

## 1. 결론

프론트의 현재 `Player`/`samplePlayers` 계약을 그대로 두고 API만 호출하면 안 된다. 실제 API는 6개 M.E.S.S.I. sector와 6개 tier를 반환하지만, 프론트는 가공된 5개 지표와 3개 tier만 허용한다. 또한 실제 원천에는 나이·국가·이미지 URL이 없으므로 해당 필드는 nullable이어야 한다.

구현의 단일 경계는 다음과 같다.

1. `GET {VITE_MESSI_API_BASE_URL}/api/v1/players?season=2025%2F2026&scope=7&limit=1000`
2. JSON을 런타임에서 envelope 전체 단위로 검증한다.
3. 검증된 wire DTO만 `Player` view model로 변환한다. 추정값이나 샘플값을 채우지 않는다.
4. 초기 지연에는 실제 행/카드와 같은 골격의 row 단위 skeleton을 보인다.
5. fetch 오류는 비동기 오류 상태로, render 오류는 React Error Boundary로 각각 처리한다.
6. production 경로에서 `samplePlayers`와 `placehold.co`를 완전히 제거한다.

## 2. 조사 결과와 중단 작업 감사

### 프론트 현행

- `src/dashboard/MessiScoutingDashboard.tsx`가 `players = samplePlayers`를 기본값으로 사용한다. 즉 현재 production 화면은 8명 더미 데이터다.
- `MetricKey`는 `boxThreat`, `dangerZone`, `linkPlay`, `pressing`, `progression` 5개다. 뒤의 3개는 현재 M.E.S.S.I. 산식 sector가 아니다.
- `Tier`는 `diamond | gold | silver`뿐이다.
- `age`, `face`, `nation`, `league`, `club` 및 모든 icon이 non-null이다.
- `AssetImage`의 `src`가 `string`이므로 nullable URL을 직접 받을 수 없다.
- 테이블 순위는 API `rank`가 아니라 필터된 배열의 `index + 1`을 보여 준다.
- 헤더의 tier `3`, 업데이트 `LIVE`, footer의 `min. 900 minutes`는 하드코딩이다.
- API client, runtime validator, async state, row skeleton, fetch fallback, Error Boundary, 관련 테스트와 `.env*` 파일은 없다.
- `dist`도 더미가 포함된 기존 빌드다.

### 백엔드 partial 현행

다음은 아직 Git에서 untracked인 `api_server/`, `tests/test_api.py`, `.env.api.example`, `requirements-api.txt`와 수정 중인 `rankings.py`를 직접 읽은 결과다.

- `/health`, `/api/v1/players`, OpenAPI, Swagger, ReDoc가 부분 구현됐다.
- `rankings.py`는 실제 6-sector 숫자를 leaderboard row에 추가했다.
- `service.py`는 `get_spear_leaderboard(47, season, scope)`를 호출한다. league `47`은 scope 선택의 진입점이며 scope 3/5/7이 실제 비교 리그 집합을 결정한다.
- 현재 wire tier는 `tier: string`과 `tierLabel: string`이다. 6개 band는 유지하지만 `rankings.py`가 계산한 1~5 sub-tier를 버린다.
- 현재 `role`에는 산출 row의 `position`이 들어간다. 별도 Type A/B archetype은 응답에서 사라진다.
- `age`와 `face`는 `null`이지만, `nation`은 `null` 대신 `{"name":"국가 정보 없음","icon":null}`이라는 합성 객체다.
- league/club 응답에는 원천에 있는 `league_id`/`team_id`가 포함되지 않으며 icon은 `null`이다.
- meta에는 `season`, `scope`, `population`, `returned`, `generatedAt`, `source`가 있으나 `schemaVersion`은 없다. `generatedAt`은 snapshot 생성시각이 아니라 매 요청 시각이다.
- 지원하지 않는 올바른 형식의 시즌은 현재 명시적인 4xx가 아니라 빈 `200`이 될 수 있다.
- 로컬 CORS 및 환경변수 기반 regex가 부분 구현됐지만 staging exact origin은 아직 없다.
- 이 환경에서는 Python 실행 파일이 PATH에 없어 실제 endpoint 실행/pytest는 수행하지 못했다. 아래 “관측 응답”은 Pydantic schema와 service 직렬화 경로를 기준으로 한 정확한 정적 감사 결과다.

따라서 partial API를 완료본으로 간주하면 안 된다. 아래 확정 계약의 차이를 먼저 해소해야 한다.

## 3. 실제 M.E.S.S.I. 계산과 6-sector

각 sector는 비교 cohort 내 0~100 점수이며 전체 M.E.S.S.I. 점수는 이 sector들의 가중합이다.

| wire/UI key | UI 표기 | 실제 계산 | 전체 점수 가중치 |
|---|---|---|---:|
| `outsideShot` | 박스 밖 슈팅 | 박스 밖 슈팅 시도량 점수 50% + 박스 밖 슈팅 품질 점수 50% | 20% |
| `boxThreat` | 박스 위협 | 박스 안 슈팅 시도량 50% + deep-box 점수 50%; deep-box는 박스 마무리 70% + micro-zone 30% | 30% |
| `dangerZone` | 위험 구역 전진 | 드리블 시도량 50% + progression 50%; progression은 드리블 마진 70% + danger-zone density 30% | 15% |
| `aerial` | 공중 경합 | 공중 경합 시도량 50% + 공중 경합 마진 50% | 10% |
| `groundDuel` | 지상 경합 | 지상 경합 시도량 50% + 지상 경합 마진 50% | 10% |
| `spaceControl` | 공간 지배 | CCA area 점수 50% + danger-zone density 점수 50% | 15% |

프론트의 `linkPlay`, `pressing`, `progression`은 삭제한다. `MetricKey`와 모든 테이블/모바일/tooltip/비교 렌더링은 위 6개 key를 같은 config에서 순회해야 한다. 프론트에서 sector나 전체 점수를 재계산하지 않는다.

## 4. Wire 계약

### 4.1 확정 응답 형태

아래가 프론트와 백엔드가 함께 맞춰야 할 v1 계약이다. 현재 partial API와 다른 필드는 주석 아래에서 별도로 표시했다.

```json
{
  "data": [
    {
      "id": 942368,
      "rank": 1,
      "name": "Jérémy Doku",
      "position": "Left Winger",
      "archetype": "Type A",
      "age": null,
      "minutes": 1784,
      "tier": {
        "code": "diamond",
        "level": 1,
        "label": "다이아몬드 1"
      },
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
    "population": 910,
    "returned": 910,
    "generatedAt": "2026-08-10T00:00:00Z",
    "source": "messi-static-cohort"
  }
}
```

예시 sector/score/population은 형태 설명용이며 실제 선수값으로 사용하면 안 된다.

### 4.2 현행 partial과 확정 계약의 차이

| 항목 | 현행 partial | 확정 계약 |
|---|---|---|
| 포지션/유형 | `role`에 position 저장, archetype 유실 | `position`과 `archetype` 분리 |
| tier | `tier: TierCode`, `tierLabel`, level 유실 | `{code, level, label}` 객체 |
| nation | 합성 “국가 정보 없음” 객체 | 원천에 없으면 `null` |
| league/club | `{name, icon}` | `{id, name, icon}`; 원천 ID 사용 |
| meta version | 없음 | `schemaVersion: "1.0.0"` 필수 |
| generatedAt | 요청 시각 | cohort/snapshot이 생성된 시각 |

백엔드 변경이 병합되기 전까지 프론트가 partial 형태와 확정 형태를 동시에 허용하는 호환 parser를 만들지 않는다. 그런 parser는 계약 오류를 숨긴다. 양쪽을 확정 계약에 맞춘 뒤 하나의 validator만 유지한다.

### 4.3 타입 제약

- envelope 및 모든 객체는 unknown key를 거부한다(`strict`/`extra=forbid`).
- `id`, asset `id`: 안전한 정수. 선수 `id > 0`; asset id는 원천이 없을 때만 `null` 허용 여부를 backend schema에서 명시한다.
- `rank`: 정수 `>= 1`; data는 rank 오름차순이고 중복 rank가 없어야 한다.
- `name`, `position`, asset `name`: trim 후 빈 문자열 금지. 알 수 없음은 합성 문자열 대신 해당 nullable 객체를 `null`로 보낸다.
- `archetype`: `"Type A" | "Type B"`.
- `age`: `null` 또는 정수 15~60.
- `minutes`: 0 이상의 정수.
- `tier.code`: `diamond | platinum | gold | silver | bronze | iron`.
- `tier.level`: 정수 1~5. 각 band에서 1이 상위다.
- `score`와 6 sector: 유한한 숫자 0~100.
- URL: `null` 또는 절대 `https:` URL. 로컬 fixture 외 `http:` 및 `javascript:`/`data:`는 거부한다.
- `meta.scope`: `3 | 5 | 7`; `population >= returned === data.length`.
- `meta.generatedAt`: timezone이 포함된 ISO-8601 문자열.
- 요청값과 응답 meta의 `season`, `scope`가 다르면 schema/contract 오류다.

## 5. 정확한 필드 바인딩

wire DTO와 화면 `Player`는 분리한다. adapter는 아래 1:1 변환만 하며 fallback 문자열, 점수 재계산, tier 추론을 하지 않는다.

| API 경로 | 프론트 view model | 현재 UI 소비처 | 처리 규칙 |
|---|---|---|---|
| `data[].id` | `id` | key, watchlist, compare | 그대로 사용 |
| `data[].rank` | `rank` | desktop/mobile 순위 | 배열 index가 아니라 서버 rank 표시 |
| `data[].name` | `name` | 정체성, 검색 | 그대로 사용 |
| `data[].position` | `position` | 포지션 badge/filter | `/` 분해 규칙에 의존하지 말고 정확한 한 포지션 값으로 필터 옵션 생성 |
| `data[].archetype` | `archetype` | Type A/B badge/필터(표시 시) | position과 혼합 금지 |
| `data[].age` | `age: number | null` | 테이블/나이 정렬 | null 표시는 `—`; 정렬 시 null은 항상 마지막 |
| `data[].minutes` | `minutes` | 출전시간 | 정수 그대로, locale 포맷만 허용 |
| `data[].tier` | `tier` | tier badge | code로 스타일, `label`을 접근성/텍스트에 사용, level 표시 |
| `data[].score` | `score` | 총점/정렬 | 화면 반올림만 허용; 정렬은 원본 숫자 |
| `data[].face` | `faceUrl: string | null` | 얼굴 | null/로드 실패 시 선수 이니셜 fallback |
| `data[].nation` | `nation: AssetRef | null` | 검색/아이콘 | null이면 아이콘과 검색 token 없음; 화면에는 `국가 정보 없음` 또는 `—` |
| `data[].league` | `league` | 검색/아이콘 | 이름은 실제 원천값; icon null이면 텍스트/일반 fallback |
| `data[].club` | `club` | 검색/아이콘 | 이름은 실제 원천값; icon null이면 텍스트/일반 fallback |
| `stats.outsideShot` | `stats.outsideShot` | 표/카드/tooltip/비교 | 그대로 사용 |
| `stats.boxThreat` | `stats.boxThreat` | 동일 | 그대로 사용 |
| `stats.dangerZone` | `stats.dangerZone` | 동일 | 그대로 사용 |
| `stats.aerial` | `stats.aerial` | 동일 | 그대로 사용 |
| `stats.groundDuel` | `stats.groundDuel` | 동일 | 그대로 사용 |
| `stats.spaceControl` | `stats.spaceControl` | 동일 | 그대로 사용 |
| `meta.*` | 별도 `DatasetMeta` | 헤더/footer/status | Player에 복사하지 않음 |

권장 view type의 핵심은 다음과 같다.

```ts
type TierCode = "diamond" | "platinum" | "gold" | "silver" | "bronze" | "iron";
type MetricKey = "outsideShot" | "boxThreat" | "dangerZone" | "aerial" | "groundDuel" | "spaceControl";
type AssetRef = { id: number; name: string; icon: string | null };
type Player = {
  id: number; rank: number; name: string; position: string; archetype: "Type A" | "Type B";
  age: number | null; minutes: number; tier: { code: TierCode; level: 1 | 2 | 3 | 4 | 5; label: string };
  score: number; faceUrl: string | null; nation: AssetRef | null; league: AssetRef; club: AssetRef;
  stats: Record<MetricKey, number>;
};
```

## 6. Envelope/meta 사용 규칙

- 요청은 `limit=1000`으로 한다. 현재 예상 7-league 후보는 1000 이하이나 이는 고정 사실이 아니다.
- `meta.returned < meta.population`이면 결과가 잘린 상태다. 프론트 검색/필터가 전체 cohort 검색인 것처럼 보이면 안 되며 “일부 N/M명” 경고를 표시한다. 장기적으로 cursor pagination이 필요하다.
- `data.length === 0 && population === 0`은 정상 empty dataset이다.
- `data.length === 0 && population > 0`은 limit/서버 계약 위반이므로 schema 오류로 처리한다.
- 헤더의 선수 풀은 `meta.population`, 현재 렌더 수는 filter 결과 수다.
- tier 개수 하드코딩 `3`은 제거하고 계약상 `6` 또는 실제 data의 distinct code를 명확한 라벨과 함께 표시한다.
- `LIVE`는 제거한다. `generatedAt`을 “데이터 생성” 시각으로 표시한다.
- 최소 출전시간은 프론트 상수가 아니다. meta에 기준을 추가하기 전에는 고정 문구를 제거한다.

## 7. API URL과 프론트 환경변수

### 파일별 규칙

`.env`는 개발자별 override이며 commit하지 않는다.

```dotenv
VITE_MESSI_API_BASE_URL=http://127.0.0.1:8000
VITE_MESSI_SEASON=2025/2026
VITE_MESSI_SCOPE=7
VITE_MESSI_LIMIT=1000
```

`.env.development`는 팀 기본 로컬값으로 commit 가능하다.

```dotenv
VITE_MESSI_API_BASE_URL=http://127.0.0.1:8000
VITE_MESSI_SEASON=2025/2026
VITE_MESSI_SCOPE=7
VITE_MESSI_LIMIT=1000
```

`.env.staging`은 staging build용이며 실제 HTTPS API origin을 배포 시 주입한다. 저장소에는 비밀값을 넣지 않는다.

```dotenv
VITE_MESSI_API_BASE_URL=https://api-staging.example.invalid
VITE_MESSI_SEASON=2025/2026
VITE_MESSI_SCOPE=7
VITE_MESSI_LIMIT=1000
```

`.env.example`은 복사 가능한 문서이며 placeholder임을 명시한다.

```dotenv
VITE_MESSI_API_BASE_URL=https://api.example.com
VITE_MESSI_SEASON=2025/2026
VITE_MESSI_SCOPE=7
VITE_MESSI_LIMIT=1000
```

모든 `VITE_*` 값은 브라우저 번들에 공개된다. secret/token을 넣지 않는다. 앱 시작 시 URL, season 정규식, scope enum, limit 1~1000을 검증하고 잘못된 설정은 fetch하지 않은 채 configuration 오류 fallback을 보인다.

### fetch URL 조립 규칙

- base URL은 origin만 허용한다: 로컬은 `http://localhost:8000` 또는 `http://127.0.0.1:8000`, staging은 `https://...`.
- query/path/hash/credential이 들어간 base URL은 거부한다.
- base의 마지막 `/`를 한 번 제거하고 고정 path `/api/v1/players`를 한 번만 붙인다.
- query는 문자열 연결이 아니라 `URL`/`URLSearchParams`로 만든다. `2025/2026`은 자동 percent-encoding한다.
- staging HTTPS 페이지에서 HTTP API를 호출하지 않는다(mixed content).
- `credentials: "omit"`, `headers: {Accept: "application/json"}`, `signal`을 사용한다. GET에 `Content-Type`은 보내지 않는다.
- Vite dev proxy를 전제로 하지 않는다. 브라우저가 위 absolute API URL을 직접 호출하며 backend CORS가 허용해야 한다.

## 8. Backend CORS 계약

```dotenv
MESSI_CORS_ORIGINS=http://localhost:5173,http://127.0.0.1:5173,http://localhost:4173,http://127.0.0.1:4173,https://messi-2-staging.example.com
# 정말 필요한 경우에만, 조직이 통제하는 preview hostname 전체를 anchored regex로 제한
MESSI_CORS_ORIGIN_REGEX=^https://messi-2-dashboard-[a-z0-9-]+\.example\.com$
```

원칙:

- origin은 `scheme://host[:port]`만 쓰며 path와 마지막 `/`를 넣지 않는다.
- local 및 고정 staging/production은 comma-separated exact allowlist가 기본이다.
- `*`, `.*`, suffix만 검사하는 regex, 임의의 `vercel.app` 전체 허용은 금지한다.
- regex는 exact origin을 미리 알 수 없는 preview에만 사용하며 `^...$`, escaped dot, 프로젝트/조직 소유 hostname 경계를 포함한다.
- 허용 method는 `GET`, `OPTIONS`; 허용 header는 `Accept`, 필요 시 `Content-Type`; credentials는 `false`다.
- 환경변수 변경 후 FastAPI process를 재시작해야 middleware 설정에 반영된다.
- CORS는 인증이 아니다. 공개 API가 아니라면 별도의 edge 인증/접근제어가 필요하다.
- preflight 테스트는 local 5173/4173과 실제 staging origin 성공, 유사하지만 미허용인 hostile origin 실패를 모두 포함한다.

## 9. 비동기 상태와 UI 계약

| 상태 | 진입 조건 | 화면 | 재시도 |
|---|---|---|---|
| `idle` | 아직 요청 전 | 보통 즉시 loading으로 전이 | 해당 없음 |
| `loading` | 초기 요청 진행 | dashboard shell + row/card skeleton; 데이터 0건/empty 문구 금지 | 자동 정책 적용 |
| `success` | HTTP 2xx + JSON + runtime schema 통과 + data > 0 | 실제 목록과 meta | 새로고침 가능 |
| `empty` | 유효 envelope이며 population/data 모두 0 | “해당 시즌/scope 데이터 없음”; 필터 0건 화면과 구분 | 수동 재시도 가능 |
| `refreshing` | 기존 success 데이터가 있고 재요청 | 기존 행 유지 + 비차단 갱신 표시 | 실패 시 기존 데이터 + warning |
| `error.http` | 응답 수신, `!response.ok` | 상태별 사용자 메시지 + retry 버튼 | 아래 정책 |
| `error.network` | abort가 아닌 fetch rejection | 연결 실패 메시지 + retry | 아래 정책 |
| `error.schema` | JSON parse 또는 runtime validation 실패 | “응답 형식 확인 필요”; 더미 fallback 금지 | 자동 재시도 없음 |
| `error.config` | VITE 설정 검증 실패 | 설정 오류 fallback | 없음 |
| `error.render` | 자식 render/lifecycle 오류 | Error Boundary fallback + 복구/새로고침 | boundary reset |
| `aborted` | unmount, parameter 변경, superseded 요청 | 사용자 오류를 보이지 않음; 이전 요청은 state 갱신 금지 | 없음 |

### Row skeleton

- desktop은 실제 `<tbody>` 안에 8~12개의 skeleton `<tr>`을 두고 프로필, tier, 총점, 6 sector, minutes, age, action column 폭을 실제 행과 동일하게 만든다.
- mobile은 같은 수의 player card skeleton을 사용한다.
- skeleton container에 `aria-busy="true"`, 한 번만 읽히는 `role="status"`/“선수 데이터를 불러오는 중” 텍스트를 둔다. 장식 cell은 `aria-hidden`이다.
- shimmer는 `prefers-reduced-motion`에서 정지한다.
- loading 중 이전 empty/filter 결과를 잠깐 렌더하지 않는다.

### Error Boundary와 fetch fallback

- Error Boundary는 dashboard data subtree 바깥에 둔다. fallback에는 짧은 설명, “다시 시도”(boundary key reset), “페이지 새로고침”을 제공한다.
- Error Boundary는 Promise/fetch 오류를 잡지 못한다. HTTP/network/schema 오류는 fetch state machine에서 반드시 별도로 처리한다.
- 오류 detail, stack, 내부 경로, response body 원문은 사용자에게 노출하지 않는다.

## 10. Runtime validation과 retry

권장은 Zod 같은 검증기를 API 경계에 한 번만 두는 것이다. 라이브러리를 추가하지 않으면 동일 수준의 handwritten parser와 테스트가 필요하다. TypeScript `as PlayersEnvelope` cast는 검증이 아니다.

검증 순서:

1. env 설정 검증
2. fetch 및 HTTP status 판정
3. JSON parse
4. envelope/object/enum/range/URL strict validation
5. cross-field validation(`returned === data.length`, `population >= returned`, 요청 meta 일치, rank/id uniqueness)
6. DTO → view model adapter

Fail-closed 원칙으로 한 row라도 틀리면 전체 응답을 `error.schema`로 처리한다. 잘못된 row만 버리거나 더미로 대체하지 않는다.

자동 retry는 idempotent GET에 한해 최대 2회(최초 요청 포함 총 3회)다.

- retry: network 오류, 408, 429, 500, 502, 503, 504
- no retry: abort, 400/401/403/404/422, JSON/schema/config 오류
- delay: 약 500ms, 1500ms + jitter; `Retry-After`가 있으면 합리적인 상한 내 우선 적용
- parameter 변경 시 기존 controller를 abort하고 retry timer도 취소한다.
- manual retry는 attempt count를 초기화하고 새 controller/request id를 만든다.
- StrictMode 중복 effect와 늦게 도착한 stale response가 화면 state를 덮지 않도록 cleanup/request identity를 검증한다.

## 11. nullable 및 asset 표시 규칙

- `age === null`: `—`; 화면읽기에는 “나이 정보 없음”.
- `nation === null`: 국기 이미지 요청 없음. 검색 haystack에도 가짜 국가 문자열을 넣지 않는다.
- `faceUrl === null` 또는 이미지 실패: 기존 이니셜 fallback 사용.
- asset `icon === null` 또는 이미지 실패: 이름 기반 중립 fallback 사용. 외부 placeholder URL 요청 금지.
- league/club 이름은 원천값이므로 유지한다. 이름 자체가 불명확하면 backend가 nullable 계약으로 바꾸기 전 합성값을 만들지 않는다.
- 이미지 URL은 validator에서 HTTPS allow 규칙을 통과한 것만 DOM에 전달한다. 추후 asset manifest를 붙일 때 안정적인 ID join만 허용하고 이름 fuzzy join은 하지 않는다.

## 12. Acceptance criteria

### 계약/데이터

- [ ] 2025/2026 scope 7 요청의 응답이 확정 v1 strict schema를 통과한다.
- [ ] 6-sector key와 backend 산식이 1:1이며 5개 구 UI key가 production 코드에서 사라진다.
- [ ] server `rank`, 총점, 6-sector 값이 desktop/mobile/tooltip/compare에서 변형 없이 일치한다.
- [ ] tier 6 band와 level 1~5가 손실 없이 표시된다.
- [ ] age/nation/face/icon null이 추정값 없이 안전하게 표시된다.
- [ ] meta의 season/scope/population/returned/generatedAt/source/schemaVersion이 실제 의미대로 표시·검증된다.

### 상태/복구

- [ ] 초기 loading에서 desktop row 및 mobile card skeleton이 layout shift 없이 보인다.
- [ ] success, dataset empty, filter result 0건이 서로 다른 UI다.
- [ ] 404/422, 429, 500/503 등 HTTP 오류가 network 오류와 구분된다.
- [ ] offline/DNS/CORS 같은 fetch rejection이 network fallback으로 간다.
- [ ] malformed JSON과 enum/range/누락/extra/cross-field 오류가 schema fallback으로 간다.
- [ ] abort는 toast/error/console noise 없이 state 갱신을 중단한다.
- [ ] 자동 retry 대상/횟수/backoff 및 manual retry가 deterministic test로 검증된다.
- [ ] render-time throw가 Error Boundary fallback에 잡히고 reset/새로고침으로 복구 가능하다.
- [ ] Error Boundary가 fetch 오류 처리의 대체물로 쓰이지 않는다.

### CORS/env

- [ ] `.env`, `.env.development`, `.env.staging`, `.env.example`의 역할과 값이 위 규칙을 따른다. 실제 secret은 없다.
- [ ] local 5173/4173 및 확정 HTTPS staging origin에서 preflight/GET이 성공한다.
- [ ] 미허용 origin과 유사 도메인은 CORS header를 받지 못한다.
- [ ] staging frontend는 HTTPS API만 호출하고 URL에 `//api`, 중복 path, 미인코딩 season이 없다.
- [ ] 브라우저 요청은 `credentials: omit`이며 불필요한 preflight header를 만들지 않는다.

### mock 제거 완료 기준

- [ ] `MessiScoutingDashboard`가 더 이상 `samplePlayers`를 import/default props로 사용하지 않는다.
- [ ] production entry는 API resource/container만 렌더하며 fetch 실패 시 샘플로 fallback하지 않는다.
- [ ] `samplePlayers.ts`는 삭제하거나 test fixture 디렉터리로 이동하고 production dependency graph에서 제외한다.
- [ ] `rg "samplePlayers|placehold\.co|linkPlay|pressing" src`가 production 참조 0건이다(테스트 fixture의 의도적 참조는 별도 허용 가능).
- [ ] tier/선수 수/`LIVE`/minimum minutes 하드코딩이 제거되거나 meta 기반이다.
- [ ] `dist`를 재빌드한 뒤에도 `rg "placehold\.co|Erling Haaland|samplePlayers" dist`가 0건이다.

### 자동화/QA

- [ ] frontend unit/component tests와 production build가 통과한다.
- [ ] backend pytest, OpenAPI schema, CORS preflight tests가 통과한다.
- [ ] 실제 endpoint 응답을 fixture로 고정한 contract test가 frontend와 backend 양쪽에 있다.
- [ ] desktop/mobile에서 loading → real rows, retry, nullable assets, compare/watchlist reconcile을 smoke test한다.
- [ ] API에서 사라진 선수 ID는 저장 목록/비교 목록에서 정리되며 localStorage 손상값은 무시한다.

## 13. 구현 순서

1. backend의 partial schema/service를 확정 wire 계약에 맞추고 실제 실행 테스트를 통과시킨다.
2. frontend DTO validator, adapter, env parser, typed error를 만든다.
3. data resource/state machine과 abort/retry를 연결한다.
4. nullable view type, 6-sector/tier config, server rank/meta 렌더링을 반영한다.
5. row/card skeleton, async fallback, Error Boundary를 연결한다.
6. production mock 의존을 제거하고 계약/상태/CORS 테스트 및 dist 재빌드를 완료한다.

백엔드 계약 확정 전에 UI adapter부터 임시 호환 구현하지 않는 것이 중요하다. 현재 partial JSON을 조용히 수용하면 tier level, archetype, 데이터 생성시각과 missing-data 진실성이 다시 손실된다.
