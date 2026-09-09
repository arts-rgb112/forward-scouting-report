import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "./env";
import {
  fullActivityDisplayEnvelopeSchema,
  type FullActivityDisplayEnvelope,
} from "./fullActivityDisplayContracts";

export type FullActivityDisplayApiErrorKind = "network" | "not-found" | "invalid-request" | "schema";

export class FullActivityDisplayApiError extends Error {
  constructor(public readonly kind: FullActivityDisplayApiErrorKind, message: string = kind) {
    super(message);
    this.name = "FullActivityDisplayApiError";
  }
}

export const fullActivityDisplayResourceKey = (playerId: number, context: DatasetRouteState) =>
  JSON.stringify([
    "full-activity-display-v1",
    playerId,
    context.season,
    context.mode,
    context.mode === "league" ? context.scope : null,
    context.mode === "league" ? null : context.competition,
  ]);

export function buildFullActivityDisplayUrl(baseUrl: string, playerId: number, context: DatasetRouteState) {
  const url = new URL(`/api/v2/players/${playerId}/full-activity-display-v1`, baseUrl);
  url.searchParams.set("season", context.season);
  url.searchParams.set("mode", context.mode);
  if (context.mode === "league") url.searchParams.set("scope", String(context.scope));
  else url.searchParams.set("competition", context.competition);
  return url.toString();
}

function contextMatches(playerId: number, request: DatasetRouteState, response: FullActivityDisplayEnvelope) {
  const actual = response.context;
  return actual.playerId === playerId
    && actual.season === request.season
    && actual.mode === request.mode
    && actual.scope === (request.mode === "league" ? request.scope : null)
    && actual.competition === (request.mode === "league" ? null : request.competition);
}

export async function fetchFullActivityDisplay(
  config: MessiApiConfig,
  playerId: number,
  request: DatasetRouteState,
  signal: AbortSignal,
): Promise<FullActivityDisplayEnvelope> {
  let response: Response;
  try {
    response = await fetch(buildFullActivityDisplayUrl(config.baseUrl, playerId, request), {
      method: "GET",
      credentials: "omit",
      headers: { Accept: "application/json" },
      signal,
    });
  } catch (cause) {
    if (signal.aborted) throw cause;
    throw new FullActivityDisplayApiError("network");
  }
  if (!response.ok) {
    throw new FullActivityDisplayApiError(response.status === 404 ? "not-found" : response.status === 422 ? "invalid-request" : "network");
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new FullActivityDisplayApiError("schema");
  }
  const parsed = fullActivityDisplayEnvelopeSchema.safeParse(body);
  if (!parsed.success || !contextMatches(playerId, request, parsed.data)) {
    throw new FullActivityDisplayApiError("schema", "Full activity display response violates the requested context");
  }
  return parsed.data;
}
