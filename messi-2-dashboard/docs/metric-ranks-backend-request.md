# Metric-ranks companion API — frontend integration fulfilled

The deployed `POST /api/v2/metric-ranks` companion contract is now consumed by
the React dashboard. This document replaces the pre-deployment request.

## Production contract

Request bodies are **entries only**; they do not contain `schemaVersion`.
Only `duel-press-v1` targets are sent. Legacy Watchlist snapshots are never
requested or relabelled.

```json
{
  "entries": [{
    "key": "stable-exact-context-key",
    "player": { "idNamespace": "fotmob", "playerId": 194165 },
    "metricTaxonomyVersion": "duel-press-v1",
    "context": {
      "season": "2025/2026",
      "mode": "league",
      "scope": 8,
      "competition": "all"
    }
  }]
}
```

- Each batch contains 1–50 unique entries; `key` has a maximum length of 500.
- Responses have `schemaVersion: "1.0.0"`, preserve request order, and echo
  the exact key, FotMob identity, taxonomy, and context for every result.
- The strict frontend parser rejects extra fields, missing/duplicate/reordered
  results, legacy taxonomy, or any identity/context/taxonomy mismatch.

## Frontend behavior

- The visible leaderboard sends at most its displayed 50 players, using the
  canonical server dataset season/mode/scope/competition context.
- Watchlist requests include only visible `duel-press-v1` entries whose display
  preference is current and whose exact resolver response succeeded. Selecting
  the saved snapshot immediately removes current metric ranks.
- Cache identity includes API origin, key, player, taxonomy, and exact context;
  batches are deduped, in-flight requests are shared, and stale requests abort.
- Companion failures are non-blocking. Existing rows remain visible and metric
  tooltips state that the overall rank is unavailable.
- Tooltip text uses `82/100 · 전체 14위 / 673명`; score bands remain color and
  accessibility semantics only, never a visible `80–89` slot.

No backend, legacy DTO, Watchlist snapshot, or `app.py` migration is required
for this frontend integration.
