# API binding static quality review

Review date: 2026-08-10  
Scope: read/grep-only review of `messi-2-dashboard` and the partial `forward-scouting-report/api_server`. No test, typecheck, build, HTTP request, or browser run was performed.

## Decision

**Do not approve for staging or production.** Static inspection leaves **2 P0** and **2 P1** findings open. The implementation report's claims about source structure are mostly supported by the source files, but its claims that the checked-in `dist` is a successful deployable build and that it binds to the available backend are not supported.

## Findings

### P0 — Backend `/api/v1/players` response cannot pass the frontend v1 parser

- Frontend contract: `src/api/contracts.ts:3-13` requires `position`, `archetype`, `tier: { code, level, label }`, asset `{ id, name, icon }`, and `meta.schemaVersion`.
- Available backend contract: `../forward-scouting-report/api_server/schemas.py:12-16,30-46,49-64` instead exposes assets without `id`, `role` instead of `position`, `tier` as a string plus `tierLabel`, lacks `archetype` and tier `level`, and lacks `meta.schemaVersion`.
- Backend construction confirms this is not just an OpenAPI typo: `../forward-scouting-report/api_server/service.py:50-71` emits `role`, string `tier`, `tierLabel`, and three `{name, icon}` assets; `:81-87` emits metadata without `schemaVersion`.
- Reproduction: start the available API and request `GET /api/v1/players?season=2025/2026&scope=7&limit=1000`; then pass the JSON to `parsePlayersEnvelope(..., { season: "2025/2026", scope: 7 })`. Zod rejects it before the adapter or dashboard render path.
- Impact: a reachable API produces the frontend's schema-error screen; no player data can render.
- Proposed fix: choose and version one v1 wire contract, then update one side before deployment. The least lossy path is for backend models/service/OpenAPI to emit the frontend's documented v1 fields (including `schemaVersion`, asset IDs, nullable nation, `position`, explicit `archetype`, and `{code, level, label}` tier), backed by a contract fixture shared by both repos. Alternatively revise the frontend contract/UI deliberately and obtain product approval for the changed semantics.
- Approval needed: **API contract owner** must approve the canonical v1 envelope and tier/archetype/asset semantics.

### P0 — Checked-in `dist` is not a runnable Vite production artifact and has no configured production API origin

- `dist/index.html:15` still loads `/src/main.tsx`, whereas a Vite build output must reference a hashed file under `/assets/`. The referenced source path is not present in `dist`; serving this directory therefore fails before React starts.
- The existing JS artifact, `dist/assets/index-DXpktXdD.js:9`, contains the baked production env object used by `PlayersResourceContainer`; static inspection shows only Vite defaults (`BASE_URL`, `MODE: "production"`, etc.), not a `VITE_MESSI_API_BASE_URL` value. `src/api/env.ts:4-11` therefore produces a configuration error if that bundle is ever made reachable.
- Only `.env.development` supplies the local HTTP API (`.env.development:1-4`). `.env.example:1-4` is a template, not a build input, and no approved staging/production env file or runtime configuration mechanism exists.
- Reproduction: serve the committed `dist` directory. First request fails for `/src/main.tsx`; if the HTML is corrected to load the present JS, the bundle reaches `parseMessiApiConfig` with no API base URL and renders the configuration fallback.
- Impact: the submitted artifact cannot be used for a preview/staging deployment, regardless of the source-code implementation.
- Proposed fix: run the release build in the deployment pipeline with the approved HTTPS API origin supplied as a build environment variable, publish the generated `dist/index.html` and matching hashed assets together, and add a post-build smoke assertion that `index.html` contains no `/src/` module entry and the configured API origin is present/valid. Do not commit a placeholder URL as a deployment setting.
- Approval needed: **deployment owner** must provide the real HTTPS staging origin and authorize the corresponding frontend build configuration.

### P1 — Staging CORS is intentionally unspecified, so a real browser binding remains unverified

- `../forward-scouting-report/api_server/main.py:13-23` defaults to localhost Vite/preview origins only. It can use `MESSI_CORS_ORIGINS` or a regex, but no staging frontend origin is configured.
- `src/api/env.ts:6-8` correctly rejects non-HTTPS non-local origins, and the implementation report itself records that `.env.staging` was omitted. This is an honest limitation, but it is a release blocker rather than an approval-ready integration.
- Reproduction: deploy the frontend at any non-local origin while backend keeps defaults; browser preflight/GET is rejected by CORS. A browser request cannot be used to establish the API compatibility claimed by the implementation report.
- Proposed fix: after P0 contract alignment, set the exact deployed frontend origin in `MESSI_CORS_ORIGINS`, build the frontend with the exact HTTPS API origin, and verify `OPTIONS` plus credential-free `GET` from that origin.
- Approval needed: **security/deployment owner** must approve the precise allowed origins; avoid a broad production regex.

### P1 — High-risk request paths have no executable tests

- There are eight test files (`src/**/*.test.*`), matching the implementation report count, but none is for `src/api/playersApi.ts`, `src/api/retry.ts`, `src/dashboard/PlayersResourceContainer.tsx`, or `DashboardErrorBoundary.tsx`.
- Current tests cover schema examples (`src/api/contracts.test.ts:1-3`), env parsing (`src/api/env.test.ts:1-3`), and reducer-only stale/refresh cases (`src/dashboard/playersResourceState.test.ts:1-3`). They do not execute fetch, `Retry-After`, network retry, abort during sleep, response JSON/schema failure mapping, StrictMode mount/unmount behavior, or rendering-boundary reset.
- Reproduction: a regression in the container's fetch path or retry timers can ship while all eight listed suites remain green.
- Proposed fix: add fake-fetch/fake-timer tests for three-attempt retry policy (including 408/429/5xx and bounded `Retry-After`), no retry for abort/config/schema/other 4xx, abort on replacement/unmount under StrictMode, stale resolve rejection, initial/refresh fallback, and a deliberately throwing child reset by `DashboardErrorBoundary`.
- Approval needed: none for tests; however, release approval should be withheld until these paths are exercised against the agreed contract.

### P2 — Loading table clips horizontal content instead of matching the live table's scroll affordance

- `src/dashboard/components/DashboardLoading.tsx:3` correctly creates ten 13-cell, 72px desktop rows and reuses the 1418px colgroup. `:4` correctly reserves five mobile cards, six metric cells, and two 44px actions. `:5` supplies one polite status and `aria-busy`.
- However, the skeleton's desktop `<section>` uses `overflow-hidden`, while the live `PlayerTable` horizontal container at `src/dashboard/components/PlayerTable.tsx:5` uses `overflow-x-auto`. At widths below 1418px but at/above Tailwind `md`, the loading columns are clipped and cannot be horizontally inspected.
- Reproduction: use a 768–1417px viewport during first load; compare skeleton with the loaded table.
- Proposed fix: give the skeleton the same horizontal scroll container/scrollbar policy as the live table, while retaining `aria-hidden` for decorative rows.
- Approval needed: none.

## Verified source-level strengths (not runtime verification)

- The async boundary is structurally separated: `src/app/App.tsx:1` mounts `DashboardErrorBoundary` around `PlayersResourceContainer`; `src/dashboard/MessiScoutingDashboard.tsx:1-9` is prop-driven and has no fetch/env/Zod import.
- The container aborts a prior controller, uses request IDs through `playersResourceReducer`, preserves a stable payload during refresh, and handles rejected promises rather than throwing async failures into the error boundary (`src/dashboard/PlayersResourceContainer.tsx:2-4`, `src/dashboard/playersResourceState.ts:3-8`). React StrictMode is enabled in `src/main.tsx:1-2`.
- The retry implementation statically has three attempts, the requested retryable statuses, 500/1500ms+jitter fallback, bounded `Retry-After`, and abortable sleep (`src/api/playersApi.ts:9-30`, `src/api/retry.ts:2-8`). This is code-reading evidence only; P1 covers the missing execution tests.
- Strict Zod objects, numeric ranges, HTTPS assets, six sectors, rank/id uniqueness, and cross-field metadata checks are present in `src/api/contracts.ts:2-16`. The six-sector order and six tier codes are also present in `src/dashboard/types.ts:1-15` and `src/dashboard/scoutingConfig.ts:10-25`.
- Null asset behavior is handled without an image request (`src/dashboard/components/AssetImage.tsx:4-8`), and server rank/meta/partial-data UI is wired through `PlayerTable`, `DatasetHeader`, and `DatasetFooter`.
- Source grep found no production `src` import of `samplePlayers`; fixtures retain the name only in `src/test/fixtures/players.ts`. No current-source references to the retired metrics were found outside historical/spec documents. Reduced-motion handling exists in `src/index.css:39-46`.

## Claims deliberately not independently confirmed

- “`pnpm test` 8 files / 38 passed” and “`pnpm build` passed” were not run under this review constraint.
- Browser layout, CORS preflight, real HTTP response, real asset loading, and error-boundary behavior were not executed.
- The implementation report's `dist` mock-marker statement may be true for those strings, but it is insufficient: the checked-in `dist/index.html` itself is not a Vite deployment entry and the bundle lacks production API configuration.

## Required release gate

1. Close both P0s: make backend/frontend contract identical and publish a properly configured build artifact.
2. Obtain the API and deployment/CORS approvals named above.
3. Execute the missing request-path tests and a real browser smoke test against staging (success, empty, 4xx/5xx, malformed schema, refresh failure, and CORS preflight).

## Remediation re-review (2026-08-10)

Scope and method remain read/grep only. I did not run the claimed backend `pytest`, frontend `pnpm test`, frontend build, server, or browser.

### Reassessment

The previous source-level P0 contract mismatch is **resolved in code**. `../forward-scouting-report/api_server/schemas.py:12-64` now declares frontend-v1-shaped assets with IDs, `position`, `archetype`, structured `{code, level, label}` tiers, nullable nation, six sector scores, and `meta.schemaVersion`. `service.py:43-70` constructs the same field names from the leaderboard, while `rankings.py:483-509` supplies the league/team IDs and numeric six-sector scores. The backend API test at `../forward-scouting-report/tests/test_api.py:17-34` statically asserts the emitted field sets and types; its OpenAPI check is at `:58-63`.

The previous P0 `dist` HTML-entry defect is **resolved in code**. `dist/index.html:11-12` now references the matching hashed JS/CSS assets and no longer points to `/src/main.tsx`.

The prior P2 skeleton concern is **resolved**. `src/dashboard/components/DashboardLoading.tsx:3` now uses an `overflow-x-auto` frame, retains the shared 1418px/13-column layout and ten 72px rows, and `:4-5` retain the five mobile cards, six metric slots, two action slots, polite status, `aria-busy`, and motion-safe pulse behavior.

The former P1 test gap is **substantially reduced, but not fully closed**. `src/api/playersApi.test.ts:17-53` now covers retryable HTTP, `Retry-After`, non-retryable HTTP, schema failure, network retry, abort, and delay bounds. `src/dashboard/components/dashboardComponents.test.tsx:6` exercises the rendering fallback action. Reducer stale-result and refresh-preservation tests remain at `src/dashboard/playersResourceState.test.ts:3`.

The CORS implementation is code-resolved but deployment-deferred: `../forward-scouting-report/api_server/main.py:21-38` has an exact comma-separated allowlist and no regex allowance; tests at `tests/test_api.py:37-50` cover local allow, hostile-origin denial, and normalized configured origins. An approved staging frontend origin is still absent, so the current browser integration cannot be approved.

### Remaining findings

#### P1: No approved HTTPS API origin and matching CORS allowlist are supplied to the release build

- Evidence: `.env.development:1-4` is local-only and `.env.example:1-4` is only a template. No approved staging production configuration is present. The current bundle `dist/assets/index-DwMEK6E3.js:1` contains the production Vite env object with `BASE_URL`, `MODE`, `PROD`, etc., but no injected `VITE_MESSI_API_BASE_URL`; the parser code remains present and will display the configuration fallback without it.
- Reproduction: serve the current `dist` successfully, then load it in a browser. It cannot form a valid API request because the baked `VITE_MESSI_*` values are absent. Even after an API URL is supplied, a non-local frontend origin is denied unless the exact origin is set in `MESSI_CORS_ORIGINS`.
- Impact: this is no longer a code-contract P0; it is an external release configuration gate. A staging browser smoke test cannot be performed until the endpoint and frontend origin are approved.
- Proposed fix: deployment owner supplies the exact HTTPS API origin to the frontend build and the exact deployed frontend origin to `MESSI_CORS_ORIGINS`; publish the newly built, matching `dist` assets. Then verify real preflight and GET in a browser.
- Approval needed: API/deployment/security owner approval for both exact origins.

#### P1: Backend does not enforce the frontend's positive player-ID invariant

- Evidence: frontend `src/api/contracts.ts:7` requires `player.id` to be a positive integer. Backend `../forward-scouting-report/api_server/schemas.py:42` declares only `id: int`, and `service.py:34-40` converts an invalid/non-numeric ID to `0`; `service.py:50` then emits it. `tests/test_api.py:17-34` checks object shape but not `player.id > 0`.
- Reproduction: a cohort record with a blank, non-numeric, or NaN `player_id` follows `_player_id` to `0`; Pydantic accepts it, but the frontend rejects the response as a schema error.
- Impact: a malformed or changed source cohort can turn an otherwise valid API response into a client-wide failure, despite the claimed v1 alignment.
- Proposed fix: declare `PlayerResponse.id` as strictly positive, reject or skip invalid source rows before response construction, and add backend contract tests for positive player IDs (including an invalid-ID fixture). Do not silently synthesize `0`.
- Approval needed: data/API owner should decide whether invalid source rows fail the request or are excluded with an explicit data-quality policy.

#### P1: Resource-container StrictMode/replacement-abort behavior remains untested

- Evidence: transport-level abort is now tested in `src/api/playersApi.test.ts:37-46`, and reducer stale actions are tested in `src/dashboard/playersResourceState.test.ts:3`. There is still no test file rendering `PlayersResourceContainer`; `rg --files -g '*.test.*' src` shows no container test. Thus `src/dashboard/PlayersResourceContainer.tsx:2-4` is not exercised for effect cleanup, replacement abort, or duplicate development-StrictMode mount.
- Reproduction: a future refactor can remove the cleanup/replacement abort while transport and reducer tests continue to pass.
- Proposed fix: render the container under `StrictMode` with injected or mocked `fetch`; assert cleanup aborts the first request, only the newest response reaches the reducer/UI, and an abort during retry sleep produces no visible error.
- Approval needed: none; keep this as a release-quality gate because it covers the integration seam rather than an isolated utility.

### Current release status

**Remaining P0: 0. Remaining P1: 3.** The old P0s are code-resolved, but release/staging approval remains blocked by the external origin configuration and the two P1 correctness/coverage gaps above.

## Final remediation re-review (2026-08-10)

Read/grep-only final check. The claimed test/build commands were not run in this review.

### Resolved since the preceding re-review

- **Positive player ID invariant:** `../forward-scouting-report/api_server/schemas.py:42` now declares `PlayerResponse.id = Field(gt=0)`, matching frontend `src/api/contracts.ts:7`. `api_server/service.py:42-49` rejects nonnumeric, nonfinite, fractional, zero, and negative source IDs; `:57-62` drops those rows instead of emitting a synthetic zero ID. `tests/test_api.py:22-34,38-52,75-82` statically covers successful positive IDs, malformed-row exclusion, and OpenAPI `exclusiveMinimum: 0`.
- **StrictMode/container lifecycle coverage:** `src/dashboard/PlayersResourceContainer.test.tsx:27-44` renders the actual container in `StrictMode` using deferred transport promises. It asserts the initial replacement signal is aborted, a stale completion never renders, the surviving response renders, and unmount aborts the active request. This closes the previous P1 integration-test gap; the existing transport and reducer tests continue to cover retry/abort and stale reducer actions.

### Remaining finding

#### P1: Approved staging endpoint and exact browser origin remain external deployment inputs

- Evidence: `.env.development:1-4` is intentionally localhost-only and `.env.example:1-4` remains an HTTPS template. No approved `.env.staging` or production deployment configuration is present. Backend `../forward-scouting-report/api_server/main.py:21-38` correctly requires an exact `MESSI_CORS_ORIGINS` allowlist, but has no supplied staging origin.
- Reproduction: a production/staging bundle built without the approved `VITE_MESSI_API_BASE_URL` renders the configuration fallback; a frontend deployed at an origin not placed in `MESSI_CORS_ORIGINS` fails CORS. Neither condition can be resolved safely by inventing an endpoint or broadening the allowlist.
- Proposed fix: authorize the exact HTTPS API endpoint and exact frontend origin, inject them into the frontend build and backend `MESSI_CORS_ORIGINS`, then perform the outstanding browser preflight/GET smoke test.
- Approval needed: API, deployment, and security owner approval for the exact origins.

### Final status

**Remaining P0: 0. Remaining P1: 1.** All code-level findings from the prior reviews are resolved by static inspection; the sole remaining P1 is the intentionally deferred external staging configuration and browser verification.
