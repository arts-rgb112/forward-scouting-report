# M.E.S.S.I. 2.0 API binding implementation

## Frontend implementation

The production entry point now renders `App → DashboardErrorBoundary → PlayersResourceContainer → MessiScoutingDashboard`. The dashboard has no environment, fetch, Zod, or sample-data dependency; `players`, `meta`, `refreshing`, and `onRefresh` are required props. `samplePlayers.ts` was deleted from the production tree. Contract-only data is under `src/test/fixtures/players.ts`.

### Contract and request boundary

- `src/api/contracts.ts`: strict Zod v1 schemas for the envelope, player, tier, assets, metadata, and exactly six sector scores. It rejects extra keys, old metrics, invalid ranges, non-HTTPS asset URLs, duplicate IDs/ranks, returned/population inconsistencies, non-timezone timestamps, empty data with a positive population, and request/response season or scope mismatch.
- `src/api/env.ts`: validates origin-only base URLs, allows HTTP only for development localhost/127.0.0.1, requires HTTPS otherwise, validates season/scope/limit, and builds `/api/v1/players` with `URLSearchParams`.
- `src/api/adapter.ts`: explicit 1:1 DTO copy. It does not synthesize nation, age, assets, rank, scores, tiers, or metrics.
- `src/api/playersApi.ts`, `retry.ts`, `errors.ts`: GET with `Accept: application/json`, `credentials: omit`, and caller signal. Network and 408/429/500/502/503/504 responses retry to three total attempts with 500/1500 ms plus jitter; bounded `Retry-After` is supported. Abort, configuration, JSON/schema, and other 4xx failures do not retry.

The exact development request is `http://localhost:8000/api/v1/players?season=2025%2F2026&scope=7&limit=1000`.

### Async and render states

- `playersResourceState.ts` is a request-ID reducer with idle/loading/refreshing/success/empty/error states and stale-result rejection.
- `PlayersResourceContainer.tsx` aborts replaced/unmounted requests, keeps the last stable payload during refresh, distinguishes configuration/network/HTTP/schema errors, and does not throw async failures to the render boundary.
- `DashboardLoading.tsx` provides one polite loading status, `aria-busy`, ten desktop rows with 13 cells, and five mobile cards reserving all six metric slots and both 44px actions.
- `DashboardDataFallback.tsx` supplies typed initial-load errors and a compact previous-data refresh warning. Dataset-empty is separate from local-filter-empty.
- `DashboardErrorBoundary.tsx` catches render/lifecycle failures only, hides stack details, supports subtree remount and full-page reload.

### Dashboard/UI binding

- `types.ts` defines six metric keys, six tier codes with level and server label, rank, position and archetype separately, nullable age/face/nation, asset IDs, and v1 metadata.
- `scoutingConfig.ts` uses the fixed sector order `outsideShot`, `boxThreat`, `dangerZone`, `aerial`, `groundDuel`, `spaceControl`; all six tiers have local glyph/color treatment and no network placeholder.
- `playerQuery.ts` filters exact positions, includes archetype in search, omits absent nation from the search corpus, and sorts null ages last.
- `PlayerTable.tsx` uses server rank and a shared 13-column colgroup/header at `min-w-[1418px]`; body rows are 72px and sticky-header horizontal scroll is synchronized.
- `PlayerCardList.tsx` displays all six metrics in a 3×2 mobile grid. `PlayerIdentity`/`AssetImage` do not issue requests for null URLs and provide accessible neutral initials/name fallbacks. `TierBadge` preserves the server label and level.
- `DatasetHeader`/`DatasetFooter` expose season, scope, returned, population, generated time, source, and schema version. Partial responses are explicitly warned. The former hard-coded LIVE/tier count/minimum-minutes claims were removed.
- Existing local search, sort, comparison tray, watchlist persistence, reconciliation of removed IDs, dark/high-density visual language, and 44px actions remain.

### Environment files

- `.env.development`: local API at `http://localhost:8000`, season 2025/2026, scope 7, limit 1000.
- `.env.example`: HTTPS copy template without secrets.
- `.gitignore`: `.env`, `.env.local`, and mode-local override files are ignored.
- `.env.staging` was intentionally not invented because no approved real staging HTTPS origin was supplied. Add the exact deployed API origin when known; the parser rejects placeholders with paths, credentials, query, hash, or HTTP.

### Frontend changed files

`package.json`, `pnpm-lock.yaml`, `.gitignore`, `.env.example`, `.env.development`, root `MessiScoutingDashboard.tsx`, `src/main.tsx`, `src/app/App.tsx`, all files under `src/api/`, `src/dashboard/types.ts`, `scoutingConfig.ts`, `playerQuery.ts`, `playersResourceState.ts`, `PlayersResourceContainer.tsx`, `MessiScoutingDashboard.tsx`, and the dashboard components for assets, identity, tiers, table, cards, loading, dataset header/footer, async fallback, error boundary, and legend. Production `src/dashboard/samplePlayers.ts` was removed; tests and fixture files were updated/added.

### Verification

- Node runtime: `C:\Program Files\nodejs\node.exe` (the ambient shell PATH did not include it, so validation prepended that directory).
- `pnpm test`: 8 files, 38 tests passed.
- `pnpm build`: TypeScript project build and Vite production build passed; 126 modules transformed.
- Static production/dist search for `samplePlayers`, `placehold.co`, `linkPlay`, `pressing`, `progression`, `LIVE`, and `min. 900`: zero matches.

### Remaining frontend items

- A real staging origin is required before committing `.env.staging`.
- Browser smoke against the real backend endpoint was not possible within this frontend-only implementation step; contract fixtures, unit tests, type checking, and production bundling passed.
- Retry behavior is implemented with injected fetch/sleep/random/time seams, but exhaustive fake-timer request tests can be added if a broader test pass is desired.

## Remediation: v1 API binding (2026-08-10)

The previous P0 wire-contract mismatch is resolved in the paired backend implementation at `../forward-scouting-report`. `api_server/schemas.py` now exposes the exact strict frontend v1 shape: `position`, independent `archetype`, `tier { code, level, label }`, nullable `nation`, `{ id, name, icon }` league/club assets, all six numeric sectors, and `meta.schemaVersion: "1.0.0"`. `api_server/service.py` maps the real six-sector output from `rankings.get_spear_leaderboard`, carries `league_id` and `team_id`, and derives `generatedAt` deterministically from the static cohort/tactical input file mtimes rather than request time. `rankings.py` now carries `team_id` through its leaderboard records. A missing upstream team ID is represented as the explicit numeric `0` required by the v1 asset contract; no asset URL or nation is fabricated.

`api_server/main.py` keeps `/docs`, `/redoc`, and OpenAPI enabled. It returns an explicit 404 for a season absent from the static cohort and retains FastAPI 422 validation for malformed query values. CORS accepts localhost development/preview origins by default or only the exact comma-separated `MESSI_CORS_ORIGINS` values; the former regex environment escape hatch was removed. No staging origin or `.env.staging` was invented.

Frontend transport coverage was added in `src/api/playersApi.test.ts`: retryable HTTP + `Retry-After`, non-retryable HTTP, network retry, abort preservation, malformed JSON-schema payloads, and numeric/date retry delay behavior. `DashboardLoading.tsx` now has the same horizontal `overflow-x-auto` frame as the live desktop table while retaining the shared 13 columns, `min-w-[1418px]`, and 72px row height. Backend `tests/test_api.py` covers the real endpoint envelope, static timestamp, structured tier, source asset IDs, CORS localhost allow/hostile deny, unsupported-season 404, and OpenAPI fields. Backend test dependencies are declared in `requirements-api.txt`.

Verification after remediation: backend `python -m pytest -q` passed 21 tests using the Codex bundled Python; frontend `pnpm test` passed 44 tests; the production build and static scans are rerun as part of this handoff. The remaining P1 is external deployment configuration: an approved exact staging frontend origin must be supplied through `MESSI_CORS_ORIGINS`, paired with the exact HTTPS `VITE_MESSI_API_BASE_URL`, then browser-smoked against staging. There is no remaining local P0 contract mismatch.

### P1 follow-up: source IDs and StrictMode lifecycle

`../forward-scouting-report/api_server/schemas.py` now declares `PlayerResponse.id` as `Field(gt=0)`. `api_server/service.py` separates source player ID parsing from nullable/unknown asset IDs: non-numeric, fractional, non-finite, zero, or negative source player IDs are fail-closed and their leaderboard rows are omitted rather than coerced to `0`. `../forward-scouting-report/tests/test_api.py` verifies that the API's real IDs are positive and an injected malformed source row produces no invalid DTO.

`src/dashboard/PlayersResourceContainer.test.tsx` renders the real container under React `StrictMode` with the configuration and transport boundaries mocked. It proves that the StrictMode replacement request receives an aborted signal, a stale completion does not render over the surviving completion, and unmount aborts the active request. This uses deferred promises and assertions only—no fake timers.

Follow-up verification: backend `python -m pytest -q` passed **22 tests** (one non-failing pytest cache permission warning); frontend `pnpm test` passed **45 tests** and `pnpm build` passed. P0 remains **0**. The sole remaining P1 is unchanged external deployment configuration: obtain an approved exact staging HTTPS frontend origin, set it only via `MESSI_CORS_ORIGINS`, set the paired exact `VITE_MESSI_API_BASE_URL`, and browser-smoke the deployed binding. No `.env.staging` was created and nothing was deployed.
