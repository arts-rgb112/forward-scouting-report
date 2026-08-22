# Frontend handoff: contextual-compare-v1

Backend candidate: `POST /api/v2/compare/contextual`.

Send exactly two independently selected sides:

```json
{
  "comparisonVersion": "contextual-compare-v1",
  "left": {"player": {"idNamespace": "fotmob", "playerId": 194165}, "taxonomy": "duel-press-v1", "context": {"season": "2025/2026", "mode": "league", "scope": 8, "competition": "all"}},
  "right": {"player": {"idNamespace": "fotmob", "playerId": 194165}, "taxonomy": "legacy-v1", "context": {"season": "2025/2026", "mode": "europe", "scope": null, "competition": "ucl"}}
}
```

The response preserves `left`/`right` order and echoes identity, taxonomy, and canonical context. League responses use `competition: null`; Europe responses use `scope: null`. Each side is independently `resolved`, `unavailable`, or `invalid_context`; never copy a resolved sibling into an unavailable side.

`resolved` sides always provide `detail` (including authoritative analysis/spatial data) and `dataQuality`. `tacticalQuadrant` is an independently computed companion and is present only when its two server-owned axes are available; its absence must not downgrade the side. A `duel-press-v1` side additionally provides `duelPressPlayer` and exact `duelPressDetailReadout` (`detail-readout-v1`); a `legacy-v1` side has both fields as `null`. The frontend must render server values only, keep zero numeric, preserve null/unavailable/imputed/source states, and perform no cross-side/cohort calculation.

Activation gate: update the strict frontend parser and request client first, then validate this endpoint against the canonical fixture requests and a production/immutable-preview CORS preflight. Existing `GET /api/v2/compare` remains unchanged.
