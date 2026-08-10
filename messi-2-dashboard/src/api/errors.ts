export type ApiErrorKind = "config" | "network" | "http" | "schema";
export class MessiApiError extends Error { constructor(public kind: ApiErrorKind, message: string, public status?: number, public retryAfter?: number) { super(message); this.name = "MessiApiError"; } }
export const isAbortError = (error: unknown) => error instanceof DOMException && error.name === "AbortError";
