import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import { volumeBenchmarkEnvelopeSchema, type VolumeBenchmark } from "./volumeBenchmarkContracts";
import type { DatasetRouteState } from "../dashboard/types";

export async function fetchVolumeBenchmark(config: MessiApiConfig, playerId: number, context: DatasetRouteState, signal: AbortSignal): Promise<VolumeBenchmark> {
  const url = new URL(`/api/v2/players/${playerId}/volume-benchmark`, config.baseUrl);
  url.searchParams.set("season", context.season); url.searchParams.set("mode", context.mode);
  if (context.mode === "league") { url.searchParams.set("scope", String(context.scope)); url.searchParams.set("competition", "all"); }
  else url.searchParams.set("competition", context.competition);
  url.searchParams.set("benchmarkScope", "8");
  let response: Response;
  try { response = await fetch(url, { headers: { Accept: "application/json" }, credentials: "omit", signal }); }
  catch (cause) { if (signal.aborted || (cause instanceof DOMException && cause.name === "AbortError")) throw cause; throw new MessiApiError("network", "Unable to load volume benchmark"); }
  if (!response.ok) throw new MessiApiError("http", response.status === 422 ? "Invalid volume benchmark request" : `Volume benchmark API returned ${response.status}`, response.status);
  let json: unknown; try { json = await response.json(); } catch { throw new MessiApiError("schema", "Volume benchmark response was not valid JSON"); }
  const parsed = volumeBenchmarkEnvelopeSchema.safeParse(json); if (!parsed.success) throw new MessiApiError("schema", "Volume benchmark response was invalid");
  const expectedScope = context.mode === "league" ? context.scope : null; const expectedCompetition = context.mode === "league" ? null : context.competition; const data = parsed.data.data;
  if (data.playerId !== playerId || data.season !== context.season || data.sourceContext.mode !== context.mode || data.sourceContext.scope !== expectedScope || data.sourceContext.competition !== expectedCompetition) throw new MessiApiError("schema", "Volume benchmark response identity did not match request");
  return data;
}
