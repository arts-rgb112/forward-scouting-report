# M.E.S.S.I. backend project rules

## Contract-first rule

- Before starting any task, read `docs/API_CONTRACT.md` completely. Do not inspect, plan, edit, test, delegate, or release project work before reading it.
- At task start and completion, update the `진행 중인 작업` section in that contract on the active branch.

## Shared-module safety

- Treat `rankings.py`, `tactical_ratio.py`, `spear.py`, cohort builders, positional grids, and shared data snapshots as V1/V2 shared surfaces.
- Use `dependency-mapper` before changing a shared surface and use `sync-checker` before implementation and release.
- Do not merge, consult as implementation references, or reimplement `add-dynamic-spear-weights`, `add-false-nine-penalty`, or `spear-master-hotfix` without the user's explicit product decision.

## Release and handoff

- The `implementer` may edit and validate locally but may not push, create or merge PRs, deploy, trigger remote workflows, mutate remote data, or change feature flags.
- Record every new API deployment or feature-flag change in `docs/API_CONTRACT.md`, including its version, deployment SHA, fixtures, CORS evidence, and activation state.
- Every delegated agent starts fresh. Restate the objective, current behavior, prior decisions, context keys, API and file paths, evidence, tests, constraints, authorization, acceptance criteria, and expected handoff.
