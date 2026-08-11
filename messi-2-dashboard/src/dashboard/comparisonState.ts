export const MAX_COMPARISON_PLAYERS = 2;

export type ComparisonState = { ids: number[]; open: boolean };
export type ComparisonAction =
  | { type: "toggle"; id: number }
  | { type: "remove"; id: number }
  | { type: "clear" }
  | { type: "set-open"; open: boolean }
  | { type: "reconcile"; validIds: ReadonlySet<number> };

const withSafeOpen = (ids: number[], open: boolean): ComparisonState => ({ ids, open: ids.length >= 2 && open });

export function comparisonReducer(state: ComparisonState, action: ComparisonAction): ComparisonState {
  switch (action.type) {
    case "toggle": {
      if (state.ids.includes(action.id)) return withSafeOpen(state.ids.filter((id) => id !== action.id), state.open);
      if (state.ids.length >= MAX_COMPARISON_PLAYERS) return state;
      return { ids: [...state.ids, action.id], open: state.open };
    }
    case "remove": return withSafeOpen(state.ids.filter((id) => id !== action.id), state.open);
    case "clear": return { ids: [], open: false };
    case "set-open": return { ...state, open: action.open && state.ids.length >= 2 };
    case "reconcile": return withSafeOpen(state.ids.filter((id) => action.validIds.has(id)), state.open);
  }
}
