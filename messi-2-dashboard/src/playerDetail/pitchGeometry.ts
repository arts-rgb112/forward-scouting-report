/**
 * Pitch geometry — extracted verbatim from the approved Figma mockups.
 *
 * These are the exact functions that produced Figma nodes 162:38 (tactics board),
 * 179:38 (6-lane corridor) and 191:38 (markers).  Nothing here is a description
 * of the mockup; it IS the mockup's code, with the Figma-only calls removed.
 *
 * Everything returns SVG path strings or point arrays, so the React pitch
 * components can consume it directly — same output medium as the mockup.
 *
 * ⚠️ Do NOT reimplement any of this from prose. Import it.
 *    The previous round re-derived the camera from a written spec and the live
 *    render diverged; that is the failure this file exists to remove.
 */

export type Vec3 = readonly [number, number, number];
export type Pt = readonly [number, number];

const f2 = (v: number) => Math.round(v * 100) / 100;
const S2 = (p: Pt) => `${f2(p[0])} ${f2(p[1])}`;
export const polyPath = (pts: readonly Pt[]) => `M ${pts.map(S2).join(" L ")} Z`;
export const linePath = (a: Pt, b: Pt) => `M ${S2(a)} L ${S2(b)}`;

export type OrbitOptions = {
  azimuth: number;
  elevation: number;
  radius: number;
  pivot?: Vec3;
  width: number;
  height: number;
  frameFromX?: number;
  fit?: "cover" | "contain";
  padding?: number;
};

export type Projection = {
  project: (p: Vec3) => Pt;
  pp: (yPct: number, xPct: number, heightM?: number) => Pt;
  cameraPosition: Vec3;
  scale: number;
};

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const norm = (v: Vec3): Vec3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: Vec3, b: Vec3): Vec3 =>
  [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

export function orbitCamera(options: OrbitOptions): Projection {
  const {
    azimuth, elevation, radius,
    pivot = [82, 34, 0] as Vec3,
    width, height,
    frameFromX = 50,
    fit = "cover",
    padding = 0.99,
  } = options;

  const A = (azimuth * Math.PI) / 180;
  const E = (elevation * Math.PI) / 180;
  const cam: Vec3 = [
    pivot[0] + radius * Math.cos(E) * Math.cos(A),
    pivot[1] + radius * Math.cos(E) * Math.sin(A),
    radius * Math.sin(E),
  ];

  const fwd = norm(sub(pivot, cam));
  const right = norm(cross(fwd, [0, 0, 1]));
  const up = cross(right, fwd);

  const raw = (p: Vec3): Pt => {
    const d = sub(p, cam);
    const z = dot(d, fwd) || 1e-6;
    return [dot(d, right) / z, dot(d, up) / z];
  };

  const probe: Vec3[] = [];
  for (const X of [frameFromX, 105]) for (const Y of [0, 68]) probe.push([X, Y, 0]);
  probe.push([105, 34, 2.44]);
  const rp = probe.map(raw);
  const x0 = Math.min(...rp.map((p) => p[0])), x1 = Math.max(...rp.map((p) => p[0]));
  const y0 = Math.min(...rp.map((p) => p[1])), y1 = Math.max(...rp.map((p) => p[1]));

  const sx = width / (x1 - x0), sy = height / (y1 - y0);
  const scale = (fit === "cover" ? Math.max(sx, sy) : Math.min(sx, sy)) * padding;
  const ox = width / 2 - ((x0 + x1) / 2) * scale;
  const oy = height / 2 + ((y0 + y1) / 2) * scale;
  const project = (p: Vec3): Pt => {
    const r = raw(p);
    return [ox + r[0] * scale, oy - r[1] * scale];
  };

  return {
    project,
    pp: (yPct, xPct, h = 0) => project([(xPct / 100) * 105, (yPct / 100) * 68, h]),
    cameraPosition: cam,
    scale,
  };
}

/** Approved default for the 3D tab. Do not change without owner sign-off. */
export const TACTICS_BOARD_CAMERA = {
  azimuth: -48, elevation: 30, radius: 84,
  pivot: [82, 34, 0] as Vec3, frameFromX: 50, fit: "cover" as const,
};

export const PITCH = {
  boxY: [20.35, 79.65] as const,
  boxDepthX: [15.71, 84.29] as const,
  goalAreaY: [36.53, 63.47] as const,
  goalAreaDepthX: [5.24, 94.76] as const,
  postY: [44.62, 55.38] as const,
  crossbarM: 2.44,
  penaltySpotX: [10.48, 89.52] as const,
  centreCircleR: 9.15,
  pkAxisY: 50,
};

export const ZONE20 = {
  lanes: [0, 21.82, 37.0, 63.0, 78.18, 100] as const,
  depthWide: [0, 15.71, 32.5, 50, 67.5, 84.29, 100] as const,
  depthCentre: [0, 15.71, 50, 84.29, 100] as const,
};
export const SHOT_LANES = [0, 21.82, 37.0, 50.0, 63.0, 78.18, 100] as const;

/**
 * Presentation taxonomy for the owner-provided 20-zone guide.  This is
 * deliberately geometry and naming only: there is no client-side aggregate
 * attached to a zone until the separately versioned server contract exists.
 * `x` increases toward the attacking goal and `y=0` is the player's right.
 */
export type TacticalZone20Id =
  | "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "10"
  | "11" | "12" | "13" | "14" | "15" | "16" | "17" | "18" | "19" | "20";
export type TacticalZone20 = {
  id: TacticalZone20Id;
  label: string;
  xMinInclusive: number;
  xMaxExclusive: number;
  yMinInclusive: number;
  yMaxExclusive: number;
};

const z = (id: TacticalZone20Id, label: string, x0: number, x1: number, y0: number, y1: number): TacticalZone20 => ({
  id, label, xMinInclusive: x0, xMaxExclusive: x1, yMinInclusive: y0, yMaxExclusive: y1,
});

/** Names follow the owner-approved attack-direction diagram, never camera direction. */
export const TACTICAL_ZONE20: readonly TacticalZone20[] = [
  z("1", "1 · 수비 좌 와이드", 0, 15.71, 78.18, 100),
  z("2", "2 · 수비 박스", 0, 15.71, 21.82, 78.18),
  z("3", "3 · 수비 우 와이드", 0, 15.71, 0, 21.82),
  z("4", "4 · 수비 좌 와이드", 15.71, 32.5, 78.18, 100),
  z("5", "5 · 수비 좌 와이드", 32.5, 50, 78.18, 100),
  z("6", "6 · 수비 좌 하프스페이스", 15.71, 50, 63, 78.18),
  z("7", "7 · 수비 중앙 채널", 15.71, 50, 37, 63),
  z("8", "8 · 수비 우 하프스페이스", 15.71, 50, 21.82, 37),
  z("9", "9 · 수비 우 와이드", 15.71, 32.5, 0, 21.82),
  z("10", "10 · 수비 우 와이드", 32.5, 50, 0, 21.82),
  z("11", "11 · 공격 좌 와이드", 50, 67.5, 78.18, 100),
  z("12", "12 · 공격 좌 와이드", 67.5, 84.29, 78.18, 100),
  z("13", "13 · 공격 좌 하프스페이스", 50, 84.29, 63, 78.18),
  z("14", "14 · 공격 중앙 채널", 50, 84.29, 37, 63),
  z("15", "15 · 공격 우 하프스페이스", 50, 84.29, 21.82, 37),
  z("16", "16 · 공격 우 와이드", 50, 67.5, 0, 21.82),
  z("17", "17 · 공격 우 와이드", 67.5, 84.29, 0, 21.82),
  z("18", "18 · 공격 좌 와이드", 84.29, 100, 78.18, 100),
  z("19", "19 · 공격 우 와이드", 84.29, 100, 0, 21.82),
  z("20", "20 · 공격 박스", 84.29, 100, 21.82, 78.18),
] as const;

const includesUpperPitchEdge = (value: number, exclusiveMax: number) => value < exclusiveMax || (exclusiveMax === 100 && value === 100);
/** One half-open resolver shared by 2D and 3D. The outer pitch edge belongs to its final cell. */
export function resolveTacticalZone20(x: number, y: number): TacticalZone20 | null {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 100 || y < 0 || y > 100) return null;
  return TACTICAL_ZONE20.find((zone) =>
    x >= zone.xMinInclusive && includesUpperPitchEdge(x, zone.xMaxExclusive)
    && y >= zone.yMinInclusive && includesUpperPitchEdge(y, zone.yMaxExclusive),
  ) ?? null;
}

export type StrokedPath = { d: string; role: PathRole };
export type PathRole =
  | "turf" | "marking" | "zone-grid" | "box-subregion" | "pk-axis" | "goal-frame" | "goal-net" | "mini-box";

export const turfPath = (p: Projection) =>
  polyPath([p.pp(0, 0), p.pp(0, 100), p.pp(100, 100), p.pp(100, 0)]);

export function mattePath(p: Projection, width: number, height: number) {
  const mouth = polyPath([
    p.pp(PITCH.postY[0], 100), p.pp(PITCH.postY[1], 100),
    p.pp(PITCH.postY[1], 100, PITCH.crossbarM), p.pp(PITCH.postY[0], 100, PITCH.crossbarM),
  ]);
  return `M 0 0 L ${width} 0 L ${width} ${height} L 0 ${height} Z ${turfPath(p)} ${mouth}`;
}

export function pitchMarkings(p: Projection): StrokedPath[] {
  const out: StrokedPath[] = [];
  out.push({ d: turfPath(p), role: "marking" });
  out.push({ d: linePath(p.pp(0, 50), p.pp(100, 50)), role: "marking" });
  const circle: Pt[] = [];
  for (let i = 0; i <= 60; i += 1) {
    const a = (i / 60) * 2 * Math.PI;
    circle.push(p.project([52.5 + PITCH.centreCircleR * Math.cos(a), 34 + PITCH.centreCircleR * Math.sin(a), 0]));
  }
  out.push({ d: `M ${circle.map(S2).join(" L ")}`, role: "marking" });
  for (const near of [true, false]) {
    const gl = near ? 100 : 0;
    const pb = near ? PITCH.boxDepthX[1] : PITCH.boxDepthX[0];
    const ga = near ? PITCH.goalAreaDepthX[1] : PITCH.goalAreaDepthX[0];
    out.push({ d: polyPath([p.pp(PITCH.boxY[0], gl), p.pp(PITCH.boxY[1], gl), p.pp(PITCH.boxY[1], pb), p.pp(PITCH.boxY[0], pb)]), role: "marking" });
    out.push({ d: polyPath([p.pp(PITCH.goalAreaY[0], gl), p.pp(PITCH.goalAreaY[1], gl), p.pp(PITCH.goalAreaY[1], ga), p.pp(PITCH.goalAreaY[0], ga)]), role: "marking" });
  }
  return out;
}

export type PitchPercentSegment = readonly [xStart: number, yStart: number, xEnd: number, yEnd: number];

/** Common 20-zone guide segments. They are structural guide lines, not data cells. */
export const zone20Segments = (): readonly PitchPercentSegment[] => {
  const out: PitchPercentSegment[] = [];
  const [, l1, l2, l3, l4] = ZONE20.lanes;
  out.push([0, l1, 100, l1], [0, l4, 100, l4]);
  out.push([15.71, l2, 84.29, l2], [15.71, l3, 84.29, l3]);
  for (const x of ZONE20.depthWide.slice(1, -1)) {
    if (x === 15.71 || x === 84.29) continue; // existing physical box rear edges
    out.push([x, 0, x, l1], [x, l4, x, 100]);
  }
  // x=15.71/84.29 are the existing physical penalty-box rear edges.
  // Repainting either as a guide makes a visibly heavier double line, so
  // only the non-physical centre split is drawn here.
  out.push([50, l1, 50, l4]);
  return out;
};

/** Inner box dividers only: the physical 84.29 box line is never duplicated. */
export const boxSubregionDividerSegments = (): readonly PitchPercentSegment[] => [
  [84.29, 37, 100, 37], [84.29, 50, 100, 50], [84.29, 63, 100, 63],
  [0, 37, 15.71, 37], [0, 50, 15.71, 50], [0, 63, 15.71, 63],
];

export function zone20Lines(p: Projection): StrokedPath[] {
  return zone20Segments().map(([x0, y0, x1, y1]) => ({ d: linePath(p.pp(y0, x0), p.pp(y1, x1)), role: "zone-grid" }));
}

export function boxSubregionDividerLines(p: Projection): StrokedPath[] {
  return boxSubregionDividerSegments().map(([x0, y0, x1, y1]) => ({ d: linePath(p.pp(y0, x0), p.pp(y1, x1)), role: "box-subregion" }));
}

export function pkAxisLines(p: Projection): StrokedPath[] {
  return [
    { d: linePath(p.pp(PITCH.pkAxisY, 84.29), p.pp(PITCH.pkAxisY, 100)), role: "pk-axis" },
    { d: linePath(p.pp(PITCH.pkAxisY, 0), p.pp(PITCH.pkAxisY, 15.71)), role: "pk-axis" },
  ];
}

export function boxColumnLines(p: Projection): StrokedPath[] {
  return [
    { d: linePath(p.pp(PITCH.goalAreaY[0], 84.29), p.pp(PITCH.goalAreaY[0], 100)), role: "mini-box" },
    { d: linePath(p.pp(PITCH.goalAreaY[1], 84.29), p.pp(PITCH.goalAreaY[1], 100)), role: "mini-box" },
  ];
}

export function goalFrame(p: Projection, end: "attacking" | "defending") {
  const gl = end === "attacking" ? 100 : 0;
  const bl = p.pp(PITCH.postY[0], gl), br = p.pp(PITCH.postY[1], gl);
  const tl = p.pp(PITCH.postY[0], gl, PITCH.crossbarM), tr = p.pp(PITCH.postY[1], gl, PITCH.crossbarM);
  const net: string[] = [];
  for (let i = 1; i <= 2; i += 1) {
    const yy = PITCH.postY[0] + (PITCH.postY[1] - PITCH.postY[0]) * (i / 3);
    net.push(linePath(p.pp(yy, gl), p.pp(yy, gl, PITCH.crossbarM)));
    net.push(linePath(p.pp(PITCH.postY[0], gl, (PITCH.crossbarM * i) / 3), p.pp(PITCH.postY[1], gl, (PITCH.crossbarM * i) / 3)));
  }
  return { mouth: polyPath([bl, br, tr, tl]), frame: `M ${S2(bl)} L ${S2(tl)} L ${S2(tr)} L ${S2(br)}`, net };
}

export type ShotFlight = { x: number; y: number; endY: number | null; endZMeters: number | null };
export function shotFlight(p: Projection, shot: ShotFlight, segments = 20) {
  if (shot.endY == null || shot.endZMeters == null) return null;
  const Xo = (shot.x / 100) * 105, Yo = (shot.y / 100) * 68;
  const Yg = (shot.endY / 100) * 68, Zg = shot.endZMeters;
  const dist = Math.hypot(105 - Xo, Yg - Yo);
  const A = 4 * (0.4 + 0.08 * dist + 0.5 * Zg);
  const at = (t: number) => p.project([Xo + (105 - Xo) * t, Yo + (Yg - Yo) * t, t * Zg + A * t * (1 - t)]);
  const gd = (t: number) => p.project([Xo + (105 - Xo) * t, Yo + (Yg - Yo) * t, 0]);
  const arc: string[] = [];
  for (let i = 0; i < segments; i += 1) arc.push(linePath(at(i / segments), at((i + 1) / segments)));
  return { shadow: linePath(gd(0), gd(1)), arc, ties: [0.22, 0.42, 0.62, 0.82].map((t) => linePath(at(t), gd(t))), landing: at(1) };
}

export const PATH_STYLE: Record<PathRole, { stroke: string; width: number; opacity: number; dash?: string }> = {
  turf:         { stroke: "none",    width: 0,   opacity: 0 },
  marking:      { stroke: "#FFFFFF", width: 2.2, opacity: 0.5 },
  "zone-grid":  { stroke: "#FFFFFF", width: 1.0, opacity: 0.13 },
  "box-subregion": { stroke: "#FFFFFF", width: 1.2, opacity: 0.34 },
  "pk-axis":    { stroke: "#7DD3FC", width: 2.0, opacity: 0.9, dash: "9 6" },
  "mini-box":   { stroke: "#FDE68A", width: 2.2, opacity: 0.85 },
  "goal-frame": { stroke: "#FFFFFF", width: 3.2, opacity: 0.95 },
  "goal-net":   { stroke: "#FFFFFF", width: 1.0, opacity: 0.34 },
};
/** Background reference only: the CCA must not overpower pitch markings or shot events. */
/** Tuned against the heat ramp: visible as an area boundary without masking shot events. */
export const CCA_STYLE = { stroke: "#C084FC", width: 2.4, opacity: 0.95, dash: "9 6" };
export const HEAT_DISPLAY_GAMMA = 0.85;
export const HEAT_OPACITY_CEILING = { perspective: 0.58, plan: 0.58 };
