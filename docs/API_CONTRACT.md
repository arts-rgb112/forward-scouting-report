# API contract notes

## 진행 중인 작업

- 상태: 완료 — messi.my 백엔드 CORS/POST 허용 준비
- 작업 폴더: C:/Users/USER/Downloads/files/forward-scouting-report-agent-config
- 범위/코드: PR `#283` (`Allow messi.my dashboard origin`)가 main에 병합되었고 merge SHA는 `4ac7fb1b8e4f59feca467a7c6121040afd7bfdb8`이다. `https://messi.my`만 `DEFAULT_ORIGINS`와 보호 POST dashboard allowlist에 추가했다. 기존 canonical Vercel Origin은 롤백 경로로 유지했으며, immutable Preview 전용 `VERCEL_PREVIEW_ORIGIN_REGEX`는 변경하지 않았다. `www.messi.my`, 점수·기능 플래그·공유 계산 모듈은 변경하지 않았다.
- Render: `MESSI_CORS_ORIGINS`의 기존 Streamlit 및 canonical Vercel Origin을 보존한 채 `https://messi.my`만 추가했다. Render 수동 재배포 `dep-da6nltv10e5c73c9p9sg`는 commit `4ac7fb1`을 사용하며 live 상태다.
- 운영 CORS/POST 실측: `https://messi.my` GET, Watchlist POST, Metric Ranks POST preflight는 각각 200/exact ACAO `https://messi.my`였다. 유효 Watchlist Resolve(Harry Kane 2025/26 league scope 7)와 Metric Ranks POST는 새 Origin에서 모두 200/exact ACAO였다. 기존 `https://forward-scouting-report-6dn7-tau.vercel.app` GET preflight도 200/exact ACAO로 유지됐다. hostile `https://evil-example.com` Watchlist preflight는 403/no ACAO였고, `/api/v2/goal-mouth-baseline?unexpected=1`은 계속 422였다.
- 다음 단계: Vercel Domain에 `messi.my`를 연결하고 DNS/SSL이 완료되기 전에는 custom-domain URL 자체의 브라우저 QA를 수행할 수 없다. Vercel이 표시하는 DNS 레코드는 사용자 작업으로 남아 있다.

- 상태: 완료 — Production Goal-Mouth baseline 공개
- 작업: 사용자 승인에 따라 Production `VITE_GOAL_MOUTH_BASELINE_ENABLED` 한 값만 true로 변경하고 재배포·실측 QA를 수행했다. `VITE_FINAL_THIRD_SHOT_MAP_V3_ENABLED=true`과 `VITE_DUEL_PRESS_V2_ENABLED` 및 다른 모든 변수는 변경·삭제·재생성하지 않았다. 문제 시 코드 롤백 대신 이 baseline 값만 false로 복구 후 재배포한다.
- 담당: backend orchestrator / frontend handoff
- 시작: 2026-08-25 KST
- 변경/배포: Vercel Config `VITE_GOAL_MOUTH_BASELINE_ENABLED=true`의 적용 범위를 기존 Preview에서 **Production 및 Preview**로 확장했다. 값·타입(Config)·기존 Preview 범위는 유지했고 Development는 선택하지 않았다. Production 재배포 `3hfjNPPwYvCuajiZY9HyLT8ggM6d` (Ready, `https://forward-scouting-report-6dn7-10u31jpv9-messiflick.vercel.app`)는 main merge `bb8a29f18f9465c2613302ecacb9a812cf460aad`를 사용한다. V3와 Duel/Press V2 및 다른 모든 환경변수는 변경하지 않았다.
- Production QA 정정: canonical `/players/194165?season=2025%2F2026&mode=league&scope=7&competition=all&taxonomy=duel-press-v1`의 **cold 첫 방문**에서 `GET /api/v2/goal-mouth-baseline`은 200이지만 11,384ms가 걸렸고, baseline 셀은 처음 0개였다가 약 11초 뒤 50개가 정상 렌더됐다. 골대·선수 마커는 baseline과 비차단적으로 즉시 표시되어 공개 기능 자체는 정상이다. 같은 cold 방문에서 2021/22~2024/25 league/europe season-history 요청 7건은 504 Gateway Timeout으로 실패했으며, 이는 baseline과 무관한 기존 이력 조회 지연이다. 따라서 이전의 “console error/warning 0건”은 warm 상태의 좁은 QA 세션에만 해당하는 부정확한 표현으로 정정한다. 완료 뒤에는 baseline 50셀, endpoint 마커 90개(Goal 36/On target 30/Off target 24), off-frame 24개, V3 품질 모듈 `+4.43`/`117/118`/partial reason, baseline on/off(0↔50셀), 2× zoom/reset을 확인했다. `row5_column1` 61.8%·212 shots는 SVG 상단, `row3_column5` 12.4%·2,064 shots는 중간 높이여서 Z축 반전이 없다. scope=8은 baseline과 무관한 기존 `8-league dataset unavailable` 상태이므로 승인 URL의 scope=7로 검증했다.

- 상태: 완료 — main 병합됨
- 작업: API·점수·좌표 계산을 바꾸지 않고 V3 서버 품질값을 한국어 품질 모듈로 렌더했다. 3D all-in-one은 구현하지 않고 현 SVG/좌표 계약 위의 가능성만 설계 검토했다.
- 담당: backend orchestrator / frontend handoff
- 시작: 2026-08-25 KST
- 실측 정정: `VITE_FINAL_THIRD_SHOT_MAP_V3_ENABLED`의 Vercel Secret 값은 읽을 수 없지만, Production `/players/194165?season=2025%2F2026&mode=league&scope=8&competition=all&taxonomy=duel-press-v1`의 Goal-Mouth는 `data-shooting-quality`에 `Shooting quality partial: xGOT − xG 4.43 · 117/118 eligible shots`를 렌더하고 V3 transport를 사용한다. 따라서 Production V3는 **활성**으로 취급하며, 이 작업에서 V3/baseline Production 플래그·API·점수 계산은 변경 금지다. Preview 변수도 기존 Secret과 중복되어 저장하지 않았고 변경은 없다.
- Preview 실측: 기존 baseline-enabled Preview `https://forward-scouting-report-6dn7-r8qmjvkfp-messiflick.vercel.app`의 동일 QA URL도 V3 품질 문구 `4.43 · 117/118`와 baseline 50셀·Goal-Mouth 마커 90개를 함께 렌더한다. 따라서 별도 변수 삭제·재생성이나 Preview 재배포 없이 V3×기준선 통합 UI를 설계·검증할 수 있다.
- 로컬 결과: `GoalMouthView.tsx`의 영문 한 줄을 `골문 기준선 · 슈팅 품질` 모듈로 교체했다. 서버의 `shootingQuality` 값만 표시하며, +값 emerald, −값 rose, 0 slate, partial amber/서버 reason, unavailable 숫자·표본 비노출을 적용했다. 실데이터 194165/2025-26/league/scope8/`taxonomy=duel-press-v1`에서 `+4.43`, `117/118`, partial reason 및 Goal-Mouth 마커 90개를 확인했다. `FinalThirdShootingMap.test.tsx` 19/19 및 `pnpm build`가 통과했다(기존 500kB chunk-size 경고만). 로컬 서버 종료 뒤 5173/8000 리스너는 비어 있음을 확인했다. Production/Preview 플래그·API·점수 계산은 변경하지 않았다.
- PR/Preview: PR `#279` (`Integrate V3 shooting quality with Goal-Mouth baseline`), head `1d837d680ba3601b934601589f399ea9daaacf31`, Preview `https://forward-scouting-report-6dn7-el8eegqoa-messiflick.vercel.app`. QA URL의 Goal-Mouth에서 Korean module partial `+4.43`, `117/118`, 서버 reason, baseline 50셀, endpoint 마커 90개, endpoint-unavailable audit 28개를 확인했다. Goal 36 필터 및 2× zoom/reset 뒤에도 품질값이 유지되며 Preview 콘솔 error는 0건이다.
- main 병합: 사용자 승인에 따라 PR `#279`는 2026-08-25 07:51:55 UTC에 병합되었고 merge SHA는 `34cb08780a02cf8fe0ebf4d5460c10db8a41fff`이다. Production `VITE_GOAL_MOUTH_BASELINE_ENABLED`는 계속 false/fail-closed이며, Production `VITE_FINAL_THIRD_SHOT_MAP_V3_ENABLED`는 실동작으로 확인된 true 상태를 유지한다. 두 환경변수 모두 이번 병합에서 변경하지 않았다.

- 상태: main 병합 완료 — Production baseline 활성화는 별도 사용자 승인 대기
- 작업: Goal-Mouth 핫/콜드존 기준표(전역 10×5 득점 확률 baseline)와 선수 슈팅맵 오버레이
- 담당: frontend_integration / backend owner handoff
- 작업 폴더: C:/Users/USER/Downloads/files/forward-scouting-report-agent-config
- 시작: 2026-08-25 KST
- 범위와 가드: 새 additive `GET /api/v2/goal-mouth-baseline`만 요청한다. 기존 final-third-shot-map v1/v2/v3, `goalMouthY/Z` 변환, `rankings.py`, `tactical_ratio.py`, `spear.py`는 변경하지 않는다. 프런트는 `VITE_GOAL_MOUTH_BASELINE_ENABLED=false`를 기본값으로 유지하고, strict schema·fixture·OpenAPI·CORS·운영 검증 증거 수신 전에는 UI를 활성화하지 않는다.
- 로컬 검증: 고정 5개 정적 snapshot만 읽어 유효 엔드포인트 104,612개·득점 34,436개를 집계했다. `minimumCellSample=150`으로 50셀 전부 관측값을 반환한다. 미래의 150 미만 셀도 실제 `shots`/`goals`/득점률은 숨기지 않고 `state=low_sample`, `lowSample=true`, 서버 Wilson 95% 신뢰구간으로 표시한다. source 부재만 `state=unavailable`/null이다. `GET /api/v2/goal-mouth-baseline`의 strict OpenAPI·422 query 거부·캐시·CORS 및 Final Third 회귀 테스트 47건이 로컬에서 통과했다.
- 배포 증거: backend PR `#275`, main 병합 SHA `99eb8d799f578361da0b0361cf061a54e51868e8`, Render deploy `dep-da6i8aflk1mc73b0lf50` (live). `GET https://forward-scouting-report.onrender.com/api/v2/goal-mouth-baseline`은 `schemaVersion=1.0.0`, `baselineTaxonomyVersion=goal-mouth-baseline-v1`, 50 observed cells와 104,612/34,436 provenance를 반환한다. fixture는 `docs/fixtures/goal_mouth_baseline_v1/source_cases.json`이다. Production Origin 및 immutable Preview preflight는 exact ACAO/200, hostile preflight는 400/no ACAO, hostile GET은 200/no ACAO였다. backend 배포 시점에는 프런트 플래그가 생성·변경되지 않았으며 `.env.example` 기본값은 계속 false다.
- 로컬 프런트 결과: `GoalMouthView.tsx`에 strict `goal-mouth-baseline-v1` parser/API/hook·서버 셀 배경 레이어·on/off 토글·hover/focus tooltip·low-sample hatch를 추가했다. 활성화 시 기본 on이지만 `.env.example` 및 Production은 계속 `VITE_GOAL_MOUTH_BASELINE_ENABLED=false`이며, flag가 false면 요청·토글·레이어가 모두 없다. 실데이터 194165/2025-26/league/scope8/`taxonomy=duel-press-v1`에서 50셀·90 마커·필터·2× zoom을 확인했고 `row5_column1`은 SVG 상단(뜨거운 61.8%), 중앙 저확률 셀은 아래와 구분되어 Z축 반전이 없었다. 로컬 백엔드/Vite 프로세스는 QA 후 종료했고, 포트 5173/8000 리스너가 비어 있음을 확인했다.
- PR/Preview 증거: frontend/rules head `0c94c28d60e779f548d39976d421630082db9844`, PR `#277` (`Add fail-closed Goal-Mouth baseline overlay`). 최초 Preview `https://forward-scouting-report-6dn7-k5hpp1tzw-messiflick.vercel.app`에서 `VITE_GOAL_MOUTH_BASELINE_ENABLED=false` fail-closed를 확인했다(Goal-Mouth baseline API 호출·토글·레이어·셀 모두 0, 기존 골대/마커 정상). 전체 페이지에는 baseline 무관 기존 `GET /api/v2/players/194165?season=2021%2F2022&mode=europe&scope=8` 404 1건이 있으며, 2021/22 Europe 데이터 부재를 `Partial history: 1 context unavailable`로 처리하는 기존 동작이다.
- 승인된 Preview-only QA: `VITE_GOAL_MOUTH_BASELINE_ENABLED=true`를 **Vercel Preview 환경에만** 추가했고 Production은 선택 해제·미변경 상태로 유지했다. `VITE_FINAL_THIRD_SHOT_MAP_V3_ENABLED=false`도 미변경이다. source `0c94c28` Preview redeploy `6o8oTX4jYxwVbMb7Z5kuxRZfDtsP`, URL `https://forward-scouting-report-6dn7-r8qmjvkfp-messiflick.vercel.app`에서 `taxonomy=duel-press-v1` 실데이터 QA를 통과했다: baseline 50셀, 90 마커, 24 off-frame 마커/tooltip, blocked audit 28개, On target 필터 30개, 2× zoom/reset, on/off 토글(0↔50셀), hover tooltip(61.8%·212 shots·95% CI 55.1–68.1%). baseline 관련 콘솔 오류는 없고, 위 기존 404 1건만 관측됐다. `row5_column1`/`row5_column10`은 SVG 상단 y=220의 red 61.8%/62.3%, 중앙 `row3_column5`/`row3_column6`은 y=317.6의 12.4%/12.0%로 Z축 반전이 없다.
- main 병합: 사용자 승인에 따라 PR `#277`은 2026-08-25에 병합되었고 merge SHA는 `8a3d2db9734705cc597747b878c10b110492eef5`이다. Production의 `VITE_GOAL_MOUTH_BASELINE_ENABLED`는 계속 false/fail-closed이다. 당시 V3 Secret은 읽을 수 없어 값 자체를 단정할 수 없었으며, 이후 Production 실동작에서 V3가 활성임을 확인했다(위 실측 정정 참조). Production baseline 활성화는 별도 승인 없이는 금지한다.

- 상태: 완료 (main 병합됨)
- 작업: Goal-Mouth 골대 3D 디테일 커밋 · Vercel Preview · PR 생성 · main 병합
- 담당: frontend_integration (병합은 Claude Code)
- 작업 폴더: C:/Users/USER/Downloads/files/forward-scouting-report-agent-config
- 후속 작업 상태: 완료 (PR 병합 승인 대기) — Goal-Mouth 오프프레임 툴팁의 viewBox 경계 반전·가독성 보강. 클라이언트 렌더링만 수정하며 API/원본 좌표 계약은 변경하지 않는다.
- 후속 작업 결과: 완료 — 우측 마커는 좌측, 상단 마커는 하단으로 자동 반전하고, 미터 설명을 줄별로 배치·가변 폭 배경에 표시한다. 원본 `goalMouthY/Z`는 시각 툴팁에서 제거했으나 title/aria-label에 유지했다. 로컬 194165/2025-26/League/scope7/`taxonomy=duel-press-v1` 실데이터에서 우측 끝(오른쪽 포스트 밖 13.8m)과 상단 끝(크로스바 위 3.4m) 툴팁이 모두 패널 안에 표시됨을 확인했다. focused test 15건·production build 통과. 커밋·PR·배포 미수행.
- 후속 작업 PR: `https://github.com/arts-rgb112/forward-scouting-report/pull/274`는 사용자 승인에 따라 main에 병합 완료. 병합 커밋 `1f354c0157b9992d9eeebe1a94318ab4f594c482`, 병합 시각 2026-08-25 04:17:47 UTC. Goal-Mouth tooltip UI 변경이며 baseline API 계약과는 독립적이다.
- 시작: 2026-08-24 KST
- 결과: 명시적 VP(546,78) 기반 rear frame/mesh, 좌우 측면, 진한 격자형 네트, 지면과 맞닿는 그림자, 잔디 제거, 진초록 Goal 축구공 및 소형 공 패턴을 구현했다. FinalThirdShootingMap focused tests 14건과 production build가 통과했다. 이제 사용자 승인에 따라 커밋 후 Preview 환경변수 확인, Preview 실데이터 QA와 PR 생성을 진행한다. main 병합은 명시적으로 금지한다.
- 범위: messi-2-dashboard/src/playerDetail/GoalMouthView.tsx의 클라이언트 렌더링/UX 설계만. api_server/service.py와 data contract 변경 금지.
- 외부 상태: API·데이터 계약 변경 없음. Preview feature flag 값은 배포 전에 읽기 전용으로 확인하며, 변경이 필요하면 배포를 중단하고 사용자 승인을 받는다.
- Preview 배포: SHA `46b8bb5fd17063c2980be37188d1acf75be93701`; URL `https://forward-scouting-report-6dn7-jkpyuge0e-messiflick.vercel.app`; Inspect `https://vercel.com/messiflick/forward-scouting-report-6dn7/2QidExvWMnycX8mLJN2q9JyXdKKG`.
- Preview feature flags (당시 배포 시점 기록): `VITE_FINAL_THIRD_SHOT_MAP_ENABLED=true`, `VITE_FINAL_THIRD_SHOT_MAP_V2_ENABLED=true`로 Preview 전용 설정을 갱신했다. V3 Secret 값은 당시 읽을 수 없었고 변경하지 않았다. 현재 활성 상태 판정은 위의 배포 실동작 검증을 기준으로 한다.
- Preview QA: `/players/194165?season=2025%2F2026&mode=league&scope=7&competition=all`의 Goal-Mouth 탭에서 118개 엔드포인트(Goal 36, On target 30, Off target 24)를 렌더링하고 Blocked 28개는 audit-only로 유지함을 확인했다. 상태 필터, 2× zoom/reset, off-frame 마커·원본 감사 정보 및 콘솔 오류 0건을 확인했다. main 병합은 수행하지 않는다.
- PR: `https://github.com/arts-rgb112/forward-scouting-report/pull/273` — 사용자 승인 후 2026-08-25 09:19 KST 병합 완료. 병합 커밋 `963af4255b038843bc247f2d112a6b3f3cdac7f1` (origin/main). 병합 방식은 merge commit.
- 병합 전 Claude Code 독립 검증(Preview 실배포 DOM 실측): 소실점 `546 78`, mesh stroke-opacity `0.72`/width `1.65`, 잔디 잔존 0개, 골대 밑단과 그림자 상단 갭 `0px`, 마커 90개 전량 흰 공면 적용(goal `#22c55e` / on_target `#38bdf8` / off_target `#fbbf24`), off-frame 24개. 로컬 실측값과 완전 일치 확인.
- feature flag 정정 기록: 사용자가 Preview의 상세 스탯 보드가 Production과 다르게 보인다고 보고하여 `VITE_DUEL_PRESS_V2_ENABLED` 불일치를 의심했으나, 실제 원인은 QA URL에 `taxonomy` 쿼리 파라미터가 누락된 것이었다. `StaticRoute.tsx`의 `duelPressV2Requested`는 flag와 `taxonomy=duel-press-v1|duel-press-v2`를 동시에 요구하므로, taxonomy가 없으면 flag 값과 무관하게 legacy Six-sector board로 폴백한다. `taxonomy=duel-press-v1`을 붙여 Preview와 Production을 각각 실측한 결과 양쪽 모두 한글 STAT-PAIRS-V2 보드가 렌더링되어 **설정 불일치가 없음**을 확인했다. 따라서 `VITE_DUEL_PRESS_V2_ENABLED`는 어느 환경에서도 변경하지 않았다. 향후 상세 스탯 보드 QA URL에는 반드시 `taxonomy` 파라미터를 포함할 것.
- 남은 후속 작업: (1) final-third-goalmouth-v3 처리 방식 별도 결정 필요, (2) search-diacritic-hotfix 잔여 폴더 삭제는 사용자 선택, (3) 현재 worktree 자체에도 새로 생긴 잠긴 .pytest_cache 있음(2026-08-24 22:22경 생성) — 급하지 않으나 추후 동일 방식으로 정리 가능
- 동시편집 메모: 이 항목을 백엔드 오케스트레이터가 거의 동시에 갱신하려다 충돌 발생(Edit 도구가 안전하게 차단, 데이터 유실 없음). "각자 적는다" 방식의 실제 리스크 사례로 기록.
- 검증 메모: duel/press 확장 회귀 59건은 통과했으며 별도 source-audit 1건은 assertion 실패가 아니라 Windows `%TEMP%\\pytest-of-USER`의 `tmp_path` 생성 PermissionError로 실행 불가; historical fixture 범위와 무관
- 검증 메모: 원격은 main만 존재(e541704); 24개 worktree/23개 linked admin dir와 .git 포인터 정상, prune dry-run 대상 없음, fsck connectivity 통과; final-third-goalmouth-v3는 소유권 차단으로 별도 접근 처리 필요

## Backend orchestration guardrails

- 이 워크스페이스의 유일한 활성 백엔드 checkout은 `C:/Users/USER/Downloads/files/forward-scouting-report-agent-config`이다. `forward-scouting-report-GIT-METADATA-DO-NOT-DELETE`는 linked worktree의 공유 Git 메타데이터 보관소이므로 작업에 사용하지 않고 절대 삭제하지 않는다.
- 모든 백엔드 작업은 이 문서를 먼저 읽고, 시작과 종료 때 위 `진행 중인 작업` 상태를 갱신한다.
- `rankings.py`, `tactical_ratio.py` 등 V1/V2 공유 모듈을 수정하기 전에는 `dependency-mapper`로 전체 소비 경로와 회귀 범위를 확인한다.
- `sync-checker`는 구현 전 동기화 상태와 릴리스 전 계약·fixture·OpenAPI·배포 증거를 읽기 전용으로 점검한다.
- `implementer`는 승인된 범위의 로컬 코드 수정과 테스트만 수행한다. push, PR, merge, deploy, workflow 실행 및 feature flag 변경 권한은 없다.
- 새 API를 배포하거나 feature flag를 변경하면 endpoint/version, 배포 SHA, fixture, CORS 및 활성화 상태를 이 문서에 기록한다.
- 아래 `Deferred V2 scoring redesign candidates`는 사용자의 명시적인 제품 결정 없이는 병합하거나 구현 근거로 재사용하지 않는다.

## Deferred V2 scoring redesign candidates

The following historical branches are retained as product-decision references only.
They must not be cherry-picked into the current V2 scoring path. Any revival
requires a versioned proposal, cohort recalculation, API/fixture updates, and
separate approval.

- `agent/add-dynamic-spear-weights`: candidate to reconsider role-specific
  S.P.E.A.R. weighting (Type A versus Type B) rather than the current common
  V2 score formula.
- `agent/add-false-nine-penalty`: **conflicts directly with current V2
  policy.** V2 explicitly prohibits a Type B / false-nine penalty, masked box
  score, or score shield. Do not restore this behaviour accidentally; any
  future change requires an explicit product decision and a new versioned
  scoring contract.
- `agent/spear-master-hotfix`: candidate to reconsider the historical
  micro-zone-weighted six-factor S.P.E.A.R. formula. It is not compatible with
  the current V2 Volume x Ratio, combined-duel, forward-press, and source-state
  model without a dedicated redesign.
