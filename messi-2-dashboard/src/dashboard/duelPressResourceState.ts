export type DuelPressPageMeta = { page: number; pageSize: 50; totalItems: number; totalPages: number; returned: number; hasNextPage: boolean };
export type DuelPressPageState = "rows" | "empty-dataset" | "overflow";
export function classifyDuelPressPage(meta: DuelPressPageMeta): DuelPressPageState {
  if (meta.totalItems === 0 && meta.page === 1 && meta.returned === 0 && meta.totalPages === 0 && !meta.hasNextPage) return "empty-dataset";
  if (meta.totalItems > 0 && meta.page > meta.totalPages && meta.returned === 0 && !meta.hasNextPage) return "overflow";
  return "rows";
}
export type DuelPressResource<T> = { key: string; requestId: number; status: "idle" | "loading" | "ready" | "refreshing" | "error"; value: T | null; error: unknown | null };
export function beginDuelPressRequest<T>(state: DuelPressResource<T>, key: string, requestId: number): DuelPressResource<T> {
  return { key, requestId, status: state.key === key && state.value !== null ? "refreshing" : "loading", value: state.key === key ? state.value : null, error: null };
}
export function settleDuelPressRequest<T>(state: DuelPressResource<T>, requestId: number, result: { value: T } | { error: unknown }): DuelPressResource<T> {
  if (requestId !== state.requestId) return state;
  if ("value" in result) return { ...state, status: "ready", value: result.value, error: null };
  return { ...state, status: "error", error: result.error };
}
