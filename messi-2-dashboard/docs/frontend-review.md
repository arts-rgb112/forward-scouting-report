# M.E.S.S.I. 2.0 프론트엔드 품질 리뷰

검토 범위: `docs/frontend-spec.md`, `docs/frontend-design.md`, `src/dashboard/**`, 루트 re-export, Tailwind/Vite/TypeScript/Vitest 설정.

## Findings

### P0

없음. 검색·필터·비교·관심선수의 핵심 상태를 손상시키거나 초기 화면을 즉시 사용할 수 없게 만드는 차단 결함은 정적 검토에서 발견하지 못했다.

### P1-1 — 데스크톱 sticky 헤더가 페이지 세로 스크롤에서 고정되지 않을 가능성이 높음

- 근거: `src/dashboard/components/PlayerTable.tsx:11`
- 바깥 `section`이 `overflow-hidden`, 바로 안쪽 컨테이너가 `overflow-x-auto`이고 `thead`는 `sticky top-0`이다. CSS sticky는 가장 가까운 overflow 조상에 구속된다. 두 조상 모두 세로 스크롤 컨테이너로 실제 스크롤되지 않으므로, 긴 선수 목록에서 문서 자체를 세로 스크롤할 때 헤더가 viewport 상단에 붙지 않는다.
- 영향: 스펙 F-01 및 데스크톱 수용 기준의 “스크롤 중 헤더 맥락 유지”를 충족하지 못한다. 샘플 8명보다 실제 선수 풀이 커질수록 지표 열의 의미를 잃기 쉽다.
- 재현:
  1. 데스크톱 너비에서 선수 행을 viewport 높이보다 충분히 많이 전달한다.
  2. 테이블 중간까지 페이지를 세로 스크롤한다.
  3. `thead`가 viewport 상단에 유지되는지 확인한다.
- 수정 제안: 세로 방향에서는 sticky 조상을 만들지 않도록 바깥 `overflow-hidden`을 시각적 clip 대안으로 바꾸고, 가로 스크롤 래퍼의 overflow 축을 재설계한다. 또는 테이블 영역에 명시적인 `max-height` + `overflow-auto`를 부여해 해당 컨테이너 안에서 헤더가 고정되도록 UX를 명확히 한다. 수정 후 페이지 스크롤·테이블 내부 스크롤 양쪽을 브라우저에서 검증한다.

### P1-2 — 핵심 사용자 흐름과 회귀 위험이 큰 UI 경계에 자동 테스트가 없음

- 근거: `src/dashboard/*.test.ts` 네 파일은 순수 함수/reducer/파서만 검사한다. `package.json:10`의 테스트 명령에도 DOM 환경이나 Testing Library가 없다.
- 누락된 고위험 동작:
  - 검색 입력 → 결과 목록 갱신 → 개별/전체 초기화
  - 관심선수 토글 → `localStorage` 저장 → 재마운트 복원, storage read/write 예외
  - 비교 1명/2명/4명 상태에서 트레이, disabled, `aria-expanded`, 자동 닫힘의 DOM 일치
  - `AssetImage`의 face/nation/league/club/tier 실패 fallback
  - `MetricScore`의 hover/focus/Escape, portal mount/unmount, 고유 ID 및 viewport clamp
  - 320px에서 모바일 카드만, `md` 이상에서 테이블만 노출되는 회귀
- 영향: 현재 분리 구조와 순수 상태 로직은 좋지만, 실제 수용 기준 대부분이 컴포넌트 조합에 걸쳐 있어 단위 테스트 통과만으로 품질을 보장할 수 없다.
- 수정 제안: Vitest + jsdom + Testing Library로 최소 통합 테스트를 추가하고, responsive/sticky/tooltip collision은 Playwright viewport 테스트로 보완한다. 특히 4명 제한과 1명으로 감소 시 상세 패널 닫힘을 DOM 기준으로 검증한다.

### P2-1 — 장식용 마이크로 에셋이 실패하면 이름 없는 `img` 역할로 접근성 트리에 다시 노출됨

- 근거: `src/dashboard/components/AssetImage.tsx:9-13`, `src/dashboard/components/PlayerIdentity.tsx:9-13`, `src/dashboard/components/ScoreLegend.tsx:6`
- 성공한 국기·리그·클럽 이미지는 `alt=""`라 장식용으로 숨겨진다. 그러나 실패 시 fallback은 무조건 `<span role="img" aria-label={alt}>`를 반환한다. 이때 빈 `alt`가 빈 `aria-label`이 되어 이름 없는 그래픽 3개가 노출될 수 있고, 바로 뒤 `sr-only` 설명과 중복/잡음을 만든다.
- 재현:
  1. 국기·리그·클럽 URL을 실패 URL로 바꾼다.
  2. 접근성 트리에서 선수 프로필을 확인한다.
  3. 의미 없는 graphic 노드와 이어지는 통합 설명을 확인한다.
- 수정 제안: `alt === ""`인 fallback에는 `aria-hidden="true"`를 적용하고 `role`/`aria-label`을 생략한다. 의미 있는 face/tier fallback만 `role="img"`와 이름을 유지한다. 이 분기를 컴포넌트 테스트로 고정한다.

### P2-2 — tooltip의 세로 collision 계산이 실제 tooltip 높이와 viewport 하단을 반영하지 않음

- 근거: `src/dashboard/components/MetricScore.tsx:16-23`
- 가로 위치는 224px 너비와 8px 여백으로 clamp하지만, 세로 위치는 고정 104px 높이를 가정한다. 아래 배치 시 viewport 하단 clamp가 없고, 번역·폰트·200% 확대 등으로 실제 높이가 달라질 때 상단 또는 하단에서 일부가 잘릴 수 있다.
- 재현: 낮은 viewport 또는 200% 확대에서 화면 하단 가까운 모바일 지표에 키보드 focus를 둔다.
- 수정 제안: portal tooltip ref로 실제 `getBoundingClientRect()`를 측정한 뒤 상·하 가용 공간을 비교하고 `8px..viewportHeight-height-8px`로 clamp한다. resize/scroll 시 같은 계산을 사용한다.

### P2-3 — 여러 동작 버튼에 `type="button"`이 없어 재사용 시 암묵적 submit 위험이 있음

- 근거: `src/dashboard/components/CompareTray.tsx:9`, `DashboardToolbar.tsx:8`의 활성 필터 칩, `EmptyState.tsx:2`, `PlayerCardList.tsx:13`, `PlayerTable.tsx:11`
- 현재 standalone 화면에는 `<form>`이 없어 즉시 발생하지 않지만, 대시보드를 검색 form 또는 상위 애플리케이션 form 안에 합성하면 기본 `submit` 버튼으로 동작할 수 있다.
- 수정 제안: submit 의도가 없는 모든 버튼에 명시적으로 `type="button"`을 추가한다.

### P2-4 — 외부 `players` 데이터의 런타임 오류 경계가 없음

- 근거: `src/dashboard/MessiScoutingDashboard.tsx:15-18`, `PlayerTable.tsx:11`, `PlayerCardList.tsx:13`
- props 주입 경계는 마련됐지만 데이터는 TypeScript 타입만 신뢰한다. API에서 잘못된 `tier`, 누락된 asset/stat, 숫자가 아닌 score가 들어오면 `tierConfig[player.tier].src` 또는 `score.toFixed(1)`에서 전체 화면이 중단될 수 있다.
- 영향: 샘플 데이터 단계에서는 낮지만, 다음 단계인 실제 선수 API 연결 시 안정성 요구와 충돌한다.
- 수정 제안: API adapter에서 schema 검증/정규화 후 안전한 `Player[]`만 전달하고, 목록 영역에는 오류 상태를 둔다. 이 작업은 실제 데이터 계약이 확정될 때 진행해도 된다.

## 요구사항 및 상태 정확성 검토

다음 항목은 구현이 스펙/설계와 일치한다.

- 검색: `normalize("NFD")` + combining mark 제거로 `Mbappe`/`Gyokeres`가 악센트 포함 이름과 일치한다. 선수·클럽·리그·국가가 하나의 haystack에 포함된다 (`playerQuery.ts:3-18`).
- 필터/정렬: query + role + watchOnly가 AND로 결합되고, 정렬은 복사된 filter 결과에 적용되어 입력 배열을 변경하지 않는다 (`playerQuery.ts:11-18`).
- 상태 초기화: 전체 초기화는 query/role/sort/watchOnly만 기본값으로 되돌리고 watchlist/compare는 보존한다 (`MessiScoutingDashboard.tsx:37-39`).
- 비교: 순서 보존, 중복 방지, 최대 4명, 2명 미만에서 open 차단 및 자동 닫힘이 reducer에 집중돼 있다 (`comparisonState.ts:11-23`). 원본 행/카드와 트레이는 동일 ID Set을 사용한다.
- 관심선수: 잘못된 JSON·중복·문자열·사라진 ID를 방어하고 localStorage 접근 예외를 삼켜 현재 세션을 유지한다 (`watchlistStorage.ts:3-19`).
- 이미지 fallback: src 변경 시 실패 상태를 초기화하고, 실패한 `<img>`를 fallback element로 교체해 무한 onError 반복과 레이아웃 붕괴를 막는다 (`AssetImage.tsx:6-13`). 위 P2-1 접근성 예외는 남아 있다.
- tooltip: `createPortal(document.body)`, player/surface/metric/React ID 조합, hover/focus/Escape, scroll/resize 재배치를 제공한다 (`MetricScore.tsx:8-35`). 위 P2-2 세로 clamp만 보완이 필요하다.
- 반응형: `<md`는 5개 지표에 접근 가능한 카드와 44px 액션을, `md` 이상은 고밀도 테이블을 제공한다. 비교 상세 표는 자체 가로 스크롤 영역을 가진다.
- 접근성: 단일 `h1`/`main`, 검색 section heading, table caption/scope, 토글 `aria-pressed`, disclosure `aria-expanded`/`aria-controls`, 아이콘 버튼의 선수명 포함 label, 단일 polite live region, focus-visible ring, reduced-motion 규칙이 확인됐다.
- TypeScript/React: strict 모드, 안정적인 player ID key, memoized derived state/Set/Map, reducer 및 책임 단위 컴포넌트 분리가 양호하다. 루트 default re-export와 `Player` 타입 export도 정상이다.

## 테스트 및 빌드 재확인

- 독립 재실행 시도: `pnpm test; pnpm build`
- 결과: 리뷰 환경의 PATH에 `node` 실행 파일이 없어 두 명령 모두 `'node' is not recognized`로 시작 전에 중단됐다. 이는 테스트 실패 assertion이나 TypeScript/build 오류가 아니라 실행 런타임 부재다.
- 참고: `dist/index.html`, `dist/assets/index-DpV3ot7c.js`, `dist/assets/index-Kvnzk1Xs.css`가 구현 완료 시각(2026-08-10 12:43)에 생성돼 있어 직전 빌드 산출물은 존재한다. 다만 이번 리뷰에서 새로 성공한 빌드로 간주하지 않았다.
- 브라우저 QA: 인앱 브라우저 연결은 성공했지만 로컬 서버를 구동할 Node/Python runtime이 없었고 `file://` 직접 열기는 브라우저 보안 정책상 차단됐다. 따라서 데스크톱/320px 실제 렌더링, sticky 동작, 키보드 순회, tooltip collision, 콘솔 오류는 이번 리뷰에서 미검증 상태다.

## 테스트 보강 우선순위

1. P1-1 수정 후 데스크톱 긴 목록 sticky header 브라우저 테스트.
2. 검색/필터/초기화, 관심선수 persistence, 비교 1→2→4→1명의 통합 테스트.
3. 모든 asset kind fallback과 장식 이미지 접근성 테스트.
4. portal tooltip의 focus/Escape/scroll/resize/viewport collision 테스트.
5. 320px, `md`, 200% 확대, reduced-motion, Tab-only 수동/자동 접근성 QA.

## 승인 필요 사항

현재 발견 사항을 수정하는 데 별도 사용자 승인이나 제품 정책 결정이 필요한 항목은 없다. 실제 API 데이터 스키마·오류 상태 UX는 다음 데이터 연동 범위에서 계약 확정이 필요하지만, 현재 프론트엔드 프로토타입을 막는 이슈는 아니다.

## 재검증 결과

재검증일: 2026-08-10

### 결론

- **P0 잔여: 없음**
- **P1 잔여: 없음**
- 기존 P1 두 건 중 sticky 구조 문제는 해결됐고, 테스트 부재 문제는 핵심 reducer/DOM 경계 테스트 추가로 위험도가 충분히 낮아졌다. 아직 자동화되지 않은 브라우저 전용 검증은 아래 P2 잔여 항목으로 관리한다.

### 기존 finding 상태

| Finding | 상태 | 재검증 근거 |
|---|---|---|
| P1-1 데스크톱 sticky 헤더 | **Resolved** | `PlayerTable.tsx:21-23`에서 바깥 `overflow-hidden`을 제거하고, 문서 스크롤에 붙는 별도 sticky header와 가로 스크롤 body table을 분리했다. 동일 `colgroup`을 공유하며 body `onScroll`에서 header `scrollLeft`를 동기화한다. 의미론적 caption/header는 body table에 유지되고 복제 visual header는 `aria-hidden="true"`다. |
| P1-2 핵심 UI 자동 테스트 부재 | **Resolved with residual P2 coverage gap** | `components/dashboardComponents.test.tsx`와 jsdom/Testing Library 의존성이 추가됐다. asset fallback의 의미/장식 분기, 비교 1→2→1명 disabled·expanded·자동 닫힘, 모바일 추가 지표 disclosure를 DOM으로 검증한다. 기존 순수 테스트와 합쳐 29개가 통과한다. 검색 입력 조합, 실제 localStorage 재마운트, tooltip portal/collision, sticky/반응형 CSS는 아직 브라우저 자동화가 없다. |
| P2-1 장식용 asset fallback 접근성 | **Resolved** | `AssetImage.tsx:11-13`에서 빈 alt fallback은 `aria-hidden="true"`, 의미 있는 fallback만 `role="img"`와 이름을 갖는다. 두 분기가 테스트됐다. |
| P2-2 tooltip 세로 collision | **Resolved for specified 320px+ viewport; narrow zoom residual** | `MetricScore.tsx:17-31`에서 실제 tooltip 크기를 측정하고 위/아래 가용 공간을 비교하며 viewport 8px 안으로 top/left를 clamp한다. `useLayoutEffect`로 portal mount 후 paint 전 재배치한다. 다만 CSS viewport가 tooltip 고정 폭 224px보다 좁아지는 극단적 200% 확대에서는 가로 폭 자체를 줄이지 않아 우측 overflow 가능성이 남는다. |
| P2-3 암묵적 submit 버튼 | **Resolved** | `src/dashboard/**/*.tsx`를 PCRE로 재검색한 결과 `type` 없는 `<button>`은 0개다. |
| P2-4 외부 데이터 런타임 검증 | **Remaining / P2** | 데이터 adapter/schema validation은 이번 수정 범위에 포함되지 않았다. 샘플 및 TypeScript 계약에서는 문제없고, 실제 API 연결 전에 해결해야 한다. |

### 테스트 및 빌드 독립 재실행

번들 runtime을 PATH에 명시해 다음을 직접 재실행했다.

```text
Node: C:\Users\USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe
pnpm: C:\Users\USER\.cache\codex-runtimes\codex-primary-runtime\dependencies\bin\fallback\pnpm.cmd
```

- `pnpm test`: **5 files, 29 tests 모두 통과**
- `pnpm build`: **TypeScript project build 및 Vite production build 통과**
- 산출물: `dist/index.html`, CSS 29.03 kB, JS 222.55 kB
- 테스트/빌드 중 React warning, TypeScript error, assertion failure 없음.

### 남은 P2 및 회귀 가능성

1. **브라우저 전용 sticky/가로 동기화 검증**: 분리된 두 table은 동일 colgroup을 사용해 정적 구조상 정렬되지만, 실제 브라우저에서 긴 목록 세로 스크롤과 body 가로 스크롤을 동시에 수행하는 Playwright 회귀 테스트는 없다. zoom·스크롤바·폰트 렌더링 환경에서 header/body 열 정렬을 한 번 확인해야 한다.
2. **tooltip 극단적 확대 폭**: `w-56`은 224px 고정이다. 200% 확대 등으로 CSS viewport가 240px 미만이 되면 `left: 8px` clamp만으로 우측 overflow를 막을 수 없다. `max-width: calc(100vw - 16px)` 또는 responsive width를 추가하고 portal test를 권장한다.
3. **UI 흐름 자동화 잔여**: 순수 검색/storage 로직은 충분히 테스트되지만, 사용자가 검색창을 입력해 결과·빈 상태·초기화를 거치는 DOM 흐름과 관심선수 저장 후 재마운트 복원은 통합 테스트가 없다. 출시 전 smoke test로 추가하는 것이 안전하다.
4. **실데이터 경계**: 잘못된 tier/stat/score를 막는 runtime schema 및 목록 오류 상태는 실제 API 연동 전에 필요하다.

### 실제 브라우저 확인 상태

번들 Node로 preview 서버 기동을 시도했으나 재검증 시점에 인앱 브라우저 세션을 다시 확보할 수 없어 시각 QA는 수행하지 못했다. 따라서 위 sticky 열 정렬, 320px overflow, 200% 확대 tooltip은 코드·빌드·jsdom 기준 판정이며 실제 브라우저 확인 항목으로 남긴다. 이 제한은 P0/P1 구현 결함을 의미하지 않지만 배포 전 QA 체크리스트에서는 제외하면 안 된다.

### 승인 필요 사항

현재 남은 항목을 처리하는 데 즉시 필요한 사용자 승인은 없다. 실제 API schema와 오류 상태 문구는 데이터 연동 단계에서 제품 계약을 확정하면 된다.
