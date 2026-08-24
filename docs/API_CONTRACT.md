# API contract notes

## 진행 중인 작업

- 상태: 완료
- 작업: contextual compare historical league fixture 해소 상태 sync-checker 재검증 및 stale handoff 정리
- 담당: 백엔드 메인 오케스트레이터
- 시작: 2026-08-24 22:20 KST
- 종료: 2026-08-24 22:27 KST
- 결과: HEAD와 origin/main(e541704)에서 historical fixture의 enclosing/nested context 일치와 legacy right payload 부재를 재확인; backend contextual 17건과 frontend strict/contextual 10건 및 stale-context 음성 회귀가 통과하여 구현·배포 불필요 판정, 해소된 2026-08-22 handoff만 삭제
- 범위: fixture 직접 파싱, backend/frontend strict·negative regression, 호환 회귀 및 staged handoff 삭제 적정성 확인
- 외부 상태: API, 데이터, feature flag, 배포 변경 없음
- 검증 메모: duel/press 확장 회귀 59건은 통과했으며 별도 source-audit 1건은 assertion 실패가 아니라 Windows `%TEMP%\\pytest-of-USER`의 `tmp_path` 생성 PermissionError로 실행 불가; historical fixture 범위와 무관

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
