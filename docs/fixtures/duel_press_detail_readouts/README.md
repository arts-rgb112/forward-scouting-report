# detail-readout-v1 fixtures

`complete_static_record.json` is a static-frame fixture used to exercise the
complete league readout: all thirteen retained legacy bars, the ground/aerial
split, spatial inputs, and both forward-press source variants. The focused
contract test combines it with the established FotMob identity fixture.

Malformed discriminator, readout version, extra-property, and null/state
combinations are generated from the complete validated envelope in
`tests/test_duel_press_detail_readouts.py` so every negative case begins from
the same strict payload shape.
