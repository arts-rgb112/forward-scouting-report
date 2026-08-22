# Backend handoff: historical contextual compare fixture has a stale duel-readout context

## Owner and scope

- Backend owner thread: `019fe9a8-a8d3-72c0-411405a86970` on `local`.
- Endpoint contract: `POST /api/v2/compare/contextual`, `comparisonVersion: "contextual-compare-v1"`.
- No production request was made and no backend data was calculated or changed by the frontend work.

## Evidence

Fixture: `docs/fixtures/contextual_compare_v1/historical_league_response.json`.

Its resolved left side declares the exact selected context:

```json
{"playerId": 1, "season": "2022/2023", "mode": "league", "scope": 3, "competition": null}
```

but `left.duelPressDetailReadout.context` currently declares:

```json
{"playerId": 1, "season": "2025/2026", "mode": "league", "scope": 8, "competition": null}
```

The strict frontend parser rejects this response before rendering. This is intentional stale-response protection: a duel/press readout must echo the same player, season, mode, scope, and competition as its containing resolved side and as the request. The legacy right side correctly has no duel/press payload.

## Required backend/fixture change

Regenerate or correct `left.duelPressDetailReadout` so its `context` exactly echoes the historical left side (`2022/2023`, League, scope `3`, competition `null`) and all readout values/provenance correspond to that context. Do not copy the current-season/eight-league readout and do not replace it with a domestic substitute from another context.

## Frontend contract and cache context

- Exact side identity key: `idNamespace`, `playerId`, `taxonomy`, `season`, `mode`, `scope`, `competition`.
- League responses canonicalize `competition` to `null`; Europe responses canonicalize `scope` to `null`.
- Both sides remain independently `resolved`, `unavailable`, or `invalid_context`; unavailable/invalid sides must contain no analytical payload and all component availability values must be `unavailable`.
- A resolved `duel-press-v1` side must include both `duelPressPlayer` and `duelPressDetailReadout`; `legacy-v1` must include neither.
- `duelPressDetailReadout` must contain six ordered categories (`outsideShot`, `boxThreat`, `dangerZone`, `combinedDuel`, `spaceControl`, `forwardPress`) and exactly two ordered neutral indicators (`netProgressionPer90`, `shootingLuckOrGoalkeeperImpact`).

## Acceptance evidence requested

1. Updated immutable fixture (or endpoint response) parses with the strict frontend contract using the matching exact request.
2. A negative test shows a mismatched `duelPressDetailReadout.context` is rejected.
3. Backend confirms response CORS/preflight for the frontend origin before feature activation.

[backend-designer를 위한 컨텍스트 패키지]
"""
ROLE: backend_designer
REPOSITORY/BRANCH: arts-rgb112/forward-scouting-report; backend contextual-compare implementation merged at main 3daff278401484a3f9b8695f9b00c4b4b5a97793. Frontend integration worktree is C:\Users\USER\Downloads\files\forward-scouting-report-native-migration, branch agent/native-streamlit-completion.
USER OBJECTIVE: Complete native M.E.S.S.I. independent-context compare without Streamlit while preserving authoritative season/mode/scope/competition identity for every side and nested readout.
FRONTEND ROUTE AND USER FLOW: Native /compare sends POST /api/v2/compare/contextual with independently selected left/right FotMob player contexts. The response is parsed strictly before side-local semantic rendering. A historical League duel-press side must display only its matching historical readout.
CURRENT USER-VISIBLE BEHAVIOR: The frontend is not activated/released. Its strict parser rejects the supplied historical comparison fixture because its nested duelPressDetailReadout context differs from the containing left-side context. This fail-closed rejection prevents stale/cohort-corrupt data from being shown.
PRIOR DECISIONS THAT MUST BE PRESERVED: Frontend never calculates scores/ranks/cohorts/tactical zones/comparison output. FotMob idNamespace is mandatory. Exact context identity is playerId+idNamespace+taxonomy+season+mode+scope+competition. League canonicalizes competition:null; Europe canonicalizes scope:null. Numeric 0 is observed; null is unavailable; fallback/imputed remain explicit. duel-press-v1 has exactly six ordered categories and exactly two ordered neutral indicators. Existing PR230 Spatial Pitch and PR233 readout behavior remain compatible.
AFFECTED CONTEXTS (season/mode/scope/competition/player IDs): Fixture docs/fixtures/contextual_compare_v1/historical_league_response.json, resolved left side playerId 1, taxonomy duel-press-v1, season 2022/2023, mode league, scope 3, competition null. Nested left duelPressDetailReadout incorrectly echoes season 2025/2026 and scope 8. The legacy-v1 right side correctly has no duel payload.
EXACT API REQUEST/RESPONSE OR OPENAPI GAP: POST /api/v2/compare/contextual, comparisonVersion contextual-compare-v1. The response schema must require a resolved duel-press side's duelPressDetailReadout.context to exactly equal the enclosing side canonical context. The supplied historical fixture violates this invariant. No new endpoint or calculation is requested; correct fixture/data provenance is required.
FRONTEND FILES AND CURRENT IMPLEMENTATION: messi-2-dashboard/src/api/contextualCompareContracts.ts strictly validates nested context/order/provenance; its fixture tests reject the mismatch. Native compare uses that contract before rendering. Handoff evidence file: messi-agent-handoffs/to-backend/contextual-compare-historical-readout-context-2026-08-22.md.
BROWSER/CONSOLE/NETWORK EVIDENCE: No production request was made. Local fixture parsing rejects historical_league_response.json due to the nested context mismatch. This is expected stale-response protection. Browser/live QA remains blocked until corrected evidence is returned.
STRICT SCHEMA, NULL/ZERO/UNAVAILABLE/IMPUTED EXPECTATION: Do not coerce mismatched context, null, or a zero. Correct the nested readout with authoritative historical context/value/provenance. Resolved duel-press must include duelPressPlayer and readout; legacy must include neither. Unavailable/invalid sides have no analytical payload and all component availability is unavailable.
BACKEND WORK REQUEST: Regenerate or correct the historical fixture and any corresponding endpoint builder/test data so left.duelPressDetailReadout.context exactly echoes player 1 / 2022/2023 / league / scope 3 / competition null and all readout values/provenance arise from that same context. Add/retain a backend negative regression for mismatched nested context. Do not substitute a 2025/2026 scope-8 payload.
BACKEND ACCEPTANCE TESTS: (1) Updated historical request/response parses through the strict frontend schema. (2) A nested readout context mismatch is rejected server-side or caught in fixture validation. (3) Full left/right order and same-side component availability invariants remain passing. (4) Existing contextual compare, duel-press, legacy compare and CORS tests remain passing. (5) CORS/preflight evidence for the frontend origin is reconfirmed after any deployment.
COMPATIBILITY, CORS, PERFORMANCE CONSTRAINTS: Additive fixture/contract correction only; preserve POST credentials omission, approved Production/Preview origins, hostile-origin rejection, static cached data and no provider calls/N+1 work.
EXTERNAL-WRITE AUTHORIZATION: The user authorized backend correction, tests, PR/merge/deployment for this migration. No DNS/messi.my change. Legacy Streamlit remains deployed solely as rollback during observation.
EXPECTED BACKEND OUTPUT AND FRONTEND ACTIVATION GATE: Return corrected immutable fixture (and deployed endpoint evidence if runtime data is affected), backend test evidence, OpenAPI/CORS confirmation, and exact context echo proof. Frontend remains fail-closed and must not proceed to reviewer/Preview/Production activation until this authoritative evidence is returned.
"""
