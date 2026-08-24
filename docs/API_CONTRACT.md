# API contract notes

## 진행 중인 작업

- 상태: 완료
- 작업: 백엔드 오케스트레이션 에이전트 설정을 origin/main에 게시
- 담당: 백엔드 메인 오케스트레이터
- 시작: 2026-08-24 21:30 KST
- 종료: 2026-08-24 21:31 KST
- 결과: Claude Code용 Sonnet 정의와 Codex용 Terra 정의를 함께 보존하고, Codex 프로젝트 규칙 및 계약 우선 지침을 main 게시 대상으로 확정
- 범위: `agent/backend-orchestration-agents`를 최신 `origin/main`에 안전하게 반영하고 push
- 외부 상태: API, 데이터, feature flag, 배포 변경 없음

## Backend orchestration guardrails

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
