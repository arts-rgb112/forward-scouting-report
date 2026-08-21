# Bounded player-history summaries

`GET /api/v2/players/{playerId}?includeAnalysis=false` continues to return the
existing `PlayerEnvelope` on success and the existing `404` when a player is
not in a valid static context. This document records its operational contract;
it does not version or extend that DTO.

## Request path

The summary lookup is keyed by the complete identity tuple:

```text
playerId + season + mode + scope + competition
```

`api_server.service._v2_player_summary_index` caches the already-authoritative
`build_v2_players` result as a player-ID map. It never creates scores, ranks,
or players. `tactical_ratio._heatmap_value_offsets` similarly indexes the
deployed heatmap snapshot once per `(mtime_ns, size)` version and lazily decodes
only the selected session array. This replaces the prior behaviour in which
each cohort player scanned the heatmap file from byte zero.

Identical in-flight requests share one threadpool lookup. Distinct contexts
remain isolated; no season, competition, or scope result can be reused across
another tuple.

## Deadline and observability

The server allows at most eight seconds for a basic summary lookup. A lookup
that cannot settle in that time returns HTTP `504` rather than remaining pending.
The successful envelope is unchanged. The bounded error retains FastAPI's
existing `{"detail": "..."}` shape and adds these response headers:

- `X-Request-Id` – caller supplied ID, or an opaque server-generated ID;
- `Retry-After: 2` – safe retry guidance; and
- `Server-Timing: player-summary;dur=<milliseconds>`.

Structured logs include `request_id`, player/context identity,
`phase_cohort_index_ms`, `index_cache`, `shared_inflight`, and `total_ms`.
Timeout logs additionally include `deadline_ms`. They intentionally exclude
credentials and source event payloads.

The deadline protects the browser from an unbounded connection. It does not
pretend that a timed-out CPU task was cancelled: that task remains single-flight
until it completes, then removes its in-flight key. Static snapshot refreshes
normally create a new Render process; file-version cache keys also prevent reuse
after an in-place deployed snapshot change.

## Compatibility

The established player endpoint still accepts the legacy history client shape
`mode=europe&scope=8`; Europe continues to resolve its own target irrespective
of that supplied scope. Strict companion APIs may require omitted Europe scope,
but this compatibility route does not change that behavior. CORS remains the
existing exact Production/immutable Preview allowlist with no wildcard or
credentials.
