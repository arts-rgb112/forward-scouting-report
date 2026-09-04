import { PATH_STYLE, goalFrame, pitchMarkings, zone20Lines, type Projection as GeometryProjection } from "./pitchGeometry";

export const POSITIONAL_DEPTH_BOUNDARIES = [0, 16.67, 33.33, 50, 66.67, 83.33, 100] as const;
export const POSITIONAL_LANE_BOUNDARIES = [0, 21.82, 37, 63, 78.18, 100] as const;
export const PITCH_WIDTH_METERS = 68;
export const GOAL_WIDTH_METERS = 7.32;
export const GOAL_CROSSBAR_HEIGHT_METERS = 2.44;
export const SIX_YARD_BOX_EXTENSION_METERS = 5.5;
export const GOAL_POST_Y = [
  ((PITCH_WIDTH_METERS / 2 - GOAL_WIDTH_METERS / 2) / PITCH_WIDTH_METERS) * 100,
  ((PITCH_WIDTH_METERS / 2 + GOAL_WIDTH_METERS / 2) / PITCH_WIDTH_METERS) * 100,
] as const;
export const SIX_YARD_BOX_Y = [
  ((PITCH_WIDTH_METERS / 2 - GOAL_WIDTH_METERS / 2 - SIX_YARD_BOX_EXTENSION_METERS) / PITCH_WIDTH_METERS) * 100,
  ((PITCH_WIDTH_METERS / 2 + GOAL_WIDTH_METERS / 2 + SIX_YARD_BOX_EXTENSION_METERS) / PITCH_WIDTH_METERS) * 100,
] as const;
export const ATTACKING_GOAL_FRAME_LIFT = 20;

export const LEGACY_POSITIONAL_SEGMENTS = [
  { axis: "depth", boundary: 0, start: { x: 0, y: 0 }, end: { x: 0, y: 100 } },
  { axis: "depth", boundary: 16.67, start: { x: 16.67, y: 0 }, end: { x: 16.67, y: 100 } },
  { axis: "depth", boundary: 33.33, start: { x: 33.33, y: 0 }, end: { x: 33.33, y: 21.82 } },
  { axis: "depth", boundary: 33.33, start: { x: 33.33, y: 78.18 }, end: { x: 33.33, y: 100 } },
  { axis: "depth", boundary: 50, start: { x: 50, y: 0 }, end: { x: 50, y: 100 } },
  { axis: "depth", boundary: 66.67, start: { x: 66.67, y: 0 }, end: { x: 66.67, y: 21.82 } },
  { axis: "depth", boundary: 66.67, start: { x: 66.67, y: 78.18 }, end: { x: 66.67, y: 100 } },
  { axis: "depth", boundary: 83.33, start: { x: 83.33, y: 0 }, end: { x: 83.33, y: 100 } },
  { axis: "depth", boundary: 100, start: { x: 100, y: 0 }, end: { x: 100, y: 100 } },
  { axis: "lane", boundary: 0, start: { x: 0, y: 0 }, end: { x: 100, y: 0 } },
  { axis: "lane", boundary: 21.82, start: { x: 0, y: 21.82 }, end: { x: 100, y: 21.82 } },
  { axis: "lane", boundary: 37, start: { x: 16.67, y: 37 }, end: { x: 83.33, y: 37 } },
  { axis: "lane", boundary: 63, start: { x: 16.67, y: 63 }, end: { x: 83.33, y: 63 } },
  { axis: "lane", boundary: 78.18, start: { x: 0, y: 78.18 }, end: { x: 100, y: 78.18 } },
  { axis: "lane", boundary: 100, start: { x: 0, y: 100 }, end: { x: 100, y: 100 } },
] as const;

export type PitchPoint = { x: number; y: number };
export type ScreenPoint = { x: number; y: number };
export const SPATIAL_PITCH_VIEWBOX = { width: 1000, height: 650 } as const;
export const PLAN_VERTICAL_TRANSFORM_Y = 1000;

const clamp = (value: number) => Math.min(100, Math.max(0, value));
export function projectPlan(point: PitchPoint): ScreenPoint {
  return { x: 30 + clamp(point.x) * 9.4, y: 610 - clamp(point.y) * 5.6 };
}

export const finalThirdPlanCrop = () => {
  const opponentEnd = projectPlan({ x: 100, y: 50 }).x;
  const depth5Boundary = projectPlan({ x: POSITIONAL_DEPTH_BOUNDARIES[4], y: 50 }).x;
  const laneNear = projectPlan({ x: 50, y: 0 }).y;
  const laneFar = projectPlan({ x: 50, y: 100 }).y;
  return { x: Math.min(laneNear, laneFar), y: PLAN_VERTICAL_TRANSFORM_Y - opponentEnd, width: Math.abs(laneFar - laneNear), height: opponentEnd - depth5Boundary };
};

const planProjection: GeometryProjection = {
  project: ([worldX, worldY]) => {
    const point = projectPlan({ x: worldX / 1.05, y: worldY / 0.68 });
    return [point.x, point.y];
  },
  pp: (yPct, xPct) => {
    const point = projectPlan({ x: xPct, y: yPct });
    return [point.x, point.y];
  },
  cameraPosition: [0, 0, 0],
  scale: 1,
};

export function PitchMarkings({ projection = planProjection }: { projection?: GeometryProjection }) {
  return <g data-layer="pitch-markings" fill="none" vectorEffect="non-scaling-stroke">
    {pitchMarkings(projection).map((path, index) => {
      const style = PATH_STYLE[path.role];
      return <path key={index} d={path.d} stroke={style.stroke} strokeOpacity={style.opacity} strokeWidth={style.width} strokeDasharray={style.dash} />;
    })}
  </g>;
}

export function PositionalGrid({ projection = planProjection }: { projection?: GeometryProjection }) {
  const style = PATH_STYLE["zone-grid"];
  return <g data-layer="positional-grid" fill="none" stroke={style.stroke} strokeOpacity={style.opacity} strokeWidth={style.width} strokeDasharray={style.dash} vectorEffect="non-scaling-stroke">
    {zone20Lines(projection).map((path, index) => <path key={index} data-grid-segment={index} d={path.d} />)}
  </g>;
}

export function GoalFrames({ projection = planProjection }: { projection?: GeometryProjection }) {
  return <g data-layer="goals" fill="none" strokeLinejoin="round" vectorEffect="non-scaling-stroke">
    {(["defending", "attacking"] as const).map((end) => {
      const goal = goalFrame(projection, end);
      const ground = projection.pp(GOAL_POST_Y[0], end === "attacking" ? 100 : 0);
      const crossbar = projection.pp(GOAL_POST_Y[0], end === "attacking" ? 100 : 0, GOAL_CROSSBAR_HEIGHT_METERS);
      return <g key={end} data-goal={end} data-goal-post-near-y={GOAL_POST_Y[0]} data-goal-post-far-y={GOAL_POST_Y[1]} data-goal-frame-lift={Math.abs(ground[1] - crossbar[1])} data-goal-crossbar-height-meters={GOAL_CROSSBAR_HEIGHT_METERS}>
        <path data-goal-frame d={goal.frame} stroke={PATH_STYLE["goal-frame"].stroke} strokeOpacity={PATH_STYLE["goal-frame"].opacity} strokeWidth={PATH_STYLE["goal-frame"].width} />
        {goal.net.map((d, index) => <path key={index} data-goal-net d={d} stroke={PATH_STYLE["goal-net"].stroke} strokeOpacity={PATH_STYLE["goal-net"].opacity} strokeWidth={PATH_STYLE["goal-net"].width} />)}
      </g>;
    })}
  </g>;
}

export function PlanPitchGeometry({ geometryId = "shared-plan-pitch" }: { geometryId?: string }) {
  const points = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 }].map(projectPlan);
  const pitchShape = `${points.map((point, index) => `${index ? "L" : "M"} ${point.x} ${point.y}`).join(" ")} Z`;
  return <g data-shared-plan-pitch={geometryId}>
    <defs><linearGradient id={`${geometryId}-grass`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#0f6f42" /><stop offset="1" stopColor="#06432e" /></linearGradient></defs>
    <path data-shared-plan-boundary d={pitchShape} fill={`url(#${geometryId}-grass)`} stroke="#143d2f" strokeWidth="9" />
    <GoalFrames /><PitchMarkings /><PositionalGrid />
  </g>;
}
