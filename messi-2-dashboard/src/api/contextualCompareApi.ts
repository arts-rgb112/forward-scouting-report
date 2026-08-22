import type { MessiApiConfig } from "./env";
import { MessiApiError } from "./errors";
import { contextualCompareRequestSchema, parseContextualCompareResponse, type ContextualCompareRequest, type ContextualCompareResponse } from "./contextualCompareContracts";

export async function fetchContextualComparison(config: MessiApiConfig, request: ContextualCompareRequest, signal: AbortSignal): Promise<ContextualCompareResponse> {
  const validated = contextualCompareRequestSchema.parse(request);
  let response: Response;
  try {
    response = await fetch(new URL("/api/v2/compare/contextual", config.baseUrl), { method: "POST", credentials: "omit", signal, headers: { Accept: "application/json", "Content-Type": "application/json" }, body: JSON.stringify(validated) });
  } catch (cause) { if (signal.aborted) throw cause; throw new MessiApiError("network", "Unable to reach the contextual comparison API"); }
  if (!response.ok) throw new MessiApiError(response.status === 422 ? "schema" : "http", `Contextual comparison returned ${response.status}`, response.status);
  let body: unknown; try { body = await response.json(); } catch { throw new MessiApiError("schema", "Contextual comparison was not valid JSON"); }
  try { return parseContextualCompareResponse(body, validated); } catch { throw new MessiApiError("schema", "Contextual comparison violated its contract"); }
}
