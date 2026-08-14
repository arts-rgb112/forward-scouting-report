# Backend request: strict shotmap contract alignment

The frontend now rejects malformed player-detail and comparison shotmap payloads rather than silently replacing them with an empty shotmap.

Please align the OpenAPI schema, Pydantic models, and service implementation to:

- preserve and validate every source shotmap record, or explicitly expose a service error;
- enforce `shotmapPointCount == len(shotmapPoints)`;
- document the difference between unavailable snapshots (`shotmapSnapshotAvailable: false`) and available-but-empty snapshots (`true` with an empty array); and
- add contract tests for valid populated, valid unavailable, valid available-empty, and malformed shotmap payloads.
