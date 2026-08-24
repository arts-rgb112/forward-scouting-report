# API contract notes

## Deferred V2 scoring redesign candidates

The following historical branches are retained as product-decision references only.
They must not be cherry-picked into the current V2 scoring path. Any revival
requires a versioned proposal, cohort recalculation, API/fixture updates, and
separate approval.

- `agent/add-dynamic-spear-weights`: candidate to reconsider role-specific
  S.P.E.A.R. weighting (Type A versus Type B) rather than the current common
  V2 score formula.
- `agent/add-false-nine-penalty`: **conflicts directly with current V2
  policy.** V2 explicitly prohibits a Type B / false-nine penalty, masked box
  score, or score shield. Do not restore this behaviour accidentally; any
  future change requires an explicit product decision and a new versioned
  scoring contract.
- `agent/spear-master-hotfix`: candidate to reconsider the historical
  micro-zone-weighted six-factor S.P.E.A.R. formula. It is not compatible with
  the current V2 Volume x Ratio, combined-duel, forward-press, and source-state
  model without a dedicated redesign.
