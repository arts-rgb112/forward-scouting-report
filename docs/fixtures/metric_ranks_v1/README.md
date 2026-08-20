# metric-ranks-v1 frontend fixtures

- `valid_response.json`: populated `duel-press-v1` all-cohort rank response.
- `null_metric.json`: valid future-proof resolved response where every source metric is unavailable (`rank: null`, `population: 0`).
- `invalid_extra_field.json`: must fail strict parsing because top-level extra fields are forbidden.

Values in these fixtures are contract examples, not a promise that a live cohort retains the same rank after a dataset refresh.
