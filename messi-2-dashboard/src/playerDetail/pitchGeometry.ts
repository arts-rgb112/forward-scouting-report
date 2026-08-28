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

export type StrokedPath = { d: string; role: PathRole };
export type PathRole =
  | "turf" | "marking" | "zone-grid" | "pk-axis" | "goal-frame" | "goal-net" | "mini-box";

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

export function zone20Lines(p: Projection): StrokedPath[] {
  const out: StrokedPath[] = [];
  const [, l1, l2, l3, l4] = ZONE20.lanes;
  out.push({ d: linePath(p.pp(l1, 0), p.pp(l1, 100)), role: "zone-grid" });
  out.push({ d: linePath(p.pp(l4, 0), p.pp(l4, 100)), role: "zone-grid" });
  out.push({ d: linePath(p.pp(l2, 15.71), p.pp(l2, 84.29)), role: "zone-grid" });
  out.push({ d: linePath(p.pp(l3, 15.71), p.pp(l3, 84.29)), role: "zone-grid" });
  for (const x of ZONE20.depthWide.slice(1, -1)) {
    out.push({ d: linePath(p.pp(0, x), p.pp(l1, x)), role: "zone-grid" });
    out.push({ d: linePath(p.pp(l4, x), p.pp(100, x)), role: "zone-grid" });
  }
  for (const x of [15.71, 50, 84.29]) out.push({ d: linePath(p.pp(l1, x), p.pp(l4, x)), role: "zone-grid" });
  return out;
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
  "pk-axis":    { stroke: "#7DD3FC", width: 2.0, opacity: 0.9, dash: "9 6" },
  "mini-box":   { stroke: "#FDE68A", width: 2.2, opacity: 0.85 },
  "goal-frame": { stroke: "#FFFFFF", width: 3.2, opacity: 0.95 },
  "goal-net":   { stroke: "#FFFFFF", width: 1.0, opacity: 0.34 },
};
/** Background reference only: the CCA must not overpower pitch markings or shot events. */
export const CCA_STYLE = { stroke: "#C084FC", width: 1.15, opacity: 0.46, dash: "7 7" };
export const HEAT_DISPLAY_GAMMA = 0.6;
export const HEAT_OPACITY_CEILING = { perspective: 0.55, plan: 0.62 };
