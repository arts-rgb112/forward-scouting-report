import type { MessiApiConfig } from "./env";
import { goalMouthBaselineEnvelopeSchema, type GoalMouthBaselineEnvelope } from "./goalMouthBaselineContracts";

export type GoalMouthBaselineApiErrorKind = "network" | "schema";
export class GoalMouthBaselineApiError extends Error { constructor(public readonly kind: GoalMouthBaselineApiErrorKind, message: string = kind) { super(message); this.name = "GoalMouthBaselineApiError"; } }
export const goalMouthBaselineResourceKey = "goal-mouth-baseline-v1";
export type GoalMouthBaselineContext = { playerId: number; season: string; mode: "league" | "europe"; scope: 3 | 5 | 7 | 8; competition: "all" | "ucl" | "uel" | "uecl"; includePenalties: boolean };
export const buildGoalMouthBaselineUrl = (baseUrl: string, context?: GoalMouthBaselineContext) => {
  const url = new URL("/api/v2/goal-mouth-baseline", baseUrl);
  if (context) {
    url.searchParams.set("playerId", String(context.playerId));
    url.searchParams.set("season", context.season);
    url.searchParams.set("mode", context.mode);
    if (context.mode === "league") url.searchParams.set("scope", String(context.scope));
    url.searchParams.set("competition", context.competition);
    url.searchParams.set("includePenalties", String(context.includePenalties));
  }
  return url.toString();
};
export async function fetchGoalMouthBaseline(config: MessiApiConfig, signal: AbortSignal, context?: GoalMouthBaselineContext): Promise<GoalMouthBaselineEnvelope> {
  let response: Response;
  try { response = await fetch(buildGoalMouthBaselineUrl(config.baseUrl, context), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new GoalMouthBaselineApiError("network", "Unable to load goal-mouth baseline"); }
  if (!response.ok) throw new GoalMouthBaselineApiError("network", "Goal-mouth baseline request failed");
  let body: unknown;
  try { body = await response.json(); } catch { throw new GoalMouthBaselineApiError("schema", "Goal-mouth baseline response was not valid JSON"); }
  const parsed = goalMouthBaselineEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new GoalMouthBaselineApiError("schema", "Goal-mouth baseline response violated the v1 contract");
  return parsed.data;
}
