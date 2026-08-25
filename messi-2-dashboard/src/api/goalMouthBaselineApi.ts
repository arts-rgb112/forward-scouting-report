import type { MessiApiConfig } from "./env";
import { goalMouthBaselineEnvelopeSchema, type GoalMouthBaselineEnvelope } from "./goalMouthBaselineContracts";

export type GoalMouthBaselineApiErrorKind = "network" | "schema";
export class GoalMouthBaselineApiError extends Error { constructor(public readonly kind: GoalMouthBaselineApiErrorKind, message: string = kind) { super(message); this.name = "GoalMouthBaselineApiError"; } }
export const goalMouthBaselineResourceKey = "goal-mouth-baseline-v1";
export const buildGoalMouthBaselineUrl = (baseUrl: string) => new URL("/api/v2/goal-mouth-baseline", baseUrl).toString();
export async function fetchGoalMouthBaseline(config: MessiApiConfig, signal: AbortSignal): Promise<GoalMouthBaselineEnvelope> {
  let response: Response;
  try { response = await fetch(buildGoalMouthBaselineUrl(config.baseUrl), { method: "GET", credentials: "omit", headers: { Accept: "application/json" }, signal }); }
  catch (cause) { if (signal.aborted) throw cause; throw new GoalMouthBaselineApiError("network", "Unable to load goal-mouth baseline"); }
  if (!response.ok) throw new GoalMouthBaselineApiError("network", "Goal-mouth baseline request failed");
  let body: unknown;
  try { body = await response.json(); } catch { throw new GoalMouthBaselineApiError("schema", "Goal-mouth baseline response was not valid JSON"); }
  const parsed = goalMouthBaselineEnvelopeSchema.safeParse(body);
  if (!parsed.success) throw new GoalMouthBaselineApiError("schema", "Goal-mouth baseline response violated the v1 contract");
  return parsed.data;
}
