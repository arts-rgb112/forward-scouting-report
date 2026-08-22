# duel-press-v2 fixture contract

These fixtures exercise the versioned stat-pairs-v2 API trio.  Every response
uses `metricTaxonomyVersion: "duel-press-v2"`,
`readoutVersion: "detail-readout-v2"`, `ratingVersion: "stat-pairs-v2"`, and
one exact `ratingSnapshotId` across the board, player and detail resources.

The executable fixture source is
`docs/fixtures/duel_press_detail_readouts/complete_static_record.json` and
the focused coverage is in `tests/test_duel_press_detail_readouts.py`:

- league and Europe context canonicalisation;
- scores at both `0` and `99`, including lower-is-better losses;
- observed zero versus unavailable rate-derived fields;
- an imputed category score and conservative missing-component floor;
- ground/aerial and combined duel pairs;
- `league_per90_fallback` press provenance;
- context indicators with raw tooltip inputs;
- 50-row board pagination/filter/sort metadata and snapshot parity;
- malformed snapshot rejection and strict OpenAPI schemas.

`complete_static_record.json` is deliberately an input-frame fixture rather
than a frozen output: the snapshot ID is a content hash and must be regenerated
when the canonical static cohort changes.

Canonical JSON response fixtures are committed separately:
`complete_league.json`, `complete_europe.json`, `observed_zero.json`,
`unavailable.json`, `partial_pair.json`, and `imputed_lower_better.json`.
Each has a `responses` object with complete `leaderboard`, `player`, and
`detail` endpoint JSON, each independently strict-model-valid. All three root
responses carry `schemaVersion: "2.0.0"`; v1 responses remain unchanged.

Run `python scripts/generate_duel_press_v2_fixtures.py` from the repository
root to regenerate them deterministically from the checked-in player/detail
inputs. The focused test model-validates every endpoint payload and checks the
round-tripped JSON, so an omitted, widened, or extra field fails release QA.

## Canonical endpoints

| URL | Query | Success | Errors |
| --- | --- | --- | --- |
| `GET /api/v2/leaderboards/duel-press-v2` | `season`, `mode`, domestic `scope`, `competition`, `page`, fixed `pageSize=50`, `sort`, `order`, `role`, `position`, `ageBand`, `minutesBand`, `q` | `200` ordered page, canonical filter metadata | `404` static season/Europe cohort unavailable; `422` invalid query/mode-competition combination |
| `GET /api/v2/players/{id}/duel-press-v2` | same context fields | `200` one server-rated profile | `404`, `422` as above |
| `GET /api/v2/players/{id}/duel-press-v2/detail-metrics` | same context fields | `200` exact paired raw readout | `404`, `422` as above |

Domestic responses echo `scope` and `competition: null`; Europe responses echo
`scope: null` and their selected competition.  The board context never carries
a fake player ID.  All GET responses have the companion public cache policy and
the existing production plus immutable Vercel Preview CORS GET/OPTIONS policy
(`allow_credentials=false`).

`pairState` is exact: `complete` has numeric total and `/90`; `partial` has an
observed/derived total and unavailable `/90` with
`pairReason: "minutes_unavailable_or_nonpositive"`; `unavailable` has both
values unavailable and `pairReason: "source_unavailable"`.  Scalar metrics use
`pairState: "scalar"`.  Every numeric datum and displayed rating exposes a
server-authored `percentileScore` in the inclusive 0–99 range.
