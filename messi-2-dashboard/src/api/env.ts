import { MessiApiError } from "./errors";

export type MessiApiConfig = { baseUrl: string; season: string; scope: 3 | 5 | 7; limit: number };
export type ConfigErrorCategory = "MISSING_API_BASE_URL" | "INVALID_API_ORIGIN" | "INSECURE_API_ORIGIN" | "INVALID_DATASET_SETTINGS" | "CONFIG_INVALID";

export class MessiConfigError extends MessiApiError {
  constructor(public readonly category: ConfigErrorCategory) {
    super("config", category);
    this.name = "MessiConfigError";
  }
}

export function parseMessiApiConfig(env: Record<string, unknown>, mode: string): MessiApiConfig {
  const raw = String(env.VITE_MESSI_API_BASE_URL ?? "").trim();
  if (!raw) throw new MessiConfigError("MISSING_API_BASE_URL");
  let url: URL;
  try { url = new URL(raw); } catch { throw new MessiConfigError("INVALID_API_ORIGIN"); }
  const localhost = ["localhost", "127.0.0.1"].includes(url.hostname);
  const isLiteralOrigin = raw === url.origin || raw === `${url.origin}/`;
  if (!isLiteralOrigin || url.username || url.password || url.search || url.hash || (url.pathname !== "/" && url.pathname !== "")) throw new MessiConfigError("INVALID_API_ORIGIN");
  if (url.protocol !== "https:" && !(localhost && url.protocol === "http:" && mode === "development")) throw new MessiConfigError("INSECURE_API_ORIGIN");
  const season = String(env.VITE_MESSI_SEASON ?? "").trim();
  if (!/^\d{4}\/\d{4}$/.test(season)) throw new MessiConfigError("INVALID_DATASET_SETTINGS");
  const scope = Number(env.VITE_MESSI_SCOPE);
  if (![3, 5, 7].includes(scope)) throw new MessiConfigError("INVALID_DATASET_SETTINGS");
  const limit = Number(env.VITE_MESSI_LIMIT);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new MessiConfigError("INVALID_DATASET_SETTINGS");
  return { baseUrl: url.origin, season, scope: scope as 3 | 5 | 7, limit };
}

export function buildPlayersUrl(config: MessiApiConfig): string {
  const url = new URL("/api/v1/players", config.baseUrl);
  url.searchParams.set("season", config.season);
  url.searchParams.set("scope", String(config.scope));
  url.searchParams.set("limit", String(config.limit));
  return url.toString();
}
