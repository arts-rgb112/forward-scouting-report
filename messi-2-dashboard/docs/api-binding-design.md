# M.E.S.S.I. 2.0 API 바인딩 구현 설계

작성일: 2026-08-10  
대상: `messi-2-dashboard`, 2025/2026 시즌, scope 7  
성격: 구현 명세. 이 문서는 코드 변경을 포함하지 않는다.

## 0. 결정 요약

- production 진입점은 `samplePlayers`를 전혀 알지 못한다. `App` → `DashboardErrorBoundary` → `PlayersResourceContainer` → 순수 표시 컴포넌트 `MessiScoutingDashboard` 순으로만 데이터를 전달한다.
- API 경계에서 wire envelope 전체를 Zod `strict()` schema로 검증하고 교차 필드 검증 후 `Player` view model로 1:1 변환한다. 누락값 추정, 잘못된 행 삭제, 샘플 대체, 프론트 지표 재계산은 금지한다.
- 실제 표와 loading 표는 `PlayerTableFrame`, `PlayerTableColgroup`, `PlayerTableHeader`를 공유한다. 6-sector 기준 열 폭 합계와 `min-width`는 정확히 1,418px, 헤더 44px, 데이터/skeleton 행은 정확히 72px이다.
- 초기 로딩만 skeleton을 보인다. 이미 성공한 데이터의 재요청은 기존 표/카드를 유지하면서 비차단 `refreshing` 표시를 겹친다.
- 데이터셋 empty(`returned=population=0`)와 필터 결과 0을 분리한다. HTTP/network/schema/config 오류는 async fallback에서 처리하고, render/lifecycle 오류만 Error Boundary에서 처리한다.
- 서버 `rank`, 6개 sector, 6-tier와 `level`, nullable `age`/`face`/`nation`/asset icon, `meta`를 모든 desktop/mobile/tooltip/compare 표면에서 일관되게 사용한다.

## 1. 컴포넌트 경계와 파일 구조

### 1.1 데이터 흐름

```text
main.tsx
└─ App (정적 dark shell/brand만 소유)
   └─ DashboardErrorBoundary (render/lifecycle 오류 경계)
      └─ PlayersResourceContainer (env, fetch, validation, retry, abort)
         ├─ initial loading → DashboardLoading
         ├─ async failure  → DashboardDataFallback
         └─ success/refreshing/empty
            └─ MessiScoutingDashboard (표시 및 로컬 UI 상태)
               ├─ DatasetHeader
               ├─ DashboardToolbar
               ├─ PlayerCardList | MobilePlayerCardSkeletons
               ├─ PlayerTable | PlayerTableSkeleton
               ├─ DatasetEmptyState | FilterEmptyState
               ├─ DatasetFooter
               └─ CompareTray
```

`PlayersResourceContainer`만 네트워크와 wire 타입을 안다. `MessiScoutingDashboard`는 `{ players, meta, refreshing, onRefresh }`만 받고 fetch, env, Zod, sample fixture를 import하지 않는 presentational/controller 조합이다. 검색, 정렬, watchlist, compare는 기존처럼 dashboard 내부 로컬 UI 상태로 유지한다.

### 1.2 제안 파일 구조 및 변경 책임

```text
src/
  app/App.tsx                         # shell, boundary 배치, reset key 소유
  api/env.ts                          # import.meta.env 파싱 및 URL 조립
  api/contracts.ts                    # Zod wire schemas, cross-field validation
  api/adapter.ts                      # WirePlayer -> Player 1:1 adapter
  api/errors.ts                       # typed async/config errors와 사용자 메시지 매핑
  api/playersApi.ts                   # 단일 GET attempt, HTTP/JSON/schema 단계
  api/retry.ts                        # retry policy, Retry-After, delay/jitter
  dashboard/PlayersResourceContainer.tsx
                                      # reducer, AbortController, stale guard
  dashboard/playersResourceState.ts   # state/action/reducer; React 비의존 테스트 대상
  dashboard/types.ts                  # Player/DatasetMeta/6-sector/6-tier view types
  dashboard/scoutingConfig.ts         # 6-sector 및 6-tier 표시 설정
  dashboard/playerQuery.ts            # position 필터, nullable age sort/search
  dashboard/MessiScoutingDashboard.tsx# 순수 데이터 props; sample 기본값 제거
  dashboard/components/
    DashboardChrome.tsx               # 공통 shell 영역(선택적 분리)
    DatasetHeader.tsx                 # meta/refreshing/partial 경고
    DatasetFooter.tsx                 # cohort/returned/generatedAt/source
    DashboardLoading.tsx              # initial shell + 양쪽 breakpoint skeleton
    DashboardDataFallback.tsx         # dataset empty 및 typed async error
    DashboardErrorBoundary.tsx        # class boundary + reset contract
    PlayerTableLayout.tsx             # colgroup/header/frame/scroll sync 공유
    PlayerTable.tsx                   # 실제 tbody만 구성
    PlayerTableSkeleton.tsx           # skeleton tbody만 구성
    PlayerCardList.tsx
    MobilePlayerCardSkeletons.tsx
    PlayerIdentity.tsx
    AssetImage.tsx
    TierBadge.tsx                     # six tier + level, 외부 placeholder 없음
    ...기존 컴포넌트
```

테스트 fixture가 필요하면 `src/dashboard/samplePlayers.ts`를 production source에서 삭제하고 `src/test/fixtures/players.ts`로 이동한다. 테스트 fixture를 production 모듈에서 export하거나 production bundle이 import해서는 안 된다.

필수 환경 파일:

- `.env`: 개인 override 용도이며 `.gitignore`에 포함, 커밋 금지.
- `.env.development`: 팀 로컬 기본값. 예: `http://127.0.0.1:8000`.
- `.env.staging`: 확정된 실제 HTTPS API origin. 비밀값 금지.
- `.env.example`: 네 key의 설명과 복사 예시. 실제 비밀값 금지.

## 2. 타입 및 표시 컴포넌트 계약

### 2.1 view model

```ts
type MetricKey =
  | "outsideShot"
  | "boxThreat"
  | "dangerZone"
  | "aerial"
  | "groundDuel"
  | "spaceControl";

type TierCode =
  | "diamond"
  | "platinum"
  | "gold"
  | "silver"
  | "bronze"
  | "iron";

type AssetRef = { id: number; name: string; icon: string | null };
type Tier = { code: TierCode; level: 1 | 2 | 3 | 4 | 5; label: string };

type Player = {
  id: number;
  rank: number;
  name: string;
  position: string;
  archetype: "Type A" | "Type B";
  age: number | null;
  minutes: number;
  tier: Tier;
  score: number;
  face: string | null;
  nation: AssetRef | null;
  league: AssetRef;
  club: AssetRef;
  stats: Record<MetricKey, number>;
};

type DatasetMeta = {
  schemaVersion: "1.0.0";
  season: string;
  scope: 3 | 5 | 7;
  population: number;
  returned: number;
  generatedAt: string;
  source: "messi-static-cohort";
};
```

### 2.2 주요 props

```ts
type MessiScoutingDashboardProps = {
  players: readonly Player[];
  meta: DatasetMeta;
  refreshing: boolean;
  onRefresh(): void;
};

type DatasetHeaderProps = {
  meta: DatasetMeta | null;
  visibleCount?: number;
  refreshing: boolean;
};

type PlayerCollectionProps = {
  players: readonly Player[];
  comparedIds: ReadonlySet<number>;
  watchedIds: ReadonlySet<number>;
  onToggleCompare(player: Player): void;
  onToggleWatch(player: Player): void;
};

type AssetImageProps = {
  src: string | null;
  alt: string;
  kind: "face" | "nation" | "league" | "club";
  fallbackLabel: string;
  width: number;
  height: number;
  className?: string;
  loading?: "eager" | "lazy";
};

type TierBadgeProps = { tier: Tier; compact?: boolean };
```

`MessiScoutingDashboardProps.players`는 optional이 아니며 기본값도 없다. `rank` 표시는 `String(player.rank).padStart(2, "0")`이며 `index + 1`을 사용하지 않는다. 필터는 `position`의 정확한 단일 문자열만 사용해 `ALL + unique(position)` 옵션을 만든다. `role.split("/")` 로직을 제거한다. `archetype`은 position과 별도 라벨로 표시한다.

나이 오름차순 정렬 비교식은 `(a.age === null) - (b.age === null)`에 해당하는 명시적 분기 후 non-null 값만 비교하여 null이 항상 마지막이어야 한다. 검색 haystack은 `nation ? nation.name : ""`를 사용하고, nation null에서 국가 토큰을 합성하지 않는다.

## 3. 데스크톱 표와 row skeleton

### 3.1 공유 열 정의

열 순서와 폭은 아래 하나의 상수/컴포넌트에서 실제 표와 skeleton이 공유한다.

| 순서 | 열 | 폭 |
|---:|---|---:|
| 1 | 선수 프로필(rank 포함) | 330px |
| 2 | tier | 80px |
| 3 | M.E.S.S.I. total | 96px |
| 4–9 | 6 sectors | 각 96px, 합계 576px |
| 10 | minutes | 96px |
| 11 | age | 64px |
| 12 | compare | 96px |
| 13 | watch/actions | 80px |
| | 합계 / table min-width | **1,418px** |

`PlayerTableColgroup` DOM은 항상 다음과 같다.

```html
<colgroup>
  <col class="w-[330px]" />
  <col class="w-20" />
  <col class="w-24" />
  <!-- metricKeys 순서로 <col class="w-24" /> 6개 -->
  <col class="w-24" />
  <col class="w-16" />
  <col class="w-24" />
  <col class="w-20" />
</colgroup>
```

두 table 모두 `w-full min-w-[1418px] table-fixed border-collapse text-left`를 사용한다. 기존 `min-w-[1340px]`는 6-sector 합계와 다르므로 남겨두지 않는다. `metricKeys`는 위의 wire 순서로 고정된 readonly tuple이어야 하며 `Object.keys()` 순서에 기대지 않는다.

### 3.2 frame과 horizontal sync

```html
<section class="hidden ... md:block" aria-labelledby="players-table-heading">
  <h2 id="players-table-heading" class="sr-only">...</h2>
  <div data-table-sticky-header class="sticky top-0 z-30 overflow-hidden ..." aria-hidden="true">
    <table><!-- shared colgroup + visible shared header --></table>
  </div>
  <div data-table-scrollport class="overflow-x-auto">
    <table>
      <caption class="sr-only">...</caption>
      <!-- shared colgroup + sr-only shared header -->
      <tbody><!-- real rows OR skeleton rows --></tbody>
    </table>
  </div>
  <DatasetFooter />
</section>
```

`PlayerTableFrame`은 sticky header ref와 scroll handler를 한 번만 구현한다. scrollport의 `scrollLeft`를 sticky header에 즉시 대입하며 실제/로딩 모두 같은 frame을 쓴다. sticky 첫 열의 배경색과 `left: 0`, z-index도 실제와 skeleton에서 동일하다. resize 시 별도 폭 측정은 하지 않는다. 동일한 fixed colgroup이 정렬을 보장한다.

시각 헤더는 `aria-hidden="true"`인 복제본이고, scroll table 안의 헤더는 `sr-only`여도 접근성 트리에 남아 각 셀 헤더 관계를 제공한다. skeleton 로딩 중에는 skeleton table 자체를 `aria-hidden="true"`로 하되 별도의 한 개 status announcement를 둔다.

### 3.3 실제 행과 skeleton 행

실제 행과 skeleton 행 모두 `<tr class="h-[72px] ...">`이다. skeleton은 기본 10행(허용 8–12행)이며 각 행은 실제와 동일하게 13개의 셀을 만든다.

```html
<tbody aria-hidden="true">
  <tr class="h-[72px] border-b ...">
    <th class="sticky left-0 ... px-3">
      <!-- rank 20px + 48x48 face + two text bars -->
    </th>
    <td><!-- 32x32 tier shape --></td>
    <td><!-- total bar + underline --></td>
    <!-- sector score pill 6개 -->
    <td><!-- minutes bar --></td>
    <td><!-- age bar --></td>
    <td><!-- 44x44 compare control placeholder --></td>
    <td><!-- 44x44 watch control placeholder --></td>
  </tr>
</tbody>
```

각 placeholder는 `bg-white/[.06]` 계열의 고정 크기를 사용한다. content 길이에 따라 셀 높이/폭이 변하면 안 된다. shimmer는 행 전체가 아니라 공통 `.skeleton` pseudo-element로 구현하되 opacity를 낮춰 기존 다크/고밀도 테마를 유지한다.

## 4. 모바일 card skeleton

`MobilePlayerCardSkeletons`는 실제 목록과 같은 `md:hidden space-y-2` section, 기본 5개 article을 렌더한다. 각 article은 실제 카드와 같은 `rounded-lg border border-white/10 bg-[#0d1112] p-3`를 사용한다.

각 카드 DOM/치수:

1. 상단 row: rank bar, 56×56 face, 이름/club·league 두 줄, 우측 total score.
2. sector grid: `grid grid-cols-3 gap-2`; 6-sector를 모두 보여 두 줄 높이를 항상 예약한다. 초기 로딩 skeleton에는 펼치기 버튼을 만들지 않는다.
3. actions: `mt-3 grid grid-cols-2 gap-2`, 각 placeholder 높이 44px.

실제 모바일 카드도 6-sector 계약에 맞춰 첫 3개 + 나머지 3개를 접거나, 모두 2행으로 노출하는 한 가지 정책을 택한다. 기존 “추가 지표 2개” 문구는 삭제하고 접기 정책이면 “추가 지표 3개 보기”로 바꾼다. skeleton은 가장 큰 실제 상태(6개 노출)의 높이를 예약해 success 전환 시 아래 콘텐츠가 위로 밀리는 것보다 약간 줄어드는 방향으로만 움직이게 한다. 더 엄격한 CLS 0 요구 시 실제 카드도 기본 6개 노출로 통일한다(권장).

## 5. async 상태와 fallback

### 5.1 resource state

```ts
type PlayersResourceError =
  | { kind: "config"; code: string; message: string }
  | { kind: "network"; cause?: unknown }
  | { kind: "http"; status: number; retryAfterMs?: number }
  | { kind: "schema"; stage: "json" | "schema" | "cross-field"; issues?: readonly string[] };

type PlayersPayload = { players: readonly Player[]; meta: DatasetMeta };

type PlayersResourceState =
  | { status: "idle" }
  | { status: "loading"; requestId: number }
  | { status: "refreshing"; requestId: number; payload: PlayersPayload }
  | { status: "success"; payload: PlayersPayload }
  | { status: "empty"; payload: PlayersPayload }
  | { status: "error"; error: PlayersResourceError; previous?: PlayersPayload };
```

`aborted`는 사용자에게 렌더할 종착 상태가 아니라 reducer action/요청 결과다. abort된 최초 요청은 `idle`, 기존 payload가 있던 요청은 기존 `success|empty`로 복귀하거나 즉시 superseding request 상태로 넘어간다.

### 5.2 transition contract

| 현재 | event | 다음 | UI |
|---|---|---|---|
| idle | LOAD | loading | shell + skeleton |
| loading | RESOLVE(non-empty) | success | 실제 목록 |
| loading | RESOLVE(empty) | empty | dataset empty |
| loading | REJECT | error | typed fallback |
| success/empty | REFRESH | refreshing | 기존 payload 유지 + 갱신 표시 |
| refreshing | RESOLVE(non-empty) | success | 새 목록으로 원자적 교체 |
| refreshing | RESOLVE(empty) | empty | dataset empty |
| refreshing | REJECT | error(previous) | 기존 목록 유지 + 비차단 오류 banner와 retry |
| any active | ABORT | 이전 안정 상태 또는 idle | 오류 announcement 없음 |
| error | RETRY | loading 또는 refreshing | attempt 0에서 새 cycle |

모든 action은 `requestId`를 포함하고 reducer는 현재 requestId와 다른 resolve/reject를 무시한다. effect cleanup과 파라미터 변경은 `AbortController.abort()` 및 pending retry timer 취소를 함께 수행한다. React StrictMode의 mount-cleanup-remount와 늦은 응답이 화면을 덮지 못해야 한다.

### 5.3 상태별 카피와 동작

| 상태 | 제목/메시지 | action |
|---|---|---|
| loading | `선수 데이터를 불러오는 중입니다` | 없음; 단일 `role=status` |
| refreshing | `데이터 갱신 중…` | 기존 행/카드 유지, 작은 spinner/텍스트; controls 유지 |
| empty dataset | `이 데이터셋에는 선수가 없습니다` / `{season}, {scope}개 리그 조건의 원천 데이터가 비어 있습니다.` | `다시 불러오기` |
| filter 0 | `조건에 맞는 선수가 없습니다` | `필터 전체 초기화`; 네트워크 retry 아님 |
| HTTP | `서버에서 선수 데이터를 가져오지 못했습니다` / `응답 코드 {status}` | `다시 시도` |
| network | `네트워크에 연결할 수 없습니다` / 연결 확인 안내 | `다시 시도` |
| schema | `선수 데이터 형식을 확인할 수 없습니다` / 운영 데이터 검증 실패 안내 | `다시 시도`는 제공하되 자동 재시도 없음; 진단 상세는 개발 로그만 |
| config | `API 설정이 올바르지 않습니다` / 배포 설정 확인 안내 | retry 비활성 또는 없음; 페이지 새로고침만으로 해결된다는 오도 금지 |

HTTP 401/403/404 같은 비재시도 상태도 수동 retry 버튼은 제공할 수 있으나 자동 retry는 하지 않는다. refreshing 실패 시 표 위 compact alert를 사용하고 기존 데이터에 `이전 데이터 표시 중`을 명시한다. 실패한 새 응답의 일부 행은 절대 섞지 않는다.

`returned < population`이면 header에 `일부 데이터 표시 중: {returned}/{population}명` 경고를 항상 표시한다. `returned === 0 && population > 0`은 empty가 아니라 schema error이다.

## 6. Error Boundary 배치 및 reset

`DashboardErrorBoundary`는 resource container보다 바깥, 정적 앱 shell 안에 둔다. fetch Promise rejection은 boundary로 throw하지 않고 resource error로 처리한다.

```tsx
<AppShell>
  <DashboardErrorBoundary
    resetKey={boundaryResetKey}
    onReset={() => setBoundaryResetKey((n) => n + 1)}
  >
    <PlayersResourceContainer boundaryResetKey={boundaryResetKey} />
  </DashboardErrorBoundary>
</AppShell>
```

class boundary state는 `{ error: Error | null, observedResetKey: number }`를 가진다. `getDerivedStateFromError`로 fallback을 열고, `componentDidCatch(error, info)`는 개발/관측 채널에만 상세를 기록한다. `componentDidUpdate` 또는 `getDerivedStateFromProps`에서 `resetKey` 변경 시 error를 null로 만든다.

fallback에는 `대시보드를 표시하는 중 문제가 발생했습니다`, `다시 시도`, `페이지 새로고침`을 제공한다. `다시 시도`는 boundary key를 증가시켜 subtree를 새로 mount하고 resource request도 새 cycle로 시작한다. 동일 key에서 단순히 `setState({error:null})`만 해 같은 오류 subtree를 즉시 재렌더하지 않는다. 페이지 새로고침은 명시적 보조 action이다. fallback 자체는 boundary 바깥 `AppShell` 스타일을 이용하며 오류 stack/원문을 사용자에게 노출하지 않는다.

## 7. env, Zod, adapter, fetch/retry 인터페이스

### 7.1 env parser

```ts
type MessiApiConfig = {
  baseUrl: string;       // trailing slash 제거된 origin
  season: string;        // 2025/2026
  scope: 3 | 5 | 7;
  limit: number;         // 현재 1000
};

function parseMessiApiConfig(
  env: ImportMetaEnv,
  mode: string
): MessiApiConfig;

function buildPlayersUrl(config: MessiApiConfig): URL;
```

규칙:

- `VITE_MESSI_API_BASE_URL`, `VITE_MESSI_SEASON`, `VITE_MESSI_SCOPE`, `VITE_MESSI_LIMIT` 누락/형식 오류는 `config` error.
- base URL은 `new URL`로 파싱 후 username/password, search, hash가 없어야 하고 pathname은 `"/"`만 허용한다. 저장 시 trailing slash를 제거한다.
- hostname이 `localhost` 또는 `127.0.0.1`일 때만 `http:` 허용한다. staging/production은 반드시 `https:`이다.
- `buildPlayersUrl`은 base origin에 고정 pathname `/api/v1/players`를 설정하고 `URLSearchParams`로 `season`, `scope`, `limit`을 넣는다. 문자열 연결과 dev proxy 의존을 금지한다.
- VITE 값은 브라우저에 공개된다. token/secret을 추가하지 않는다.

### 7.2 Zod parser

`zod`를 runtime dependency에 추가한다. wire schema는 view 타입과 별도이며 모든 object에 `.strict()`를 적용한다.

```ts
function parsePlayersEnvelope(
  input: unknown,
  expected: Pick<MessiApiConfig, "season" | "scope">
): WirePlayersEnvelope;
```

검증 순서:

1. envelope `{data, meta}` 및 각 nested object extra key 금지.
2. enum/literal: schemaVersion/source/scope/archetype/tier code/level.
3. 숫자는 finite; id/rank/minutes/population/returned는 integer 및 의미상 non-negative/positive 범위, score와 6 stats는 0..100.
4. `face`, `icon`은 null 또는 absolute `https:` URL만 허용. 상대 URL, data URL, javascript URL, http asset을 DOM에 전달하지 않는다.
5. `returned === data.length`, `population >= returned`, request season/scope와 meta 일치.
6. `data.length === 0 && population > 0` 거부.
7. id unique, rank unique.
8. `generatedAt`은 timezone offset 또는 `Z`를 포함한 유효 ISO timestamp이어야 한다.

Zod issue를 사용자 메시지에 직접 출력하지 않는다. 개발 로그/telemetry에는 field path 중심으로 기록하되 payload 전체나 URL query를 무분별하게 기록하지 않는다.

### 7.3 adapter

```ts
function adaptPlayersEnvelope(wire: WirePlayersEnvelope): PlayersPayload;
function adaptPlayer(wire: WirePlayer): Player;
```

adapter는 동명 필드를 복사하고 stats 6개를 명시적으로 나열한다. 계산, 기본 이미지, age/nation 합성, rank 재번호, tier 축약을 하지 않는다. 반환 객체/배열을 개발 모드에서 freeze하는 것은 선택 사항이나 contract 변경은 금지한다.

### 7.4 fetch와 retry

```ts
type FetchPlayersDeps = {
  fetchImpl?: typeof fetch;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
  random(): number;
  now(): number;
};

async function fetchPlayers(
  config: MessiApiConfig,
  signal: AbortSignal,
  deps?: Partial<FetchPlayersDeps>
): Promise<PlayersPayload>;
```

요청 옵션은 `{ method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }`이다. GET `Content-Type`는 보내지 않는다.

한 attempt 순서: fetch → HTTP status 확인 → JSON parse → Zod/cross-field → adapter. 자동 재시도 대상은 network 오류와 408/429/500/502/503/504만이며 최대 2회 재시도, 총 3 attempts다. abort, config, 일반 4xx, JSON parse, schema는 재시도하지 않는다.

기본 delay는 약 500ms, 1500ms에 bounded jitter를 더한다. `Retry-After`가 유효하면 서버값을 우선하되 예를 들어 30초 상한을 둔다. seconds와 HTTP-date를 모두 해석한다. `sleep`은 signal을 받아 abort 시 timer를 해제하고 `AbortError`를 reject해야 한다. 테스트에서 `sleep/random/now/fetchImpl`을 주입해 지연 없이 결정적으로 검증한다.

## 8. meta, nullable, sector/tier UI 변경

### 8.1 header/footer

기존 header의 `선수 풀 / tier 3 / LIVE` 하드코드를 다음으로 교체한다.

- 선수 풀: `meta.population`.
- 반환: `meta.returned` (partial이면 경고 색상과 `일부 N/M`).
- 범위: `meta.scope개 리그`.
- 시즌: `meta.season`.
- 갱신: `generatedAt`을 사용자 locale로 포맷. `LIVE` 금지.

footer는 `현재 표시 {filteredPlayers.length}명 · 반환 {meta.returned}명 · 전체 선수 풀 {meta.population}명`과 `source`, `schemaVersion`, 갱신 시각을 제공한다. 기존 `min. 900 minutes`는 meta에 없는 정보이므로 제거한다. `players.length`를 population으로 부르지 않는다.

시각 timestamp와 함께 `<time dateTime={meta.generatedAt}>…</time>`을 사용한다. hydration 없는 Vite SPA이므로 locale 포맷은 허용하되 invalid timestamp는 parser에서 이미 차단한다.

### 8.2 nullable

- `age === null`: 시각 `—`, 별도 `.sr-only` 텍스트 `나이 정보 없음`. 숫자 0이나 추정 나이 금지.
- `face === null` 또는 load error: 선수 이름 이니셜 fallback. `img` 요청 자체를 만들지 않는다.
- `nation === null`: 국가 이미지와 가짜 국가 텍스트를 모두 렌더하지 않고, 필요 시 중립 `국가 정보 없음` 텍스트만 sr-only로 제공한다. search token에도 넣지 않는다.
- league/club `icon === null` 또는 load error: 이름 기반 중립 fallback. `placehold.co` 및 외부 placeholder 금지.
- decorative asset의 `alt=""`; 정보가 이미지로만 전달되면 의미 있는 alt 또는 인접 텍스트를 둔다. 실패 fallback도 동일한 접근성 의미를 유지한다.
- `AssetImage`는 nullable `src`를 받고 `src`가 null이면 `<img>`를 생성하지 않는다. src 변경 시 failure state를 reset한다.

### 8.3 6-sector

`metricKeys` 순서:

1. `outsideShot` — 박스 밖 슈팅, 20%
2. `boxThreat` — 박스 위협, 30%
3. `dangerZone` — 위험 구역 전진, 15%
4. `aerial` — 공중 경합, 10%
5. `groundDuel` — 지상 경합, 10%
6. `spaceControl` — 공간 지배, 15%

label/short/detail/weight는 `scoutingConfig`에 정의하지만 weight로 점수를 재계산하지 않는다. desktop header, row, mobile, tooltip, compare table은 모두 같은 tuple을 map한다. `linkPlay`, `pressing`, `progression`은 production 코드와 dist에서 0건이어야 한다.

### 8.4 6-tier + level

`tierConfig`는 six code 각각의 label, color, neutral CSS glyph를 제공한다. 외부 URL 이미지를 쓰지 않는다. `TierBadge`는 최소한 `tier.label`과 `Lv.{tier.level}`을 시각/접근성 텍스트로 보존한다. 예: `aria-label="플래티넘, 레벨 2"`. 서버 label을 임의로 다시 만들지 않으며 color/glyph 선택만 code config에 둔다. desktop, mobile, compare에서 동일 컴포넌트를 쓴다.

## 9. 접근성 및 motion

- initial loading 영역 최상위에 `aria-busy="true"`; 완료 시 false 또는 속성 제거.
- 로딩 announcement는 페이지당 한 번만 `<p role="status" aria-live="polite">선수 데이터를 불러오는 중입니다</p>`로 제공한다. skeleton 행/카드는 `aria-hidden="true"`이고 focusable element가 없다.
- refreshing은 `role=status` polite 한 번만 사용하며 기존 table/card에 `aria-busy=true`를 적용할 수 있다. 기존 조작을 막지 않는다.
- error fallback은 `role="alert"` 또는 assertive live region 하나만 사용한다. retry button으로 focus를 이동하거나 fallback heading에 `tabIndex=-1` 후 focus한다.
- filter empty와 dataset empty는 서로 다른 heading 및 설명을 가진다.
- sticky visual header의 복제 텍스트는 `aria-hidden=true`; 본문 table의 sr-only header는 접근성 트리에 남긴다.
- 모든 retry/reset/action은 최소 44×44px, 명확한 `focus-visible` ring, 텍스트 label을 가진다.
- score를 색만으로 전달하지 않고 숫자, tier를 glyph/색만이 아니라 label+level로 전달한다.
- `.skeleton` shimmer는 `@media (prefers-reduced-motion: reduce)`에서 animation을 완전히 `none`으로 한다. 전역 0.01ms 규칙에만 기대지 않는다. spinner도 정적 아이콘/텍스트로 바뀐다.
- 갱신 성공/오류 announce를 중복하지 않도록 live region ownership을 resource container 한 곳에 둔다.

## 10. 테스트 설계

### 10.1 단위 테스트

`api/env.test.ts`

- 4개 정상 값 파싱, slash 제거, pathname 및 URLSearchParams encoding(`2025%2F2026`).
- missing/invalid scope/limit/season, credential/query/hash/path 포함 base URL 거부.
- localhost/127.0.0.1 http 허용, staging http 거부, HTTPS 허용.

`api/contracts.test.ts`

- 완전한 25/26 scope7 fixture 성공.
- 모든 object의 extra key, old metric key, missing sector, enum/range/NaN/float integer 오류 거부.
- non-HTTPS/relative asset URL 거부, nullable URL/nation/age 허용.
- returned/data length, population, season/scope, zero/population, duplicate id/rank, timezone 없는 generatedAt 오류.
- 한 row 오류가 envelope 전체 실패이며 row drop이 없음을 검증.

`api/adapter.test.ts`

- id/rank/position/archetype/tier level/6 stats/meta가 1:1 보존.
- null age/face/nation/icon 보존, 재계산/기본값 없음.

`api/retry.test.ts` 및 `api/playersApi.test.ts`

- network 및 허용 status는 총 3 attempts, 408/429/500/502/503/504 각각 검증.
- 400/401/403/404, abort, JSON, schema, config는 1 attempt.
- Accept/credentials omit/signal 및 GET Content-Type 부재.
- 500→success, network→network→success, 세 번 실패 최종 typed error.
- Retry-After seconds/date/invalid/cap, 500/1500+jitter를 주입 dependency로 결정적 검증.
- backoff 중 abort 시 timer 해제와 추가 fetch 없음.

`dashboard/playersResourceState.test.ts`

- 표의 모든 transition, requestId stale action 무시, manual retry attempt reset.
- initial abort 무표시, refresh abort 안정 payload 복원.

`dashboard/playerQuery.test.ts`

- 정확한 single position 옵션/필터, nation null 검색 안전.
- rank와 입력 배열 불변, age null 항상 마지막(오름/내림 정책이 추가되면 양쪽 모두).

### 10.2 컴포넌트 테스트

`PlayerTableLayout.test.tsx`

- 실제/skeleton 양쪽 col 수 13, metric col 6, class `min-w-[1418px]`, row `h-[72px]`.
- visual/stored header의 같은 label 순서, visual header aria-hidden, accessible header 존재.
- scroll event 후 sticky header `scrollLeft` 일치.
- server rank 표시, 6-sector 값과 total/minutes/age/actions 셀 일치.

`PlayerTableSkeleton.test.tsx`

- 10 rows, 각 13 cells, focusable 요소 0, aria-hidden, status는 외부 한 개.

`MobilePlayerCardSkeletons.test.tsx`

- 5 cards, 56px face, sector placeholder 6, 44px actions, `md:hidden`.

`DashboardStates.test.tsx`

- loading, refreshing, dataset empty, filter 0, HTTP/network/schema/config 각각의 정확한 message/action.
- refreshing에서 이전 rows 유지와 compact 오류 banner.
- retry 클릭 callback 1회, config에는 잘못된 retry 노출 없음.
- reduced-motion media query에서 shimmer class는 있어도 computed animation 없음(가능하면 browser test 보강).

`NullablePresentation.test.tsx`

- null face/icon에서 img request DOM 없음, 이니셜/중립 fallback.
- null nation에서 img/가짜 token 없음, null age `—`와 sr-only 문구.
- 이미지 onError 후 fallback과 src 변경 후 recovery.

`TierAndMetrics.test.tsx`

- six tier × levels 대표값, label+level 접근성 이름.
- desktop/mobile/tooltip/compare에서 동일 6-sector 값.

`DashboardErrorBoundary.test.tsx`

- render throw만 fallback 처리, 오류 원문 미노출.
- reset 클릭 시 key 증가/subtree remount 및 정상 복구.
- async rejection을 boundary가 아니라 data fallback이 처리.

### 10.3 통합/E2E 및 정적 검증

- mocked endpoint initial loading → real desktop rows; mobile cards; meta header/footer.
- 500, 500, 200 순서 재시도와 abort; Retry-After; manual retry attempt reset.
- parameter supersede 시 첫 응답이 늦게 와도 둘째 응답을 덮지 않음.
- nullable row의 desktop/mobile/compare/watch reconcile.
- partial `returned < population` 경고, `0/0` dataset empty, `0/population>0` schema fallback.
- hostile API payload의 extra field/relative URL/duplicate rank 전체 거부.
- local 및 staging origin CORS preflight/GET 성공, 비슷한 hostile origin에는 `Access-Control-Allow-Origin` 없음. credentials false, methods GET/OPTIONS 확인.
- 실제 endpoint 캡처 fixture를 contract parser에 통과시키는 consumer contract test.
- `pnpm test`, `pnpm build` 성공 후 생성된 `dist`까지 아래 정적 검색 결과 0:

```text
samplePlayers
placehold.co
linkPlay
pressing
progression
LIVE
min. 900
```

dist를 커밋하는 정책이면 mock 제거 후 반드시 재빌드하며, 이전 hashed asset을 배포 산출물에 남기지 않는다.

## 11. 구현 순서와 파일별 체크

1. `zod` 추가, `types.ts`, `contracts.ts`, `env.ts`, `adapter.ts`, `errors.ts`를 먼저 완성하고 단위 contract test를 통과시킨다.
2. `playersApi.ts`, `retry.ts`, reducer/container를 구현해 abort/stale/retry를 React 외부와 hook 수준에서 검증한다.
3. `scoutingConfig`, query, asset/tier/identity를 nullable·6-sector·6-tier 계약으로 변경한다.
4. `PlayerTableLayout`을 추출해 실제와 skeleton의 colgroup/header/frame을 공유시킨 뒤 card/skeleton을 변경한다.
5. header/footer/fallback/refreshing/Error Boundary를 연결한다.
6. `MessiScoutingDashboard`의 sample 기본값/import를 제거하고 production entry를 resource only로 바꾼다.
7. component/integration/CORS/actual fixture test, build, dist 정적 검색을 수행한다.

## 12. 최종 acceptance checklist

### 데이터 계약

- [ ] GET URL은 exact origin + `/api/v1/players?season=2025%2F2026&scope=7&limit=1000`이다.
- [ ] strict envelope와 교차 필드 검증 후에만 adapter가 실행된다.
- [ ] 한 행 오류 시 전체 schema error이며 샘플/더미/행 삭제 fallback이 없다.
- [ ] server rank, score, 6 stats, tier code+level, position/archetype가 모든 화면에서 그대로 보인다.
- [ ] meta의 population/returned/generatedAt/source/schemaVersion 의미가 뒤섞이지 않는다.

### UI와 상태

- [ ] desktop actual/skeleton은 13 columns, 1,418px, 72px row, 동일 colgroup/header/scroll sync를 공유한다.
- [ ] mobile skeleton은 실제 최대 카드 레이아웃을 예약한다.
- [ ] loading/refreshing/success/dataset empty/filter 0/http/network/schema/config/render/abort가 구별된다.
- [ ] refreshing은 기존 데이터를 유지하고 initial loading만 skeleton이다.
- [ ] Error Boundary reset은 key 변경 + subtree remount 계약이다.
- [ ] partial dataset 경고와 사용자 retry 동작이 있다.

### nullable/접근성

- [ ] null age는 `—` + `나이 정보 없음`, age 정렬 null-last다.
- [ ] null/failed assets는 네트워크 placeholder 없이 local neutral fallback이다.
- [ ] null nation은 이미지 요청과 가짜 검색 token이 없다.
- [ ] 로딩 status/live region은 하나, skeleton은 aria-hidden/focus 불가다.
- [ ] reduced motion에서 shimmer/spinner animation은 `none`이다.

### 운영/회귀

- [ ] abort가 retry timer까지 취소하고 stale/StrictMode 응답이 상태를 덮지 않는다.
- [ ] 자동 retry는 지정된 network/status에만 총 3 attempts 이하다.
- [ ] staging base URL은 HTTPS, CORS는 exact allowlist, hostile 유사 origin은 실패한다.
- [ ] production source와 dist에 sample/placeholder/old metrics/hardcode가 0건이다.
- [ ] unit/component/integration/backend CORS/actual contract test와 build가 모두 통과한다.
