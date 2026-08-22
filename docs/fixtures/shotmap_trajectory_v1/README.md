# Shotmap trajectory v1 fixtures

`shotmap_points.json` contains, in order, a goal, an on-target shot, an
off-target shot, a blocked shot, and a valid legacy/unavailable-endpoint shot.

The optional `trajectory` object is authoritative only when the source supplies
a complete, in-range endpoint. `null` means no endpoint evidence and must never
be replaced by a client-side estimate. Origin `x`/`y` and endpoint `endX`/`endY`
share the normalized 0..100 attacking-left-to-right pitch space. `endZMeters`
is FotMob goal-crossing height in metres and is always null for blocked shots.

The containing `SpatialAnalysis` contract remains unchanged: an unavailable
snapshot has `shotmapSnapshotAvailable=false`, zero points, and an empty array;
an observed zero-shot snapshot has `shotmapSnapshotAvailable=true`, zero points,
and an empty array. `shotmapPointCount` must equal the array length in both cases.
