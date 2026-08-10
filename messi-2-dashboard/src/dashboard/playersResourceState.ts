import type { MessiApiError } from "../api/errors";
import type { PlayersPayload } from "./types";
export type ResourceState = { type: "idle" } | { type: "loading"; requestId: number } | { type: "refreshing"; requestId: number; payload: PlayersPayload } | { type: "success" | "empty"; payload: PlayersPayload } | { type: "error"; error: MessiApiError; previous?: PlayersPayload };
export type ResourceAction = { type: "start"; requestId: number; previous?: PlayersPayload } | { type: "resolve"; requestId: number; payload: PlayersPayload } | { type: "reject"; requestId: number; error: MessiApiError };
export function stablePayload(state: ResourceState): PlayersPayload | undefined { return state.type === "success" || state.type === "empty" || state.type === "refreshing" ? state.payload : state.type === "error" ? state.previous : undefined; }
export function playersResourceReducer(state: ResourceState, action: ResourceAction): ResourceState {
  if (action.type === "start") return action.previous ? { type: "refreshing", requestId: action.requestId, payload: action.previous } : { type: "loading", requestId: action.requestId };
  if (!(state.type === "loading" || state.type === "refreshing") || state.requestId !== action.requestId) return state;
  if (action.type === "resolve") return { type: action.payload.players.length ? "success" : "empty", payload: action.payload };
  return { type: "error", error: action.error, previous: state.type === "refreshing" ? state.payload : undefined };
}
