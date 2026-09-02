import type { MessiApiConfig } from "./env";
import { fullActivityHeatmapEnvelopeSchema, type FullActivityHeatmapEnvelope } from "./fullActivityHeatmapContracts";

export type FullActivityHeatmapContext = { playerId: number; season: string; mode: "league" | "europe"; scope: 3 | 5 | 7 | 8; competition: "all" | "ucl" | "uel" | "uecl" };
export const fullActivityHeatmapResourceKey = "full-activity-heatmap-v1";
export const buildFullActivityHeatmapUrl = (baseUrl: string, context: FullActivityHeatmapContext) => {
  const url = new URL(`/api/v2/players/${context.playerId}/full-activity-heatmap`, baseUrl);
  url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode);
  if (context.mode === "league") url.searchParams.set("scope", String(context.scope));
  url.searchParams.set("competition", context.competition);
  return url.toString();
};
export async function fetchFullActivityHeatmap(config: MessiApiConfig, context: FullActivityHeatmapContext, signal: AbortSignal): Promise<FullActivityHeatmapEnvelope> {
  const response = await fetch(buildFullActivityHeatmapUrl(config.baseUrl, context), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal });
  if (!response.ok) throw new Error("full activity heatmap request failed");
  const parsed = fullActivityHeatmapEnvelopeSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("full activity heatmap response violated its contract");
  return parsed.data;
}
