# M.E.S.S.I. backend project rules

## Contract-first rule

- Before starting any task, read `docs/API_CONTRACT.md` completely. Do not inspect, plan, edit, test, delegate, or release project work before reading it. **The path is relative to the repository root, not to your working directory.** If you were started with a working directory below the repo root (the Slack `agent_loop.py` executor runs with `--cd messi-2-dashboard/`), the file is at `../docs/API_CONTRACT.md` — read it there. Do not conclude the contract is missing just because `docs/API_CONTRACT.md` does not resolve from your current directory; walk up to the repo root (the directory holding this `AGENTS.md`) and read it from there. Reads above your working directory are permitted — this `AGENTS.md` itself lives there and you are already reading it.
- **Exception — read-only opinion/discussion role (e.g. `#brainshower` opinion mode).** This rule governs project *work*: touching files, code, tests, or git. It does not gate a role that is structurally barred from all of those (no file patch, no test run, no git command) and is only exchanging technical opinions in a chat thread. That role reads whatever shared context it has been given (thread history, a context pack) and, where a point genuinely depends on `docs/API_CONTRACT.md` and the file isn't reachable in its sandbox, states that specific point as an unconfirmed assumption instead of refusing to discuss the whole topic. This exception does not extend to any role that can touch files, tests, or git — those still read the contract first, no exception.
- At task start and completion, update the `진행 중인 작업` section in that contract on the active branch, including the exact worktree path you are working in (`작업 폴더`).
- Never trust another session's `작업 폴더` entry at face value: before touching a shared surface, independently confirm that path is still active (e.g. check its git status) rather than assuming the log is current.

## Shared-module safety

- Treat `rankings.py`, `tactical_ratio.py`, `spear.py`, cohort builders, positional grids, and shared data snapshots as V1/V2 shared surfaces.
- The dependency/synchronization audit does **not** run on every shared-surface change. It fires only on the file list under "Subagent trigger" below, which is decided mechanically from `git diff --name-only`. Use that condition; do not fall back to a broader judgement call.
- Do not merge, consult as implementation references, or reimplement `add-dynamic-spear-weights`, `add-false-nine-penalty`, or `spear-master-hotfix` without the user's explicit product decision.

## Release and handoff

- The `implementer` may edit and validate locally but may not push, create or merge PRs, deploy, trigger remote workflows, mutate remote data, or change feature flags.
- Record every new API deployment or feature-flag change in `docs/API_CONTRACT.md`, including its version, deployment SHA, fixtures, CORS evidence, and activation state.
- Every delegated agent starts fresh. Restate the objective, current behavior, prior decisions, context keys, API and file paths, evidence, tests, constraints, authorization, acceptance criteria, and expected handoff.

## Common operating rules

These rules are above individual task orders. If a task order conflicts with them, follow these rules and report the conflict before implementation.

### Roles and approval

- The user is the final approver. Claude plans, specifies, and reviews. Codex implements and validates locally.
- Stop and ask when two choices materially change the result. Do not substitute a post-hoc "reasonable choice" for approval.
- Push, merge, deletion, deployment, remote-data mutation, and feature-flag changes require prior user approval.
- Report before touching files outside the approved scope.

### Reporting and verification

- Do not post an "implementation started" status. Report after a concrete commit or when a blocking escalation is required.
- Every completion report includes exact `commit SHA`, `push` state/branch, and `deployment` state/preview URL.
- Verify previews with a cache-busting `?cb=NNNN` query. A green build is not runtime-path evidence; identify whether the intended path or a fallback rendered.
- Report failed commands verbatim enough to distinguish an empty result from a broken command.

### Product and data invariants

- Score axes contain directional metrics only. Keep typology metrics in tactical summaries.
- Do not count the same numerator twice. Describe evidence without prescriptions.
- Missing server data renders `—`; the browser must not invent it.
- Use measured approved mockup values, not visual guesses.
- Fail loudly on retrieval or configuration failure. Distinguish missing data from failed loading.
- Do not change scores, cohorts, CSV snapshots, CCA, or HDR without explicit approval.
- Before destructive ETL writes, validate target identity and preserve exact keys. Do not publish partial results through `always()` or `continue-on-error`.

### Branches and tools

- Use one branch/worktree per task and keep unrelated work out. Merge only after user approval.
- Put reusable tooling on `main`, not on a feature branch.
- Use command-scoped `git -c safe.directory=<worktree>` for SID-mismatched worktrees.
- Codex sandbox cannot use the host Windows credential manager. Commit locally and give the user the SHA for host-side push; do not describe this as expired authentication.
- Windows environment changes apply only to newly created processes. After a change, reopen the terminal and verify reflected startup fields such as `contextChannelCount`.

### Mechanical subagent gate

Run `git diff --name-only <base>..HEAD`. The dependency/synchronization audit is required only when the diff contains one of:

`rankings.py`, `tactical_ratio.py`, `spear.py`, `spear_cohort.py`, `positional_grid.py`, `continuous_core.py`, `true_core.py`, `metrics.py`, `spatial_duels.py`, `shotmap_store_v2.py`, `data/`, or `.github/workflows/`.

When triggered, use the configured dependency mapper before implementation and the configured synchronization checker before implementation and release, then record the verdict in `docs/API_CONTRACT.md`. Do not create new agents, pipelines, or loops unless a task order explicitly requires one. `agent_loop.py` is the user-approved exception.

### Slack protocol

- Execution channel: `#자동사냥` (`C0BUSHPKY0L`). Untagged messages never execute.
- `[PLAN]` and `[DISCUSS]` save context with zero Codex turns. `[APPLY]` and `[REVISE]` each run one Codex turn and one test pass. `[STOP]` stops. Human-only `[RESET]` reopens and resets the default three-turn budget.
- The latest human instruction overrides earlier Claude text. Claude may send `[APPLY]` only for an already approved written task order and prefixes its body with `🤖 Claude Code`. Push, merge, and deployment remain user approvals.
- Audit logs never include source bodies, tokens, keys, or authorization headers.

Escalate in the originating Slack task thread before deviating when a command/test/build/deployment fails, the approved instruction cannot be followed, an out-of-scope file is required, a new defect/data anomaly/rule conflict is discovered, or the three-turn budget is exhausted. Do not use a protocol tag. Use exactly this structure:

```text
⚠️ CODEX → CLAUDE

무엇이     : 실패 / 변경 / 문제 발견
어디서     : 파일·명령·단계
증거       : 에러 원문, 커밋 SHA, 실패한 명령
막혔는가   : 중단 또는 우회 여부
선택지     : 대응 2~3개와 결과
추천       : 있으면 하나
```

If it blocks the task, also leave one short line in `#to_do_list` linking to the thread. This escalation is a report, never an execution tag.

### Agent-loop boundary and cost

- `agent_loop.py` may edit only its own `messi-2-dashboard/` project root and cannot edit itself, `.git`, `node_modules`, `dist`, `.env*`, absolute paths, or parent paths.
- Use a normal Codex session for repository-root files, backend/data/ETL files, `agent_loop.py`, push, merge, and deployment.
- Prefer no-model checks before model execution and keep Slack context bounded. Avoid repeated push/deploy/screenshot loops when local verification is possible.

### Tone

- Use concrete, evidence-backed language without hype. When evaluating or comparing, name the comparison group, evidence, confidence, and unverified parts.
