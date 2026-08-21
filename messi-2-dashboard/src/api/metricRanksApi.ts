import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import { metricRanksRequestSchema, metricRanksResponseSchema, type MetricRanksRequest, type MetricRanksResponse } from "./metricRanksContracts";

/** Strict, optional companion. Callers deliberately retain the current UI if this endpoint is not deployed. */
export async function fetchMetricRanks(config: MessiApiConfig, request: MetricRanksRequest, signal?: AbortSignal): Promise<MetricRanksResponse> {
  const checked = metricRanksRequestSchema.safeParse(request);
  if (!checked.success) throw new MessiApiError("schema", "Metric-ranks request was invalid");
  let response: Response;
  try { response = await fetch(new URL("/api/v2/metric-ranks", config.baseUrl).toString(), { method: "POST", headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(checked.data), signal, credentials: "omit" }); }
  catch (cause) { if (signal?.aborted) throw cause; throw new MessiApiError("network", "Metric ranks are unavailable"); }
  if (!response.ok) throw new MessiApiError("http", `Metric ranks returned ${response.status}`, response.status);
  const parsed = metricRanksResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) throw new MessiApiError("schema", "Metric-ranks response was invalid");
  const requested = new Map(checked.data.entries.map((entry) => [entry.key, entry]));
  if (parsed.data.results.length !== checked.data.entries.length || new Set(parsed.data.results.map((result) => result.key)).size !== parsed.data.results.length) throw new MessiApiError("schema", "Metric-ranks response keys did not match request");
  for (const [index, result] of parsed.data.results.entries()) {
    const entry = requested.get(result.key);
    if (!entry || checked.data.entries[index]?.key !== result.key || entry.player.playerId !== result.player.playerId || entry.player.idNamespace !== result.player.idNamespace || entry.metricTaxonomyVersion !== result.metricTaxonomyVersion || JSON.stringify(entry.context) !== JSON.stringify(result.context)) throw new MessiApiError("schema", "Metric-ranks response context did not match request");
  }
  return parsed.data;
}
