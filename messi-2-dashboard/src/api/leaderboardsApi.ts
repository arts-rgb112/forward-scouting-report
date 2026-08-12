import { z } from "zod";

import { adaptAnalysis, adaptPlayer } from "./adapter";
import { comparisonEnvelopeSchema, leaderboardEnvelopeSchema, leaderboardPageEnvelopeSchema, playerDetailEnvelopeSchema, playerDtoSchema } from "./contracts";
import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import { PAGE_SIZE } from "../dashboard/datasetRoute";
import type { DatasetMeta, DatasetRouteState, LeaderboardOptions, LeaderboardSearch, PlayerComparison, PlayerDetail, PlayersPayload } from "../dashboard/types";

const scopeSchema = z.union([z.literal(3), z.literal(5), z.literal(7)]);
const competitionSchema = z.enum(["all", "ucl", "uel", "uecl"]);
const optionsSchema = z.object({ seasons: z.array(z.string()), scopes: z.array(z.object({ value: scopeSchema, label: z.string(), leagueIds: z.array(z.number()) })), competitions: z.record(competitionSchema, z.object({ code: competitionSchema, label: z.string(), available: z.boolean(), reason: z.string().nullable() })) });

async function getJson(url: string, signal: AbortSignal): Promise<unknown> {
  let response: Response;
  try { response = await fetch(url, { headers: { Accept: "application/json" }, signal, credentials: "omit" }); }
  catch (cause) { if (signal.aborted) throw cause; throw new MessiApiError("network", "Unable to reach the M.E.S.S.I. API"); }
  if (!response.ok) throw new MessiApiError("http", `API returned ${response.status}`, response.status);
  try { return await response.json(); } catch { throw new MessiApiError("schema", "Response was not valid JSON"); }
}

function contextParams(state: DatasetRouteState) {
  return { season: state.season, mode: state.mode, scope: String(state.scope), competition: state.competition };
}

function parseError(message: string, error: unknown): never {
  if (error instanceof DOMException && error.name === "AbortError") throw error;
  if (error instanceof MessiApiError) throw error;
  throw new MessiApiError("schema", message);
}

function normalizeLeaderboardMeta(meta: DatasetMeta): DatasetMeta {
  return { ...meta, totalItems: meta.totalItems ?? meta.population };
}

export async function fetchLeaderboardOptions(config: MessiApiConfig, signal: AbortSignal): Promise<LeaderboardOptions> {
  try { return optionsSchema.parse(await getJson(new URL("/api/v2/leaderboard-options", config.baseUrl).toString(), signal)); }
  catch (error) { return parseError("Leaderboard options response was invalid", error); }
}

/** Requests the documented v2.1 page contract. A valid v2.0 response is retained as a compatibility payload. */
export async function fetchLeaderboard(config: MessiApiConfig, state: DatasetRouteState, search: LeaderboardSearch, signal: AbortSignal): Promise<PlayersPayload> {
  const url = new URL("/api/v2/leaderboards", config.baseUrl);
  const params = new URLSearchParams({ ...contextParams(state), page: String(search.page), pageSize: String(PAGE_SIZE), sort: search.sort, order: search.direction });
  if (search.q) params.set("q", search.q);
  if (search.role !== "all") params.set("role", search.role);
  if (search.position !== "ALL") params.set("position", search.position);
  if (search.ageBand !== "all") params.set("ageBand", search.ageBand);
  if (search.minutesBand !== "all") params.set("minutesBand", search.minutesBand);
  url.search = params.toString();
  try {
    const json = await getJson(url.toString(), signal);
    const paged = leaderboardPageEnvelopeSchema.safeParse(json);
    if (paged.success) {
      const data = paged.data.data.slice(0, PAGE_SIZE);
      const meta = { ...normalizeLeaderboardMeta(paged.data.meta), returned: data.length };
      return { players: data.map(adaptPlayer), meta, serverPage: { page: paged.data.meta.page, pageSize: PAGE_SIZE, totalPages: paged.data.meta.totalPages, hasNextPage: paged.data.meta.hasNextPage } };
    }
    const legacy = leaderboardEnvelopeSchema.safeParse(json);
    if (legacy.success) return { players: legacy.data.data.map(adaptPlayer), meta: legacy.data.meta };
    throw paged.error;
  } catch (error) { return parseError("Leaderboard response was invalid", error); }
}

export async function fetchPlayerDetail(config: MessiApiConfig, id: number, state: DatasetRouteState, signal: AbortSignal): Promise<PlayerDetail> {
  const url = new URL(`/api/v2/players/${id}`, config.baseUrl);
  url.search = new URLSearchParams({ ...contextParams(state), includeAnalysis: "true" }).toString();
  try {
    const parsed = playerDetailEnvelopeSchema.parse(await getJson(url.toString(), signal));
    return { player: adaptPlayer(parsed.data), analysis: parsed.data.analysis ? adaptAnalysis(parsed.data.analysis) : undefined };
  } catch (error) { return parseError("Player detail response was invalid", error); }
}

export async function fetchComparison(config: MessiApiConfig, ids: readonly number[], state: DatasetRouteState, signal: AbortSignal): Promise<PlayerComparison> {
  if (ids.length !== 2 || new Set(ids).size !== 2) throw new MessiApiError("schema", "Comparison requires exactly two distinct players");
  const url = new URL("/api/v2/compare", config.baseUrl);
  url.search = new URLSearchParams({ ...contextParams(state), players: ids.join(",") }).toString();
  try {
    const parsed = comparisonEnvelopeSchema.parse(await getJson(url.toString(), signal));
    return { players: parsed.data.map((row) => ({ player: adaptPlayer(row), analysis: adaptAnalysis(row.analysis) })), meta: parsed.meta };
  } catch (error) { return parseError("Comparison response was invalid", error); }
}

// Kept exported for API contract-oriented tests and consumers that only need base player parsing.
export const playerSchema = playerDtoSchema;
