import type { FinalThirdZone } from "../api/finalThirdShotMapContracts";
import type { FinalThirdRenderableData, FinalThirdShotMapV2Data } from "../api/finalThirdShotMapV2Contracts";
import { finalThirdPlanCrop, PlanPitchGeometry, PLAN_VERTICAL_TRANSFORM_Y, projectPlan } from "./SpatialPitch";

const OUTER_RADIUS = 52;
const zoneColor = (zone: FinalThirdZone, data: FinalThirdRenderableData) => zone.qualityScore === null ? "#3f3f46" : `hsl(${Math.round(Math.max(0, Math.min(1, (zone.qualityScore - data.qualityScale.min) / (data.qualityScale.max - data.qualityScale.min))) * 130)} 72% 48%)`;
const hexPath = (cx: number, cy: number, radius: number) => Array.from({ length: 6 }, (_, index) => { const angle = Math.PI / 3 * index; return `${index ? "L" : "M"} ${cx + Math.cos(angle) * radius} ${cy + Math.sin(angle) * radius}`; }).join(" ") + " Z";
/** Matches matrix(0 -1 1 0 0 1000): plan x becomes vertical, plan y becomes horizontal. */
const vertical = (point: { x: number; y: number }) => { const plan = projectPlan(point); return { x: plan.y, y: 1000 - plan.x }; };
const tileCenter = (zone: FinalThirdZone) => vertical({ x: zone.depth === 6 ? 91.665 : 75, y: [10.91, 29.41, 50, 70.59, 89.09][zone.lane - 1] });
const displayRate = (value: number | null) => value === null ? "unavailable" : `${value.toFixed(value % 1 ? 1 : 0)}%`;
const displayAttemptCount = (zone: FinalThirdZone, data: FinalThirdRenderableData) => {
  if (zone.shotsTotal === null) return "Unavailable";
  const effective = "conversionDefinition" in data
    ? (zone as FinalThirdShotMapV2Data["zones"][number]).effectiveShotCount
    : zone.goals;
  return effective === null ? "Unavailable" : `${effective}/${zone.shotsTotal}`;
};

export function FinalThirdPitchView({ data }: { data: FinalThirdRenderableData }) {
  const crop = finalThirdPlanCrop(), viewBox = `${crop.x} ${crop.y} ${crop.width} ${crop.height}`;
  return <figure className="min-w-0 overflow-hidden rounded-lg border border-white/10 bg-[#07130f]"><svg data-final-third-pitch data-front2-crop="depth5-depth6" viewBox={viewBox} className="block h-auto w-full" role="img" aria-label="Shared Spatial Pitch plan, rotated vertically and cropped to Depths 5 and 6. Attack moves upward and Lane 1 is screen-right.">
    <g data-final-third-vertical-transform transform={`matrix(0 -1 1 0 0 ${PLAN_VERTICAL_TRANSFORM_Y})`}><PlanPitchGeometry geometryId="final-third-shared-plan"/></g>
    {data.zones.map((zone) => { const center = tileCenter(zone), unavailable = zone.shotsTotal === null; const countLabel = displayAttemptCount(zone, data); const countDescription = "conversionDefinition" in data ? `${countLabel} effective shots from ${zone.shotsTotal} total shots` : `${countLabel} goals from ${zone.shotsTotal} total shots`; const innerRadius = unavailable ? 0 : Math.min(OUTER_RADIUS - 8, 8 + Math.sqrt(zone.shotsTotal ?? 0) * 9); return <g key={zone.zoneId} data-zone-id={zone.zoneId} data-zone-state={zone.state} aria-label={`${zone.zoneId}: ${unavailable ? "unavailable" : `${countDescription}, ${displayRate(zone.conversionRatePct)} conversion`}`}>
      <path data-zone-outer d={hexPath(center.x, center.y, OUTER_RADIUS)} fill="#090f12" fillOpacity=".9" stroke="#f4f4f5" strokeOpacity=".8" strokeWidth="2"/>
      {innerRadius > 0 && <path data-zone-volume d={hexPath(center.x, center.y, innerRadius)} fill={zoneColor(zone, data)} fillOpacity=".9"/>}
      <text x={center.x} y={center.y - 8} textAnchor="middle" fill="white" fontSize="13" fontWeight="800">{countLabel}</text><text x={center.x} y={center.y + 10} textAnchor="middle" fill="#f4f4f5" fontSize="11">{displayRate(zone.conversionRatePct)}</text>
    </g>; })}
  </svg><figcaption className="px-3 py-2 text-xs text-zinc-300">The same plan pitch geometry is SVG-transformed and front-two-depth cropped. All taxonomy hexes have the same outer footprint; inner fill alone presents server shot volume and quality. {"conversionDefinition" in data ? "Effective shots (on-target + goals) / all shots." : "Goals / all shots."}</figcaption></figure>;
}
