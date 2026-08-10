import { MessiApiError } from "./errors";
export const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);
export function retryDelay(attempt: number, retryAfter: string | null, now = Date.now(), random = Math.random): number {
  if (retryAfter) { const seconds = Number(retryAfter); const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(retryAfter) - now; if (Number.isFinite(delay)) return Math.max(0, Math.min(30_000, delay)); }
  return [500, 1500][Math.min(attempt, 1)] + Math.floor(random() * 200);
}
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> { return new Promise((resolve, reject) => { const timer = setTimeout(resolve, ms); signal.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); }); }
export function asNetworkError(error: unknown): MessiApiError { return error instanceof MessiApiError ? error : new MessiApiError("network", error instanceof Error ? error.message : "Network request failed"); }
