# API contract notes

## 진행 중인 작업

- 상태: 완료
- 작업: 범용 백엔드 파이프라인용 Claude Code 프로젝트 서브에이전트 3종 생성
- 담당: 백엔드 메인 오케스트레이터
- 시작: 2026-08-24 21:19 KST
- 종료: 2026-08-24 21:24 KST
- 결과: `.claude/agents/`에 `sync-checker`, `dependency-mapper`, `implementer` 정의 추가
- 범위: `.claude/agents/` 정의와 본 공유 계약 문서만 변경
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
