import { describe, expect, it } from "vitest"; import shotmapTrajectoryV1 from "../test/fixtures/shotmapTrajectoryV1.json"; import { adaptAnalysis, adaptEnvelope } from "./adapter"; import { parsePlayersEnvelope, playerDetailEnvelopeSchema, playerDtoSchema, playerSummaryEnvelopeSchema } from "./contracts";
const asset = { id: 1, name: "Asset", icon: null }; const player = { id: 1, rank: 3, name: "Player", position: "CF", archetype: "Type A", age: null, minutes: 1000, tier: { code: "iron", level: 5, label: "Iron V" }, score: 70, face: null, nation: null, league: asset, club: asset, stats: { outsideShot: 1, boxThreat: 2, dangerZone: 3, aerial: 4, groundDuel: 5, spaceControl: 6 } }; const envelope = { data: [player], meta: { schemaVersion: "1.0.0", season: "2025/2026", scope: 7, population: 1, returned: 1, generatedAt: "2026-08-10T12:00:00+09:00", source: "messi-static-cohort" } };
describe("strict v1 contract", () => { it("accepts nullable fields and all six sectors", () => expect(parsePlayersEnvelope(envelope, { season: "2025/2026", scope: 7 }).data[0].tier.level).toBe(5)); it("rejects extra and old metric keys", () => expect(() => parsePlayersEnvelope({ ...envelope, data: [{ ...player, stats: { ...player.stats, pressing: 10 } }] }, { season: "2025/2026", scope: 7 })).toThrow()); it("rejects request metadata mismatch", () => expect(() => parsePlayersEnvelope(envelope, { season: "2024/2025", scope: 7 })).toThrow()); it("rejects duplicate ranks", () => expect(() => parsePlayersEnvelope({ ...envelope, data: [player, { ...player, id: 2 }], meta: { ...envelope.meta, returned: 2, population: 2 } }, { season: "2025/2026", scope: 7 })).toThrow()); it("rejects non-HTTPS assets", () => expect(() => parsePlayersEnvelope({ ...envelope, data: [{ ...player, face: "http://images.test/p.png" }] }, { season: "2025/2026", scope: 7 })).toThrow()); });

describe("tier taxonomy transport", () => { it("carries an explicit response taxonomy to each player without assigning one when absent", () => { const legacy = adaptEnvelope(parsePlayersEnvelope(envelope, { season: "2025/2026", scope: 7 })); expect(legacy.players[0].tier.taxonomyVersion).toBeUndefined(); const crystalEnvelope = { ...envelope, tierTaxonomyVersion: "crystal-v2", data: [{ ...player, tier: { ...player.tier, code: "emerald", label: "Emerald" } }] }; const crystal = adaptEnvelope(parsePlayersEnvelope(crystalEnvelope, { season: "2025/2026", scope: 7 })); expect(crystal.players[0].tier).toMatchObject({ code: "emerald", label: "Emerald", taxonomyVersion: "crystal-v2" }); }); });

describe("player summary contract", () => {
  it("accepts the strict namespace-free summary and optional current taxonomy", () => expect(playerSummaryEnvelopeSchema.parse({ data: player, tierTaxonomyVersion: "crystal-v2" }).tierTaxonomyVersion).toBe("crystal-v2"));
  it("rejects detail-only namespace and unknown fields", () => {
    expect(playerSummaryEnvelopeSchema.safeParse({ data: { ...player, idNamespace: "fotmob" } }).success).toBe(false);
    expect(playerSummaryEnvelopeSchema.safeParse({ data: { ...player, unknown: true } }).success).toBe(false);
    expect(playerSummaryEnvelopeSchema.safeParse({ data: player, unknownEnvelopeField: true }).success).toBe(false);
  });
});

describe("detail spatial contract", () => {
  const ids = ["outsideShot", "boxThreat", "dangerZone", "aerial", "groundDuel", "spaceControl"];
  const axes = ids.map((id) => ({ id, label: id, score: 50, percentile: 50, rank: 5, population: 10, rawValue: 1, tier: "B", imputed: false }));
  const rawMetrics = Object.fromEntries(["goals", "xg", "xgot", "minutesPlayed", "dribblesSucceeded", "dribblesSuccessRate", "dispossessed", "foulsWon", "penaltiesAwarded", "duelsWon", "duelsWonPercentage", "aerialDuelsWon", "aerialDuelsWonPercentage", "inBoxGoals", "inBoxXg", "inBoxXgot", "inBoxShots", "outBoxGoals", "outBoxXg", "outBoxXgot", "outBoxShots"].map((key) => [key, null]));
  const positionalGrid = Array.from({ length: 30 }, (_, index) => ({ depth: Math.floor(index / 5) + 1, lane: index % 5 + 1, occupancyPct: index === 27 ? 12.5 : 0 }));
  const trueCore = { available: true, gridVersion: "positional-6x5-v1", definitionVersion: "true-core-50-v1", targetDensityPct: 50, achievedDensityPct: 52.5, zoneIds: ["depth6_lane3"], zoneCount: 1, coreAreaPct: 8.33, tieBreak: "density-desc-depth-asc-lane-asc", zones: [{ id: "depth6_lane3", depth: 6, lane: 3, densityPct: 52.5, areaPct: 8.33 }] };
  const continuousCore = { available: true, definitionVersion: "continuous-hdr-50-v1", targetDensityPct: 50, achievedDensityPct: 52.5, coreAreaPct: 7.2, densityThreshold: 0.1, thresholdOfPeak: 0.5, gridColumns: 32, gridRows: 22 };
  const validSpatial = { available: true, source: "messi-static-cohort", heatmapPointCount: 30, heatmapPoints: [], shotmapPointCount: 1, shotmapPoints: [{ x: 50, y: 40, outcome: "goal", xg: 0.4, xgot: null }], shotmapSnapshotAvailable: true, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [20, 20, 20, 20, 20], depthRatios: [10, 15, 20, 20, 15, 20], positionalGrid, trueCore, continuousCore, dangerZoneDensity: null, deepBoxZoneScore: null };
  const detail = (spatial: unknown = validSpatial) => ({ data: { ...player, idNamespace: "fotmob", analysis: { score: { value: 50, rank: 5, topPercent: 50, population: 10, archetype: "Type A" }, volumeRadar: { kind: "volume", axes }, ratioRadar: { kind: "ratio", axes }, rawMetrics, spatial } } });

  it("accepts depth ratios, the complete positional occupancy grid, and server-owned True Core cells", () => {
    const parsed = playerDetailEnvelopeSchema.parse(detail()); const analysis = parsed.data.analysis!; const cloned = adaptAnalysis(analysis); const sourceCore = analysis.spatial.trueCore; const clonedCore = cloned.spatial.trueCore;
    expect(sourceCore).toMatchObject({ zoneIds: ["depth6_lane3"], achievedDensityPct: 52.5, coreAreaPct: 8.33 }); expect(clonedCore.zones).not.toBe(sourceCore.zones); expect(clonedCore.zones[0]).not.toBe(sourceCore.zones[0]); expect(cloned.spatial.shotmapPoints).not.toBe(analysis.spatial.shotmapPoints);
  });

  it("accepts fixed-N CCA provenance while retaining the frozen v1 shape", () => {
    const fixedNCore = { ...continuousCore, definitionVersion: "fixed-n60-r20-v2", formulaVersion: "fixed-n60-r20-v2", ccaAreaPct: 7.2, standardizedTarget: 7.25, quantizationDelta: 0.05, containedMassPct: 52.5, validPointCount: 180, lowSample: false };
    expect(playerDetailEnvelopeSchema.safeParse(detail({ ...validSpatial, continuousCore: fixedNCore })).success).toBe(true);
    const { lowSample: _lowSample, ...missingProvenance } = fixedNCore;
    expect(playerDetailEnvelopeSchema.safeParse(detail({ ...validSpatial, continuousCore: missingProvenance })).success).toBe(false);
    expect(playerDetailEnvelopeSchema.safeParse(detail({ ...validSpatial, continuousCore: { ...fixedNCore, ccaAreaPct: 7.1 } })).success).toBe(false);
  });

  it("accepts the live namespaced detail shape without widening shared leaderboard rows", () => {
    const live = detail();
    expect(playerDetailEnvelopeSchema.safeParse(live).success).toBe(true);
    expect(playerDetailEnvelopeSchema.safeParse({ ...live, data: { ...live.data, idNamespace: "other" } }).success).toBe(false);
    const { idNamespace: _namespace, ...missingNamespace } = live.data;
    expect(playerDetailEnvelopeSchema.safeParse({ ...live, data: missingNamespace }).success).toBe(false);
    expect(playerDetailEnvelopeSchema.safeParse({ ...live, data: { ...live.data, unknownDetailField: true } }).success).toBe(false);
    expect(playerDtoSchema.safeParse({ ...player, idNamespace: "fotmob" }).success).toBe(false);
  });

  it("accepts a valid unavailable snapshot and an available zero-shot snapshot", () => {
    expect(playerDetailEnvelopeSchema.parse(detail({ ...validSpatial, shotmapPointCount: 0, shotmapPoints: [], shotmapSnapshotAvailable: false })).data.analysis?.spatial.shotmapSnapshotAvailable).toBe(false);
    expect(playerDetailEnvelopeSchema.parse(detail({ ...validSpatial, shotmapPointCount: 0, shotmapPoints: [], shotmapSnapshotAvailable: true })).data.analysis?.spatial.shotmapPoints).toEqual([]);
  });

  it("accepts legacy, null, goal-mouth, and blocked trajectory variants and deep-clones source trajectories", () => {
    const goalTrajectory = { schemaVersion: "shotmap-trajectory-v1", endpointKind: "goal_mouth", endX: 100, endY: 48, endZMeters: 1.4, source: "fotmob" };
    const blockedTrajectory = { schemaVersion: "shotmap-trajectory-v1", endpointKind: "blocked", endX: 78, endY: 43, endZMeters: null, source: "fotmob" };
    expect(playerDetailEnvelopeSchema.safeParse(detail()).success).toBe(true);
    expect(playerDetailEnvelopeSchema.safeParse(detail({ ...validSpatial, shotmapPoints: [{ ...validSpatial.shotmapPoints[0], trajectory: null }] })).success).toBe(true);
    const parsedGoal = playerDetailEnvelopeSchema.parse(detail({ ...validSpatial, shotmapPoints: [{ ...validSpatial.shotmapPoints[0], trajectory: goalTrajectory }] }));
    const cloned = adaptAnalysis(parsedGoal.data.analysis!);
    expect(cloned.spatial.shotmapPoints[0].trajectory).toEqual(goalTrajectory);
    expect(cloned.spatial.shotmapPoints[0].trajectory).not.toBe(parsedGoal.data.analysis!.spatial.shotmapPoints[0].trajectory);
    expect(playerDetailEnvelopeSchema.safeParse(detail({ ...validSpatial, shotmapPoints: [{ x: 70, y: 40, outcome: "blocked", trajectory: blockedTrajectory }] })).success).toBe(true);
  });

  it("accepts the authoritative backend shotmap-trajectory-v1 fixture unchanged", () => {
    const parsed = playerDetailEnvelopeSchema.parse(detail({ ...validSpatial, shotmapPointCount: shotmapTrajectoryV1.length, shotmapPoints: shotmapTrajectoryV1 }));
    expect(parsed.data.analysis?.spatial.shotmapPoints).toEqual(shotmapTrajectoryV1);
  });

  it.each([
    ["trajectory extra field", { schemaVersion: "shotmap-trajectory-v1", endpointKind: "goal_mouth", endX: 100, endY: 50, endZMeters: 1, source: "fotmob", extra: true }, "goal"],
    ["trajectory coordinate range", { schemaVersion: "shotmap-trajectory-v1", endpointKind: "goal_mouth", endX: 100, endY: 101, endZMeters: 1, source: "fotmob" }, "goal"],
    ["goal semantic endpoint", { schemaVersion: "shotmap-trajectory-v1", endpointKind: "blocked", endX: 80, endY: 50, endZMeters: null, source: "fotmob" }, "goal"],
    ["goal-mouth endX", { schemaVersion: "shotmap-trajectory-v1", endpointKind: "goal_mouth", endX: 99, endY: 50, endZMeters: 1, source: "fotmob" }, "on_target"],
    ["blocked semantic endpoint", { schemaVersion: "shotmap-trajectory-v1", endpointKind: "goal_mouth", endX: 100, endY: 50, endZMeters: 1, source: "fotmob" }, "blocked"],
    ["blocked height", { schemaVersion: "shotmap-trajectory-v1", endpointKind: "blocked", endX: 80, endY: 50, endZMeters: 0, source: "fotmob" }, "blocked"],
  ])("rejects malformed %s", (_label, trajectory, outcome) => {
    expect(playerDetailEnvelopeSchema.safeParse(detail({ ...validSpatial, shotmapPoints: [{ x: 70, y: 40, outcome, trajectory }] })).success).toBe(false);
  });

  it.each([
    ["missing shotmap fields", (() => { const { shotmapPoints: _points, ...spatial } = validSpatial; return spatial; })()],
    ["mismatched shot count", { ...validSpatial, shotmapPointCount: 2 }],
    ["malformed shot point", { ...validSpatial, shotmapPoints: [{ x: 50, y: 40, outcome: "saved" }] }],
    ["missing continuous core", (() => { const { continuousCore: _core, ...spatial } = validSpatial; return spatial; })()],
  ])("rejects %s", (_label, spatial) => expect(() => playerDetailEnvelopeSchema.parse(detail(spatial))).toThrow());
});
