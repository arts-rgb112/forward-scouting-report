# M.E.S.S.I. 2.0 Vercel staging deployment specification

## Decision and release status

- **Frontend:** Vercel static Vite deployment from this directory (`messi-2-dashboard`).
- **Target API origin (approved input):** `https://forward-scouting-report.onrender.com`
- **Target request:** `GET https://forward-scouting-report.onrender.com/api/v1/players?season=2025%2F2026&scope=7&limit=1000`
- **Staging status:** source configuration is ready for a Vercel build, but deployment is not browser-approved until the exact Vercel staging origin is added to the Render service's CORS allowlist and a new build has been smoke-tested.

The supplied API value is valid for this application: it is HTTPS; has an origin-only path (`/`); and contains no credentials, query string, or fragment. It must be entered exactly as above, without `/api/v1/players`, a trailing path, URL parameters, or credentials.

## Repository facts

- `package.json` requires Node `>=20.19.0`, uses pnpm lockfile v9, and has no `packageManager` pin.
- The canonical production build is `pnpm build`, which runs `tsc -b && vite build --configLoader runner`.
- `vite.config.ts` uses the standard React and Tailwind plugins without a custom `outDir`; Vite output is therefore `dist`.
- There is no `vercel.json`, no Vite proxy, and no client-side router found in `src`. The browser calls the Render API directly with an absolute URL.
- `.env.development` is intentionally local-only (`http://localhost:8000`). `.env.example` is a template only. `.gitignore` excludes `dist/`, `.env`, `.env.local`, and `*.local` overrides.
- The checked-in `dist/` is not a deployable source of truth: it is an earlier build whose Vite environment object does not contain `VITE_MESSI_API_BASE_URL`. Vercel must build from source after environment variables are configured; do not upload or deploy this existing `dist` manually.

## Vercel project settings

Import the repository/project with this frontend directory as the **Root Directory**. Select the Vite framework preset if offered, then explicitly verify these values:

| Setting | Required value | Reason |
| --- | --- | --- |
| Node.js Version | `24.x` | Supported by Vercel and satisfies `>=20.19.0`. Pin the Vercel project setting to avoid relying on a changing default. |
| Package manager | pnpm | `pnpm-lock.yaml` lockfile v9 is present. |
| pnpm version | `11.16.0` for a repeatable first staging deploy | This is the installed project validation version. Because `package.json` has no `packageManager` field, record/pin the version in Vercel's build setup or add a project-level package-manager pin in a separately approved code change. |
| Install Command | `pnpm install --frozen-lockfile` | Uses the committed lockfile and fails on dependency drift. |
| Build Command | `pnpm build` | Runs TypeScript project build and Vite production bundle. |
| Output Directory | `dist` | Vite default; deploy the new build output only. |
| Development Command | `pnpm dev` (optional) | Matches the package script. |

Vercel currently supports Node `24.x`, `22.x`, and `20.x`; use its documented **Project Settings → Build and Deployment → Node.js Version** control. Vercel's current documentation says a compatible `engines.node` range can override the dashboard selection, and this repository's `>=20.19.0` range resolves to the latest available major. Selecting `24.x` makes the intent explicit. See [Supported Node.js versions](https://vercel.com/docs/functions/runtimes/node-js/node-js-versions) and [Build image overview](https://vercel.com/docs/builds/build-image).

## Environment variables (build inputs)

In **Project Settings → Environment Variables**, configure these exact non-secret values before deploying:

| Name | Preview / staging | Production | Notes |
| --- | --- | --- | --- |
| `VITE_MESSI_API_BASE_URL` | `https://forward-scouting-report.onrender.com` | `https://forward-scouting-report.onrender.com` only if Production is intentionally bound to this same API | Required. Do not use the placeholder or append `/api/v1/players`. |
| `VITE_MESSI_SEASON` | `2025/2026` | `2025/2026` | Required by parser. |
| `VITE_MESSI_SCOPE` | `7` | `7` | Required by parser; allowed values are 3, 5, 7. |
| `VITE_MESSI_LIMIT` | `1000` | `1000` | Required by parser; integer range is 1–1000. |

Recommended staging workflow:

1. Set all four variables for **Preview**, restricted to the staging branch if the team uses branch-specific Preview variables. A non-production branch produces a Vercel Preview deployment.
2. Use the stable branch preview URL or a dedicated custom `staging` environment/domain for CORS. Do **not** allow every ephemeral commit URL merely to make Preview work.
3. Set the same values for **Production** only when production should deliberately call this Render origin. If production has a distinct API, use its separately approved HTTPS origin; never promote the Preview bundle because Vite variables are baked into that bundle.
4. Redeploy after every Vercel environment-variable change. Vercel applies such changes only to new deployments.

Vite replaces `import.meta.env.VITE_*` during `pnpm build`. The deployed static JavaScript therefore contains this API origin; this is correct for a public API base URL, but it is **not secret storage**. Never put a token, service credential, or private backend value in any `VITE_*` variable. This app has no runtime configuration endpoint: changing an environment variable after deployment does not change an already deployed bundle. Rebuild/redeploy is required.

The parser in `src/api/env.ts` is a fail-closed configuration guard. Missing variables, a placeholder/non-URL, a non-origin path, credentials, query/hash, invalid season/scope/limit, or non-local HTTP all lead to the dashboard's configuration fallback instead of an API call. Its production/Preview mode requires HTTPS; only development mode permits `http://localhost` or `http://127.0.0.1`.

For Vercel environment scope semantics, see [Vercel environment variables](https://vercel.com/docs/environment-variables) and [Vercel environments](https://vercel.com/docs/deployments/environments).

## Routing and rewrites

**No SPA rewrite is required for the current application.** It has no React Router routes; `/` is the only application entry, and the API is called cross-origin at an absolute Render URL. Do not add an external `/api` rewrite to Vercel: it would alter the direct-browser/CORS architecture documented by the API binding.

If future work adds browser-navigable client routes (for example `/players/123`), add the usual Vite SPA fallback only then, preserving real static assets and API paths. A minimal future `vercel.json` rewrite would be reviewed alongside the router change; it is intentionally not added now. Vercel rewrites can route requests without changing the visible URL; see [Vercel rewrites](https://vercel.com/docs/routing/rewrites).

## Render CORS handoff (blocking integration gate)

Before browser QA, the backend/deployment owner must supply and configure the **one canonical HTTPS frontend origin**, for example a stable Vercel staging domain:

```text
MESSI_CORS_ORIGINS=https://<approved-staging-domain>
```

Use the exact origin only: scheme + hostname + optional non-default port, no path and no trailing wildcard. The backend uses an exact comma-separated allowlist. Do not use `*`, a broad Vercel wildcard/regex, a lookalike host, or a commit-specific preview hostname that changes on every deployment. Keep the existing localhost development/preview values only if they remain explicitly intended by the backend configuration.

The CORS policy must permit the frontend's credential-free `GET` request and its preflight where applicable, return `Access-Control-Allow-Origin` matching the canonical staging origin, and omit that header for hostile origins such as `https://<approved-staging-domain>.evil.example` or `https://evil-<approved-staging-domain>`. CORS is not authentication; apply Render/edge access policy separately if the API must not be public.

This exact-origin handoff is still required even though the Render API URL is now known. The API origin and frontend origin are different inputs: the first is compiled into the Vite bundle; the second is accepted by Render CORS.

## Build and post-deployment acceptance criteria

### Build acceptance

Vercel build logs must show a clean `pnpm install --frozen-lockfile` followed by `pnpm build`, including successful TypeScript compilation and Vite output to `dist`. The deployment artifact must contain:

- `dist/index.html` that refers to hashed `/assets/...` resources, never `/src/main.tsx`.
- The matching hashed JavaScript/CSS assets referenced by that HTML.
- The exact configured API origin in the built JavaScript, verified without exposing any secret. A build-log/script check can search the output for `https://forward-scouting-report.onrender.com` and assert that placeholder text is absent.
- No sample/mock markers listed in the existing API-binding spec (including `samplePlayers` and `placehold.co`) in `dist`.

An indicative post-build check, to run in controlled CI or locally against the freshly built directory, is:

```powershell
rg -n -F '/src/main.tsx' dist
rg -n -F 'https://forward-scouting-report.onrender.com' dist
rg -n -F 'https://api.example.com' dist
```

The first and third commands must return no matches; the second must find the injected origin. Also visually confirm that the configured-value field contains the approved Render origin, not any unresolved handoff placeholder. Do not treat a previously committed `dist` result as evidence—the checks must run after the Vercel-configured build.

### Browser/API smoke acceptance

After the stable staging frontend origin is allowlisted in Render:

1. Open the Vercel staging URL over HTTPS. Confirm assets load, the dashboard does not show the configuration fallback, and DevTools shows no mixed-content or CORS error.
2. Confirm the browser requests exactly `https://forward-scouting-report.onrender.com/api/v1/players?season=2025%2F2026&scope=7&limit=1000`, uses `GET`, `Accept: application/json`, and omits credentials.
3. From the approved frontend `Origin`, verify Render preflight/GET returns `Access-Control-Allow-Origin` for that exact origin. From a hostile lookalike origin, verify no allow-origin header is returned.
4. Confirm the real response passes the strict frontend schema and renders data; verify an intentional invalid/missing build variable yields the local configuration fallback rather than a malformed request.
5. Record the Vercel deployment URL, immutable commit SHA, Render URL, canonical allowed frontend origin, timestamp, and build log link in the release ticket.

## Approval / input required

The API endpoint is no longer missing: `https://forward-scouting-report.onrender.com` is a valid, deployable value and is a **P0 build-input requirement** for every Preview/Production bundle that should load real data. It is safe to configure now as a public `VITE_*` value.

Deployment remains blocked pending approval/input of the canonical Vercel staging frontend origin and authority to set it in Render's `MESSI_CORS_ORIGINS`. Once that origin is approved, configure the Preview variables, deploy a new build, and complete the CORS/browser smoke criteria above. Production scope additionally needs an explicit decision whether this same Render API is approved for production traffic.
