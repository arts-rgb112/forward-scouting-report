# contextual-compare-v1 fixtures

These strict request and response fixtures cover the native two-side comparison endpoint.

- `complete_league_europe_request.json` is the canonical mixed-taxonomy League + UCL request.
- `historical_league_request.json` proves independent historical domestic contexts.
- `complete_league_europe_response.json` is a schema-valid resolved mixed League + Europe response.
- `historical_league_response.json` keeps two historical contexts independently addressable.
- `unavailable_sibling_response.json` proves one unavailable side cannot contaminate its resolved sibling.
- `observed_zero_imputed_fallback_response.json` pins the distinct zero, imputed, and fallback readout states.
- `invalid_request_error.json` is the strict error-envelope example for a rejected request.

Response examples are compact, deterministic synthetic values and are validated by
`ContextualCompareEnvelope` in the contract suite. They intentionally omit large spatial
point arrays and tactical-quadrant cohort points; production responses may include those
server-owned fields when available. The API preserves request side order; it canonicalises
inactive response dimensions to `null` (League `competition`, Europe `scope`).
