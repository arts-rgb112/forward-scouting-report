# Vercel staging implementation handoff

## Scope completed

The Vite frontend now has a checked-in, non-secret staging build input and a fail-closed configuration screen. No external Vercel or Render deployment was performed.

### Staging build inputs and Vercel behavior

- `.env.staging` supplies the approved public build inputs for `pnpm build:staging`:
  - `VITE_MESSI_API_BASE_URL=https://forward-scouting-report.onrender.com`
  - `VITE_MESSI_SEASON=2025/2026`
  - `VITE_MESSI_SCOPE=7`
  - `VITE_MESSI_LIMIT=1000`
- `package.json` adds `build:staging`, which runs the existing TypeScript build followed by `vite build --mode staging --configLoader runner`.
- Vercel should still use the canonical `pnpm build` command and bind the same four variables in Project Settings. Vite gives pre-existing process environment variables priority over `.env.*` files, so the Vercel binding is authoritative. The regular production build has no code fallback to the Render origin.
- No `vercel.json` was added. The app has no browser-routable SPA paths and calls the absolute Render URL from the browser, so an SPA rewrite or `/api` proxy would be incorrect.

### Terminal configuration fallback

- `src/api/env.ts` exports `MessiConfigError` and a closed `ConfigErrorCategory` set. The parser classifies missing base URL, invalid origin, insecure origin, and invalid dataset inputs without retaining a raw input in the error message.
- `src/dashboard/PlayersResourceContainer.tsx` parses Vite configuration once before its request lifecycle. A parser rejection renders `ConfigErrorFallback` immediately; it does not enter loading, call `fetchPlayers`, construct an endpoint, display stale data, or expose the ordinary data fallback/retry flow. Network, HTTP, schema, and React render errors retain their existing separate paths.
- `src/dashboard/components/ConfigErrorFallback.tsx` is presentational and takes only an allowlisted category and build mode. It has the specified Korean-first terminal screen, heading focus, a disclosure with `details`, 44px actions, no API retry, a post-redeployment reload action, and a clipboard diagnostic containing only fixed text, a safe category/mode, and variable names. It never receives or renders raw env values, URLs, parser messages, request paths, or credentials.

## Changed files

| File | Change |
| --- | --- |
| `.env.staging` | Public staging Vite inputs for the approved Render origin, season, scope, and limit. |
| `package.json` | Adds `build:staging`; no dependency or lockfile change. |
| `src/api/env.ts` | Adds typed, safe parser categories and classifies all config validation errors. |
| `src/dashboard/PlayersResourceContainer.tsx` | Makes config parsing terminal and prior to fetch/render lifecycle. |
| `src/dashboard/components/ConfigErrorFallback.tsx` | Adds accessible, sanitized configuration-error UI. |
| `src/api/env.test.ts` | Verifies category classification. |
| `src/dashboard/PlayersResourceContainer.test.tsx` | Verifies no fetch for all configuration categories, terminal UI, focused heading, and credential-string privacy boundary. |
| `src/dashboard/components/ConfigErrorFallback.test.tsx` | Verifies focused heading and safe clipboard content/feedback. |

## Local validation run

The shell initially lacked `node` on PATH; rerunning with the installed `C:\Program Files\nodejs` path completed normally.

1. `pnpm test` — passed: 11 test files, 55 tests.
2. `pnpm build:staging` — passed; generated `dist/index.html`, `dist/assets/index-CyE0V9Ge.css`, and `dist/assets/index-DY316599.js`.
3. `pnpm build` with the four Vercel-equivalent `VITE_MESSI_*` process environment variables — passed; generated `dist/index.html`, `dist/assets/index-CyE0V9Ge.css`, and `dist/assets/index-i-AFrKZ9.js`.
4. After each build, scans confirmed:
   - no `/src/main.tsx` in `dist`;
   - `https://forward-scouting-report.onrender.com` exists in the bundle;
   - no `samplePlayers`, `placehold.co`, or `https://api.example.com` marker exists in `dist`.

## Remaining release gates / limitations

- **P0 for browser-approved staging:** an approved stable Vercel staging origin must be added exactly to Render `MESSI_CORS_ORIGINS`, then a newly built deployment must pass browser/CORS smoke testing. This client change cannot perform or validate that external operation.
- **P1 deployment setup:** configure the documented Vercel project settings (Root Directory, Node 24.x, pnpm 11.16.0, frozen-lockfile install, `pnpm build`, `dist`) and bind all four Preview variables, branch-scoped if appropriate. Production needs a separate deliberate API-origin decision.
- No deployment URL, Render configuration change, or browser smoke result is available because no external deployment was authorized.
