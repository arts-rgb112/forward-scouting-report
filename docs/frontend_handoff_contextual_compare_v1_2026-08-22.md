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

Every `resolved` side provides an exact-context `summary`. `detail`, `dataQuality`, and `tacticalQuadrant` are present only when `componentAvailability` marks that component `available`; otherwise they are null and its reason is authoritative. In Europe those three reasons are currently `exact_context_analysis_unavailable`: their source inputs are domestic-only and must never be relabelled as European. A `duel-press-v1` Europe side can still provide exact `duelPressPlayer` and `duelPressDetailReadout` (`detail-readout-v1`), because those builders resolve the selected Europe cohort directly; a `legacy-v1` side has both fields as `null`. The frontend must render server values only, keep zero numeric, preserve null/unavailable/imputed/source states, and perform no cross-side/cohort calculation.

Activation gate: update the strict frontend parser and request client first, then validate this endpoint against the canonical fixture requests and a production/immutable-preview CORS preflight. Existing `GET /api/v2/compare` remains unchanged.
