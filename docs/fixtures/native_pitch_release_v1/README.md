# Native pitch production release fixtures

These five complete response payloads are captured from the real production
`api_server.main:app` through an in-process ASGI client. No external HTTP,
SportsAPI call, sibling checkout, `messi-specs`, or raw harvest is required.
Only the release's shipped `data/pitch-native-v2` and existing release cohort,
mapping, and legacy shot snapshots are read. The legacy box endpoint stays
separate; native display-box statistics are nested in each native envelope.

Context: player 194165, season 2025/2026, league, scope 8, wire competition=all.
The existing strict router normalizes league competition to null internally.
Native and body endpoints each cover PK included/excluded. Expected native
counts are 119 shots/36 goals and 108 shots/26 goals, respectively. The native
snapshot revision is identical across those filters. Unavailable values remain
null, and observed trajectory height stays null; no physical motion is inferred.

`provenance.json` pins the exact source-index SHA256, provider source SHA256,
artifact source revision, native canonical snapshot revision, and every fixture's
canonical UTF-8 bytes/SHA256. JSON keys are sorted; arrays retain API order.

From the repository root:

```text
python docs/fixtures/native_pitch_release_v1/validate.py
python -m pytest tests/test_native_pitch_release_fixtures.py -q
```

Missing v2 artifacts or changed pinned results fail; they never silently skip.
`--write` is an explicit initial-capture option and refuses to overwrite a
different existing fixture. Future intentional revisions need reviewed fixtures,
not automatic baseline replacement.

Historical external-fixture tests remain separate optional local audits:
`test_native_body_part_sources.py`, `test_native_pitch_events_core.py`,
`test_native_pitch_events_contract.py`, and `test_native_body_part_router.py`
reference saved raw sources; `test_pitch_snapshot_provider.py` additionally
compares sibling raw storage and locally retained v1. This mandatory release test
does not depend on those optional sources, and v1 must not be shipped alongside v2.
