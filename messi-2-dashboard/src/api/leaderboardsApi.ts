import { z } from "zod";
import { adaptPlayer } from "./adapter";
import { playerDtoSchema } from "./contracts";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import type { DatasetRouteState, LeaderboardOptions, PlayersPayload } from "../dashboard/types";

const scopeSchema = z.union([z.literal(3), z.literal(5), z.literal(7)]);
const competitionSchema = z.enum(["all", "ucl", "uel", "uecl"]);
const optionsSchema = z.object({
  seasons: z.array(z.string()),
  scopes: z.array(z.object({ value: scopeSchema, label: z.string(), leagueIds: z.array(z.number()) })),
  competitions: z.record(competitionSchema, z.object({ code: competitionSchema, label: z.string(), available: z.boolean(), reason: z.string().nullable() })),
});
const envelopeSchema = z.object({
  data: z.array(playerDtoSchema),
  meta: z.object({ schemaVersion: z.literal("2.0.0"), season: z.string(), mode: z.enum(["league", "europe"]), scope: scopeSchema.nullable(), competition: competitionSchema.nullable(), population: z.number().int(), returned: z.number().int(), generatedAt: z.string(), source: z.literal("messi-static-cohort") }),
});

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { headers: { Accept: "application/json" }, signal, credentials: "omit" }); }
  catch { throw new MessiApiError("network", "Unable to reach the M.E.S.S.I. API"); }
  if (!response.ok) throw new MessiApiError("http", `API returned ${response.status}`, response.status);
  try { return await response.json(); } catch { throw new MessiApiError("schema", "Response was not valid JSON"); }
}

export async function fetchLeaderboardOptions(config: MessiApiConfig, signal: AbortSignal): Promise<LeaderboardOptions> {
  try { return optionsSchema.parse(await getJson(new URL("/api/v2/leaderboard-options", config.baseUrl).toString(), signal)); }
  catch (error) { if (error instanceof MessiApiError) throw error; throw new MessiApiError("schema", "Leaderboard options response was invalid"); }
}

export async function fetchLeaderboard(config: MessiApiConfig, state: DatasetRouteState, signal: AbortSignal): Promise<PlayersPayload> {
  const url = new URL("/api/v2/leaderboards", config.baseUrl);
  url.search = new URLSearchParams({ season: state.season, mode: state.mode, scope: String(state.scope), competition: state.competition, limit: String(config.limit) }).toString();
  try {
    const parsed = envelopeSchema.parse(await getJson(url.toString(), signal));
    if (parsed.meta.returned !== parsed.data.length) throw new Error("returned count mismatch");
    return { players: parsed.data.map(adaptPlayer), meta: parsed.meta };
  } catch (error) { if (error instanceof MessiApiError) throw error; throw new MessiApiError("schema", "Leaderboard response was invalid"); }
}

export async function fetchPlayerDetail(config: MessiApiConfig, id: number, state: DatasetRouteState, signal: AbortSignal) {
  const url = new URL(`/api/v2/players/${id}`, config.baseUrl);
  url.search = new URLSearchParams({ season: state.season, mode: state.mode, scope: String(state.scope), competition: state.competition }).toString();
  const payload = z.object({ data: playerDtoSchema }).parse(await getJson(url.toString(), signal));
  return adaptPlayer(payload.data);
}
