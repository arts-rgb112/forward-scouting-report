# M.E.S.S.I. 2.0 프론트엔드 컴포넌트 설계

## 1. 설계 결정 요약

이 문서는 `frontend-spec.md`의 P0/P1을 현재 React + Tailwind 프로토타입에 적용하기 위한 구현 설계다. 기존의 다크 배경, 제한된 네온 그린 포인트, 72px 데스크톱 행, 숫자 중심의 고밀도 표현은 유지한다. 화면 구조나 사용자 플로우를 새로 만들지 않고 다음 경계를 명확히 한다.

- 루트 컴포넌트는 화면 상태와 사용자 명령만 소유한다.
- 선수 데이터, 지표 메타데이터, 점수 구간, 저장소 접근, 검색/정렬 로직은 UI 밖으로 이동한다.
- 데스크톱 테이블과 모바일 카드는 동일한 `Player` 계약과 동일한 이벤트 계약을 사용한다.
- 비교 상태는 reducer로 관리해 `선택 인원 < 2 ⇒ 상세 패널 닫힘`을 원자적으로 보장한다.
- 모든 외부 이미지는 고정 크기 wrapper 안에서 성공 이미지 또는 타입별 fallback 중 하나를 렌더링한다.
- 모바일 카드의 기본 밀도는 유지하되 접을 수 있는 추가 지표 영역으로 5개 지표 모두에 접근하게 한다.
- P2(API, URL 상태, 계정 저장, 라우팅)는 이번 구현에 포함하지 않는다.

명세와 충돌하는 결정이나 사용자 승인이 필요한 범위 변경은 없다. 61~69점은 명세대로 빨간 구간에 포함한다.

## 2. 목표 파일 구조

```text
MessiScoutingDashboard.tsx            # 기존 import 호환용 thin re-export
src/
  main.tsx
  index.css
  dashboard/
    MessiScoutingDashboard.tsx        # 상태 소유자와 페이지 조합
    types.ts                           # Player, MetricKey, Tier, SortKey
    scoutingConfig.ts                  # metric, tier, score band 단일 설정
    samplePlayers.ts                   # 현재 샘플 데이터
    playerQuery.ts                     # 정규화, role 파생, 필터/정렬 순수 함수
    comparisonState.ts                 # 비교 reducer와 불변식
    watchlistStorage.ts                # 안전한 parse/read/write 순수 경계
    components/
      AssetImage.tsx                   # 이미지 + 타입별 fallback
      MetricScore.tsx                  # 점수 표시 + portal tooltip
      PlayerIdentity.tsx               # 페이스온과 micro asset/role
      DashboardToolbar.tsx             # 검색, 포지션, 관심, 정렬, 활성 칩
      ScoreLegend.tsx                  # scoreBands/tierConfig 기반 범례
      PlayerTable.tsx                  # md 이상 테이블
      PlayerCardList.tsx               # md 미만 카드와 전체 지표 disclosure
      EmptyState.tsx
      CompareTray.tsx                  # 고정 트레이 + 상세 비교표
      StatusFeedback.tsx               # 단일 live region 겸 toast
  dashboard/__tests__/
    playerQuery.test.ts
    scoutingConfig.test.ts
    comparisonState.test.ts
    watchlistStorage.test.ts
```

`MessiScoutingDashboard.tsx`는 `src/dashboard/MessiScoutingDashboard.tsx`의 default export만 다시 내보내 기존 진입점과 외부 참조를 깨뜨리지 않는다. `src/main.tsx`는 최종적으로 `src/dashboard` 구현을 직접 import해도 되지만 한 번에 하나의 경로만 사용한다. Tailwind의 `@source "./**/*.{ts,tsx}"`가 새 파일을 이미 포함하므로 별도 safelist는 필요 없다. 단, 점수 색상 class는 런타임 문자열 조합이 아니라 `scoutingConfig.ts`에 완성된 정적 문자열로 둔다.

## 3. 도메인 및 데이터 계약

### 3.1 공개 타입

```ts
export type Tier = "diamond" | "gold" | "silver";
export type SortKey = "score" | "name" | "age";
export type MetricKey =
  | "boxThreat"
  | "dangerZone"
  | "linkPlay"
  | "pressing"
  | "progression";

export type AssetRef = Readonly<{
  name: string;
  icon: string;
}>;

export type Player = Readonly<{
  id: number;
  name: string;
  role: string;
  age: number;
  minutes: number;
  tier: Tier;
  score: number;
  face: string;
  nation: AssetRef;
  league: AssetRef;
  club: AssetRef;
  stats: Readonly<Record<MetricKey, number>>;
}>;
```

루트 컴포넌트 계약:

```ts
export type MessiScoutingDashboardProps = {
  players?: readonly Player[];
};

export default function MessiScoutingDashboard({
  players = samplePlayers,
}: MessiScoutingDashboardProps): JSX.Element;
```

샘플 데이터를 기본값으로 제공해 현재 실행 경험을 유지하면서 실제 데이터 연결 시 `players` prop으로 주입할 수 있게 한다. 컴포넌트는 입력 배열을 mutate하지 않으며 정렬 전 반드시 복사한다. 빈 배열은 오류가 아닌 정상적인 empty dataset으로 처리한다.

### 3.2 점수 및 지표 단일 설정

`scoutingConfig.ts`만 임계값, 라벨, 범례, class를 소유한다.

```ts
export const scoreBands = [
  { min: 90, max: 100, label: "엘리트", rangeLabel: "90–100", className: "..." },
  { min: 80, max: 89,  label: "우수",   rangeLabel: "80–89",  className: "..." },
  { min: 70, max: 79,  label: "보통",   rangeLabel: "70–79",  className: "..." },
  { min: 0,  max: 69,  label: "보완",   rangeLabel: "0–69",   className: "..." },
] as const;

export function getScoreBand(score: number): ScoreBand;
```

`getScoreBand`는 유한 숫자를 전제로 하되 방어적으로 `NaN`/무한대는 보완 구간을 반환한다. `MetricScore`와 `ScoreLegend`는 모두 이 설정을 소비한다. 색상 hex, 구간 라벨, tooltip 상태 라벨을 다른 파일에 복제하지 않는다. `metricConfig: Record<MetricKey, {label; short; detail}>`, `metricKeys`, `tierConfig`도 같은 파일에서 export한다.

## 4. 컴포넌트 아키텍처와 props 계약

### 4.1 페이지 조합

```text
MessiScoutingDashboard
├─ HeaderSummary
├─ DashboardToolbar
├─ ScoreLegend
├─ PlayerCardList (mobile)
├─ PlayerTable (md+)
├─ EmptyState
├─ CompareTray
└─ StatusFeedback
```

`HeaderSummary`는 재사용 요구가 없으므로 처음에는 루트 파일 내부의 작은 표현 컴포넌트로 둘 수 있다. 나머지는 상태 또는 반복 렌더링 책임이 커 별도 파일로 분리한다.

### 4.2 DashboardToolbar

```ts
type DashboardToolbarProps = {
  query: string;
  role: string;
  sort: SortKey;
  watchOnly: boolean;
  watchCount: number;
  positions: readonly string[];
  resultCount: number;
  hasFilters: boolean;
  onQueryChange(value: string): void;
  onRoleChange(value: string): void;
  onSortChange(value: SortKey): void;
  onWatchOnlyChange(value: boolean): void;
  onReset(): void;
};
```

검색 입력은 controlled input이다. 입력 즉시 `onQueryChange`를 호출한다. 활성 칩은 각각 해당 상태만 기본값으로 되돌리고, 전체 초기화는 네 가지 탐색 상태를 동시에 초기화한다. 검색, role, watchOnly는 AND로 결합한다. 포지션 버튼과 관심선수 버튼은 `aria-pressed`를 유지한다.

### 4.3 PlayerTable / PlayerCardList

두 목록은 동일한 액션 계약을 공유한다.

```ts
type PlayerListProps = {
  players: readonly Player[];
  comparedIds: ReadonlySet<number>;
  watchedIds: ReadonlySet<number>;
  onToggleCompare(player: Player): void;
  onToggleWatch(player: Player): void;
};
```

부모에서 `Set`을 `useMemo`로 한 번 생성해 행마다 `Array.includes`를 반복하지 않는다. key는 항상 `player.id`다. 테이블의 caption, `scope="col"`, `scope="row"`를 유지한다. 행 자체를 클릭 가능한 요소로 만들지 않으며 compare/watch 버튼만 액션을 수행해 키보드와 포인터 의미를 일치시킨다.

모바일 카드는 기본으로 박스 타격·위험 구역·연계 3개를 보여주고, `MobileMetricPanel`의 “추가 지표 2개 보기” 버튼으로 압박·전진을 펼친다. 펼친 뒤에는 버튼 라벨을 “추가 지표 접기”로 바꾼다. 선수별 로컬 boolean 상태를 사용하고 다음 ID 계약을 따른다.

- 버튼: `aria-expanded`, `aria-controls="mobile-extra-metrics-{playerId}"`
- 패널: `id="mobile-extra-metrics-{playerId}"`
- 최소 터치 영역: 44×44px

이 방식은 기본 카드 밀도를 유지하면서 상세 비교를 열지 않아도 5개 지표 모두에 접근하게 한다.

### 4.4 PlayerIdentity / AssetImage

```ts
type AssetKind = "face" | "nation" | "league" | "club" | "tier";

type AssetImageProps = {
  src: string;
  alt: string;
  kind: AssetKind;
  fallbackLabel: string;
  className?: string;
  width: number;
  height: number;
  loading?: "eager" | "lazy";
};
```

`AssetImage`는 `src`가 바뀌면 실패 상태를 초기화하고, 빈 URL 또는 `onError` 발생 시 같은 width/height의 fallback을 렌더링한다. 성공 이미지에는 `width`, `height`, `loading`, `decoding="async"`를 부여한다. 무한 `onError` 반복을 막기 위해 실패 뒤 `<img>`를 제거한다.

fallback 표현:

| kind | 크기 유지 | fallback |
|---|---|---|
| face | 48×48 table, 56×56 mobile | 어두운 인물 silhouette 또는 선수 이니셜 2자 |
| nation | 20×16 | 국가명의 대문자 2자 |
| league/club | 16×16 | 중립 원형/방패 + 이름 첫 글자 |
| tier | 32×32 table, 16×16 legend | diamond `◆`, gold/silver `●`와 티어 색상 |

fallback은 중립 배경, 1px border, 현재 크기와 radius를 유지한다. 페이스온과 티어는 의미 있는 `alt`를 사용한다. 마이크로 에셋 묶음은 이미지 자체를 `alt=""`로 두고 `PlayerIdentity` 안에 `sr-only` 텍스트 “국가 {nation}, 리그 {league}, 클럽 {club}, 포지션 {role}”를 한 번 제공해 반복 낭독을 줄인다. `title`은 보조 시각 힌트일 뿐 접근 가능한 이름으로 의존하지 않는다.

### 4.5 MetricScore와 tooltip

```ts
type MetricScoreProps = {
  playerId: number;
  metric: MetricKey;
  value: number;
  surface: "table" | "mobile";
  compact?: boolean;
};
```

tooltip ID는 `metric-tooltip-{surface}-{playerId}-{metric}`이다. 점수가 같은 서로 다른 선수에서도 절대 중복되지 않는다. trigger는 `tabIndex={0}`과 `aria-describedby`를 가진다.

현재 tooltip은 overflow container 내부의 absolute 요소라 잘릴 수 있으므로 `createPortal(..., document.body)` 기반 고정 레이어로 바꾼다. hover/focus에서 trigger의 `getBoundingClientRect()`를 읽고 아래 규칙으로 위치를 계산한다.

- 기본: trigger 위 중앙, 8px 간격
- 위 공간 부족: trigger 아래
- 좌우: viewport 8px margin 안으로 clamp
- scroll/resize 또는 Escape: 닫기
- `pointer-events: none`; 정보 확인에 hover 유지가 필요하지 않게 trigger focus에서도 열린 상태 유지

설명 DOM은 열린 동안 portal에 존재하고 `role="tooltip"`을 가진다. 스크린리더 연결이 tooltip 표시 상태에 의존하지 않도록 trigger의 접근 가능한 이름에는 “{지표명} {값}점”을 제공하거나 동일 설명을 보이지 않는 설명 요소로 항상 유지한다. 구현 복잡도를 줄일 경우 portal의 시각 tooltip과 상시 `sr-only` 설명을 분리해도 되지만 ID는 trigger당 하나만 참조한다.

### 4.6 CompareTray

```ts
type CompareTrayProps = {
  players: readonly Player[];
  open: boolean;
  onRemove(playerId: number): void;
  onClear(): void;
  onOpenChange(open: boolean): void;
};
```

트레이는 `players.length > 0`일 때만 mount한다. 상세 버튼은 2명 미만일 때 disabled다. 다음 ID/ARIA 계약을 지킨다.

- aside: `aria-label="선수 비교 트레이"`
- 상세 토글: `aria-expanded={open}`, `aria-controls="compare-details"`
- 상세 영역: `id="compare-details"`; 닫혔을 때 unmount 가능
- 개별 제거 버튼: `aria-label="{선수명} 비교에서 제거"`
- 상세 비교표: caption, 열/행 scope 유지

320px에서 선수 칩과 액션이 서로 밀어내지 않도록 모바일은 두 행 구조를 쓴다. 첫 행은 제목/인원과 가로 스크롤 칩, 둘째 행은 “모두 지우기”와 “상세 비교” 버튼이다. `sm` 이상에서 현재의 한 행 구조로 복귀한다. 선택 칩 이미지는 `AssetImage`를 재사용한다.

### 4.7 StatusFeedback

```ts
type StatusFeedbackProps = { message: string };
```

하나의 persistent `aria-live="polite" aria-atomic="true"` region만 둔다. 메시지가 있을 때 같은 region을 시각적 toast로 표시하고, 별도의 `role="status"` 복제 노드는 만들지 않는다. 메시지는 2.2초 뒤 부모가 비운다. 비교 5번째 거부, 관심선수 추가/제거를 이 경로로 전달한다.

## 5. 상태 소유권과 파생 상태

### 5.1 루트가 소유하는 상태

```ts
query: string
role: string
sort: SortKey
watchOnly: boolean
watchlistIds: number[]
comparison: { ids: number[]; open: boolean }
feedback: string
```

`DashboardToolbar`과 목록 컴포넌트는 제어 상태를 소유하지 않는다. 모바일 카드의 추가 지표 열림만 선수 카드 로컬 UI 상태로 허용한다.

### 5.2 저장하지 않는 파생 상태

- `positions = derivePositions(players)`
- `filteredPlayers = filterAndSortPlayers(players, {query, role, sort, watchOnly, watchlistIds})`
- `watchedIds = new Set(watchlistIds)`
- `comparedIds = new Set(comparison.ids)`
- `comparedPlayers = comparison.ids` 순서로 player map에서 조회
- `hasFilters = query !== "" || role !== "ALL" || watchOnly || sort !== "score"`

위 값은 `useMemo`로 계산한다. `playerById` Map을 한 번 생성해 비교 선수 해석을 O(n×m) `find` 반복에서 O(n+m)으로 바꾼다. 데이터에서 삭제된 compare/watch ID는 players 변경 시 정리한다.

### 5.3 비교 reducer

```ts
type ComparisonState = { ids: number[]; open: boolean };
type ComparisonAction =
  | { type: "toggle"; id: number }
  | { type: "remove"; id: number }
  | { type: "clear" }
  | { type: "set-open"; open: boolean }
  | { type: "reconcile"; validIds: ReadonlySet<number> };
```

reducer 불변식:

- `ids`는 입력 순서 유지, 중복 없음, 최대 4명.
- 제거/정리 후 `ids.length < 2`이면 항상 `open: false`.
- `set-open(true)`는 2명 이상일 때만 반영.
- `clear`는 `{ids: [], open: false}`.
- 5번째 선택은 reducer에 보내지 않고 handler가 현재 길이를 확인해 feedback만 갱신한다. 동시 이벤트 안전성을 위해 구현 시 reducer도 4명 제한을 재검증한다.

### 5.4 관심선수 저장 경계

`watchlistStorage.ts`는 `WATCHLIST_KEY = "messi-2-watchlist"`와 아래 순수/안전 함수를 제공한다.

```ts
parseWatchlist(raw: string | null, validIds: ReadonlySet<number>): number[]
readWatchlist(validIds: ReadonlySet<number>): number[]
writeWatchlist(ids: readonly number[]): boolean
```

parse는 JSON 배열, 유한 정수, 유효 ID만 허용하고 Set으로 중복 제거한다. read/write는 `window`와 storage 접근을 try/catch로 감싸 실패해도 앱 상태를 반환/유지한다. 루트는 mount 복원 완료 전 빈 배열을 storage에 덮어쓰지 않도록 `watchReady` 또는 lazy initializer 중 한 방식을 일관되게 사용한다. `players` prop이 바뀌면 유효하지 않은 ID를 제거한다.

## 6. 검색·필터·비교·관심선수 interaction

### 검색 및 필터

1. `normalizeText`는 NFD 분해 후 combining mark 제거, locale lowercase, trim을 수행한다.
2. 선수명·클럽·리그·국가를 하나의 정규화 haystack으로 결합한다.
3. role은 `/`로 분해하고 각 토큰을 trim해 정확히 일치시킨다.
4. query, role, watchOnly를 AND 적용한 뒤 새 배열을 정렬한다.
5. query 지우기는 query만, 활성 칩은 해당 조건만, 전체 초기화는 query/role/sort/watchOnly를 초기화한다. watchlist와 compare는 초기화하지 않는다.

### 비교

1. 행/카드 선택 → reducer `toggle` → 트레이와 원본 버튼의 `aria-pressed`가 같은 Set을 참조한다.
2. 1명일 때 트레이는 보이되 상세 버튼은 disabled이며 “한 명 더 선택하세요”가 표시된다.
3. 2~4명일 때 상세 토글 가능.
4. 4명 상태에서 미선택 선수를 누르면 상태 변화 없이 live feedback.
5. 제거로 1명 이하가 되면 reducer가 상세 패널을 즉시 닫는다.

### 관심선수

1. 버튼 토글 즉시 메모리 상태와 `aria-pressed` 갱신.
2. 저장소 write는 effect에서 시도하며 실패해도 현재 세션 상태 유지.
3. 성공/제거 문구를 single live region에 전달. 저장소 write 실패를 사용자에게 과도하게 반복하지 않되 최초 실패 시 “현재 세션에만 저장됩니다” 안내를 선택적으로 제공한다.
4. 관심선수만 보기 + 0명은 일반 empty state와 동일하게 복구 가능하며 전체 초기화가 watchOnly를 끈다.

## 7. 접근성 ID와 ARIA 계약

| 대상 | 계약 |
|---|---|
| 검색 section | `aria-labelledby="player-search-heading"`, 숨김 heading에 해당 ID |
| 검색 input | visible label 또는 sr-only label; clear 버튼은 `aria-label="검색어 지우기"` |
| 결과 수 | `aria-live`로 매 키 입력을 과도하게 읽지 않도록 일반 텍스트 유지; 필요 시 `aria-atomic` 없는 status 사용 금지 |
| 포지션/관심 토글 | `aria-pressed` |
| metric trigger | `aria-describedby="metric-tooltip-{surface}-{playerId}-{metric}"` |
| 모바일 추가 지표 | `aria-expanded`, `aria-controls="mobile-extra-metrics-{playerId}"` |
| compare toggle | `aria-expanded`, `aria-controls="compare-details"` |
| compare details | `id="compare-details"` |
| icon-only actions | 선수명 + 동작을 포함한 `aria-label` |
| feedback | 단일 `aria-live="polite" aria-atomic="true"` |
| table | caption, `scope="col"`, 선수명 셀 `scope="row"` |

focus ring은 현재 네온 색을 유지하며 `focus-visible`에서 최소 2px 대비가 보이게 한다. 행 hover 스타일은 `:hover`에만 두고 실제 버튼/지표 focus는 독립 ring으로 구분한다. 필수 정보는 hover에만 의존하지 않는다.

## 8. reduced-motion 설계

`src/index.css`에 전역 fallback을 추가한다.

```css
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
    transition-duration: 0.01ms !important;
  }
}
```

페이스온 hover 확대는 `motion-safe:transition motion-safe:group-hover:scale-105`로 한정한다. toast나 compare panel에 새 슬라이드 animation을 추가하지 않는다. reduced-motion에서도 색상과 focus 상태 변화는 즉시 보여야 한다.

## 9. 파일별 구현 변경 목록

1. `src/dashboard/types.ts`
   - 현재 root 파일의 type을 export 가능한 명시 타입으로 이동.
2. `src/dashboard/scoutingConfig.ts`
   - `scoreBands`, `getScoreBand`, `metricConfig`, `metricKeys`, `tierConfig` 이동 및 중앙화.
3. `src/dashboard/samplePlayers.ts`
   - 샘플 배열 이동, UTF-8 선수명 리터럴 보존.
4. `src/dashboard/playerQuery.ts`
   - normalize/position/filter/sort를 순수 함수로 분리하고 입력 배열을 mutate하지 않음.
5. `src/dashboard/comparisonState.ts`
   - reducer 및 최대 4명/자동 닫힘 불변식 구현.
6. `src/dashboard/watchlistStorage.ts`
   - 손상 JSON, 중복, 무효 ID, storage 예외 방어.
7. `src/dashboard/components/AssetImage.tsx`
   - fixed dimensions, lazy/async, 실패 fallback, src 변경 reset.
8. `src/dashboard/components/MetricScore.tsx`
   - player 기반 고유 ID, keyboard/hover tooltip, portal collision 처리, score band 소비.
9. `src/dashboard/components/PlayerIdentity.tsx`
   - face/micro assets/role의 공통 렌더링과 접근성 텍스트.
10. `DashboardToolbar.tsx`, `ScoreLegend.tsx`, `EmptyState.tsx`
    - 현재 UI를 그대로 책임 단위로 이동.
11. `PlayerTable.tsx`, `PlayerCardList.tsx`
    - 공통 list props 사용, mobile 추가 2지표 disclosure, 모든 이미지 공통 fallback 사용.
12. `CompareTray.tsx`
    - 두 행 모바일 레이아웃, ARIA 계약, 상세 표, fallback 적용.
13. `StatusFeedback.tsx`
    - 시각 toast와 스크린리더 알림을 한 region으로 통합.
14. `src/dashboard/MessiScoutingDashboard.tsx`
    - 상태/reducer, memoized 파생값, handlers, 페이지 조합만 유지.
15. root `MessiScoutingDashboard.tsx`
    - 호환용 re-export로 축소.
16. `src/index.css`
    - reduced-motion 규칙 추가. 필요 시 portal tooltip root의 z-index만 추가.
17. `package.json`
    - 순수 로직 회귀 테스트를 위한 `test` script와 Vitest dev dependency 추가. DOM 상호작용 검증까지 수행하면 Testing Library + jsdom을 함께 추가.

## 10. 검증 전략과 체크리스트

### 자동 검증 최소 범위

- `playerQuery.test.ts`
  - `Mbappe` → `Kylian Mbappé`; `Gyokeres` → `Gyökeres`.
  - club/league/nation 검색.
  - query + role + watchOnly AND 조합.
  - score 정렬이 입력 배열을 mutate하지 않음.
- `scoutingConfig.test.ts`
  - 경계값 100, 90, 89, 80, 79, 70, 69, 0 및 비정상 숫자.
- `comparisonState.test.ts`
  - 중복 선택 없음, 순서 유지, 최대 4명.
  - 2명 열린 상태에서 1명 제거 시 `open === false`.
  - clear와 reconcile.
- `watchlistStorage.test.ts`
  - 손상 JSON, 배열 아닌 JSON, 중복 ID, 문자열 ID, 사라진 ID 필터.

### 브라우저 QA

- [ ] 브라우저에서 한국어와 `Mbappé`, `Gyökeres`, `Martínez`, `Šeško`, `Giménez`가 정확히 렌더링된다.
- [ ] 각 종류의 URL을 의도적으로 실패시켜 face/nation/league/club/tier fallback과 행/카드 높이를 확인한다.
- [ ] hover와 Tab focus 모두에서 tooltip이 열리며 가로 스크롤 container와 viewport 가장자리에서 잘리지 않는다.
- [ ] 1명 비교 시 상세 disabled, 2명에서 enabled, 4명 후 5번째 거부 알림, 2명에서 1명으로 감소 시 패널 자동 닫힘을 확인한다.
- [ ] 관심선수 저장 후 새로고침 복원, 손상 localStorage에서 정상 렌더링, 저장소 접근 예외 시 세션 동작을 확인한다.
- [ ] 320px에서 카드 5개 지표와 compare tray 두 액션이 페이지 가로 overflow 없이 사용 가능하다.
- [ ] `md` 이상에서 sticky header/선수 열, 긴 선수명, 가로 스크롤을 확인한다.
- [ ] 200% 확대와 키보드 전용으로 검색→필터→카드/행 액션→비교 트레이→상세 닫기 흐름을 완료한다.
- [ ] OS reduced-motion 설정에서 face 확대와 긴 transition이 제거된다.
- [ ] visible toast가 한 번만 낭독되고 compare toggle의 expanded 상태가 실제 panel과 일치한다.
- [ ] 브라우저 콘솔에 duplicate ID, React key, runtime 오류가 없다.
- [ ] `pnpm test`와 `pnpm build`가 성공한다.

## 11. 구현 우선순위

1. type/config/data/순수 상태 로직 분리와 테스트.
2. `AssetImage` fallback 및 모든 이미지 교체.
3. 비교 reducer와 ARIA 상태 일치.
4. table/card/toolbar/compare 컴포넌트 분리.
5. 모바일 추가 지표와 compare tray 320px 보정.
6. portal tooltip 고유 ID 및 clipping 해결.
7. single live region, reduced-motion, 최종 브라우저 QA.

이 순서를 따르면 각 단계 뒤 `pnpm test`/`pnpm build`로 회귀를 좁힐 수 있고, 마지막 단계에서만 화면 조합을 크게 건드리는 위험을 줄일 수 있다.
