# Vercel configuration-error fallback design

## Purpose and non-negotiable behavior

This document defines the client-side fallback shown when the Vite build configuration is not valid for the M.E.S.S.I. 2.0 dashboard. It is a terminal, local configuration state: it must replace the entire dashboard and prevent every API request. In particular, it covers a bundle in which `VITE_MESSI_API_BASE_URL` is absent/blank (`undefined` after Vite replacement) as well as any other parser-rejected `VITE_MESSI_*` value.

The component does not diagnose CORS, an unavailable API, HTTP status, an invalid API payload, or a dashboard rendering exception. Those remain distinct operational failures. A page reload cannot repair values baked into the current bundle; an authorized operator must correct the Vercel build inputs and create a new deployment.

## Placement and component boundaries

### Proposed ownership

`PlayersResourceContainer` is the sole place that evaluates `parseMessiApiConfig(import.meta.env, import.meta.env.MODE)`. Introduce a dedicated presentational `ConfigErrorFallback` alongside the existing dashboard fallback components and select it **before** `DashboardDataFallback` or `MessiScoutingDashboard`.

The container owns only these responsibilities:

- Parse the configuration before constructing a request URL or invoking `fetchPlayers`.
- Map the parser failure to a small, allowlisted diagnostic category.
- Render `ConfigErrorFallback` with that category and safe recovery callbacks.

`ConfigErrorFallback` owns the complete configuration-state screen: copy, diagnostic disclosure, copy-to-clipboard feedback, and focus target. It must not import the API client, parse environment variables, receive a raw environment object, or accept a raw error message/value as a prop. This keeps malformed URLs (including rejected credentials) from ever reaching the DOM or clipboard.

`App` continues to wrap the container in `DashboardErrorBoundary`. The boundary is a last-resort render-exception screen only; it must not be used to classify routine configuration validation failures.

### State precedence

The following precedence is required:

1. If parsing fails, render only `ConfigErrorFallback`.
2. Do not call `fetchPlayers`, do not construct the player endpoint, and do not show loading skeletons, stale rows, controls, compare tray, or a refresh warning.
3. Treat a configuration error as terminal even if an implementation happens to retain a previous payload in memory. It must replace—not be appended above—the dashboard. This preserves the fail-closed requirement.
4. Only after a successful parse may the normal loading, success/empty, refreshing, and data-error states run.

In a production Vite bundle configuration is normally immutable for that page lifetime, so the practical path is initial load. The terminal rule also makes development/HMR and future refactors safe.

## Valid triggering states

Render this fallback only for the allowlisted API configuration validation failures below. Do not infer configuration failure from a network exception or CORS error.

| Safe category | Trigger condition | User-facing diagnostic detail |
| --- | --- | --- |
| `MISSING_API_BASE_URL` | `VITE_MESSI_API_BASE_URL` is missing, `undefined`, or blank after trimming. | “필수 API 주소가 설정되지 않았습니다.” |
| `INVALID_API_ORIGIN` | Base value cannot be parsed as a URL, has a non-origin path, credentials, query, or fragment. | “API 주소 형식이 허용되지 않습니다.” |
| `INSECURE_API_ORIGIN` | In Preview/Production, base URL is not HTTPS; in development, HTTP is not `localhost` or `127.0.0.1`. | “이 환경에서는 보안 HTTPS API 주소가 필요합니다.” |
| `INVALID_DATASET_SETTINGS` | Season is not `YYYY/YYYY`, scope is not 3/5/7, or limit is not an integer from 1 through 1000. | “데이터셋 설정 값이 허용 범위를 벗어났습니다.” |
| `CONFIG_INVALID` | A future, explicitly classified parser validation failure. | “배포 설정을 확인해야 합니다.” |

The first category is required so an undefined Vite base URL has a clear, actionable explanation. If parsing currently exposes only a message, the eventual implementation must derive these categories from controlled validation outcomes rather than display that message.

## Content and Korean UX copy

Use a concise Korean-first screen. English environment-variable names remain literal code identifiers because the deployment owner enters them in Vercel.

1. **Eyebrow/status:** `M.E.S.S.I. 2.0 · DEPLOYMENT CHECK`
2. **Heading (`h1`):** `Config Error (환경 변수 누락)`
3. **Plain-language summary:** `대시보드를 안전하게 시작할 수 없습니다. 이 배포본의 환경 변수 설정을 확인해 주세요.`
4. **Reason line:** use the selected safe category, for example `필수 API 주소가 설정되지 않았습니다.` Never include a raw parser exception or configuration value.
5. **Required-action panel:**
   - Label: `배포 담당자 조치`
   - Body: `Vercel 프로젝트의 Preview 또는 Production 환경에 필요한 VITE_MESSI_* 값을 설정한 뒤 새로 배포하세요. 환경 변수 변경은 이미 배포된 화면에 반영되지 않습니다.`
   - Checklist: `VITE_MESSI_API_BASE_URL`, `VITE_MESSI_SEASON`, `VITE_MESSI_SCOPE`, `VITE_MESSI_LIMIT`
   - Format hint: ``VITE_MESSI_API_BASE_URL`에는 HTTPS origin만 입력합니다. `/api/v1/players`, 경로, 쿼리, 해시, 자격 증명은 넣지 않습니다.`
6. **Support disclosure:** collapsed by default, labelled `안전한 진단 정보 보기`. Its visible contents are `상태: 구성 검증 실패`, the safe category, and `요청 상태: API 요청을 시작하지 않음`.
7. **Primary recovery action:** `문제 정보 복사` copies only the same safe diagnostic text, build mode if it is an allowlisted label (`development`, `preview`, or `production`), and the four variable *names*. Show the temporary confirmation `복사되었습니다. 배포 담당자에게 전달하세요.`
8. **Secondary action:** `새 배포 후 페이지 새로고침` triggers a normal page reload. Place it after the copy action and explain immediately above it: `새 배포가 완료된 경우에만 다시 불러오세요.`

Do not offer `다시 시도`/API retry: it suggests that a client retry could correct a compile-time configuration error and risks accidental request-path regression. Do not show an automatic retry countdown.

## Safe diagnostics and privacy boundary

The fallback may show fixed labels, environment variable names, a safe category, and the statement that no request was sent. It must never render, copy, log to the UI, query-string encode, or expose:

- any raw `import.meta.env` value or key/value dump;
- the parsed/base API URL, rejected URL, hostname, request URL, credentials, query, hash, or parser error text;
- deployment URL, internal identifiers, stack trace, source-map location, tokens, or service credentials.

The approved Render origin is a public build input, but it is not needed to recover from an invalid configuration and should not be repeated by the client error UI. The deployment owner already has the canonical source of truth: `https://forward-scouting-report.onrender.com` as the origin-only value for `VITE_MESSI_API_BASE_URL`. The fallback must never imply that a `VITE_*` variable is secret; it must also never invite users to paste a secret into it.

## Visual system: dark, high-density, calm failure state

Use the dashboard's existing dark field (`#080b0c`), primary text, and bordered dark surfaces so this reads as a contained product state rather than a browser error. Center a single panel inside a full-height main landmark, while keeping its contents left aligned for dense operational scanning.

- **Desktop:** panel width 640–720 px, generous but not oversized outer gutter (24 px), two-column diagnostic/action area only when there is enough room. Keep title, summary, and actions in a single reading order.
- **Surface:** `#101415`-like raised panel, one-pixel low-contrast neutral border, small top accent in amber/orange for “needs deployment action,” not red destructive alarm. Reserve lime only for the available action/focus treatment; it must not convey status alone.
- **Density:** 12–14 px support text, 14–16 px body, strong 24–28 px heading, compact label/value rows, 8 px spacing cadence inside panels and 16–24 px between groups. Use a monospaced treatment only for identifier names/category.
- **Icon:** optional non-essential configuration/sliders glyph; mark it `aria-hidden`. Do not rely on it to communicate failure.
- **Buttons:** full-height touch targets of at least 44 px, visible focus ring, primary outlined/high-contrast copy action followed by a quieter reload action. No destructive coloring or disabled-looking text.

### Responsive behavior

At narrow widths (below the dashboard's `md` table breakpoint), keep the main at least viewport height, use 16 px page padding, make both actions full width and vertically stacked, and allow long variable names to wrap/break without horizontal scrolling. The support disclosure and checklist remain available in the same DOM order. The screen must support 320 CSS px width and 200% browser zoom without clipped content or loss of actions. On wide screens, do not allow the card to become so broad that the diagnostic lines are hard to scan.

## Accessibility and focus

- Render a single `main` landmark and an `h1`; this is not a transient toast.
- Use `role="alert"` or an equivalent assertive live announcement on the concise failure title/summary only. Do not make the full checklist a continuously announced live region.
- On initial entry, programmatically focus the `h1` (with `tabIndex={-1}`) or the alert container, after it is mounted. Do not autofocus the reload button; a deploy correction is required before it is useful.
- Maintain a logical Tab sequence: support disclosure, copy diagnostic action, reload action. The disclosure must expose its expanded/collapsed state to assistive technology.
- Give the copy confirmation a `role="status"`/polite live region and preserve keyboard activation for all controls.
- Meet WCAG 2.2 AA text and focus-indicator contrast; retain at least a 3:1 non-text contrast ratio for borders/focus indication needed to locate controls. Respect `prefers-reduced-motion` and use no essential animation.
- Do not trap focus: this is a route-level replacement, not a modal. Browser navigation, reload, zoom, and screen-reader landmark shortcuts must continue to work.

## Relationship to existing fallbacks

| Condition | UI owner | Expected behavior |
| --- | --- | --- |
| Config parser rejects a Vite value, including undefined API base URL | `ConfigErrorFallback` | Full-screen terminal state; zero API requests; no dashboard/stale data. |
| Valid config; request in progress | `DashboardLoading` | Skeleton-only loading state. |
| Valid config; network, HTTP, or schema error with no saved payload | `DashboardDataFallback` | Existing data-service error UX and retry are appropriate. |
| Valid config; refresh fails with saved payload | `DashboardDataFallback` inline warning | Continue showing previous dataset and offer retry. |
| Valid data but zero players | Existing empty-dataset state | Explain empty data and allow refresh. |
| An unexpected React rendering exception | `DashboardErrorBoundary` | Generic rendering recovery screen; no configuration claim. |

The configuration fallback must not be nested as the inline refresh warning, because an invalid Vite bundle must not render dashboard content. Conversely, `DashboardErrorBoundary` remains outside the resource container so an implementation error in `ConfigErrorFallback` is contained by the generic boundary.

## Recovery and dependency escalation

The in-product recovery is intentionally limited: copy the sanitized evidence, have the deployment owner set the four Vercel environment variables for the applicable environment/branch, redeploy, then reload the new deployment. A reload before a new deployment is harmless but does not solve the faulty bundle.

If the configuration is corrected and the next bundle instead fails to load data due to CORS, use the normal network/data fallback—not this screen. Escalate that separately to the backend/deployment owner: the exact stable Vercel staging origin must be entered in Render's `MESSI_CORS_ORIGINS`, then the deployment must pass the CORS/browser smoke test. This dependency is **P0 for browser-approved staging**, but it is not a client configuration-error trigger.

## Implementation acceptance criteria

An implementation satisfies this design when all of the following are true:

- A missing/blank `VITE_MESSI_API_BASE_URL` renders the exact `Config Error (환경 변수 누락)` heading and a Korean explanation, without any `fetch` call.
- Each parser-rejected category listed above selects the configuration screen; a network/CORS/HTTP/schema failure does not.
- Configuration failure has priority over all dashboard rendering states, including a previous in-memory payload; neither player data nor the dashboard controls are present in the DOM.
- The screen does not display or copy raw environment values, raw errors, URLs, credentials, endpoint paths, request URLs, stack traces, or deployment identifiers. Tests must include a deliberately malformed credential-bearing value and assert none of its substrings occur in rendered/copied output.
- The support disclosure, sanitized diagnostic copy feedback, and reload control work by mouse, keyboard, and touch. The reload action is labelled exactly as a post-redeployment action, and no API retry action is present.
- On entry, focus lands on the failure heading/alert; color, focus, semantic structure, and reduced-motion behavior meet the accessibility requirements above.
- At 320 px and 200% zoom, content and both recovery actions are visible, ordered, and operable without horizontal page scrolling.
- Unit/component tests assert zero calls to `fetchPlayers` on every configuration failure, the safe category mapping, terminal precedence over stale data, Korean copy, focus, and the no-secret/no-raw-value boundary. Visual QA confirms the dark high-density layout at mobile and desktop widths.
- Existing loading, data-error/retry, stale-data warning, empty state, and `DashboardErrorBoundary` tests remain semantically unchanged except where they are explicitly extended to cover the dedicated configuration state.

## P0 finding

There is one deployment P0 outside this UI: browser-approved staging still requires an approved stable Vercel staging origin to be allowlisted exactly in Render's `MESSI_CORS_ORIGINS`. The UI fallback cannot remediate that dependency; it only protects users from invalid baked Vite configuration.
