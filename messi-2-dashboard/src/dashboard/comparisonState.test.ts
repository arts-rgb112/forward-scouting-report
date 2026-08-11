import { describe, expect, it } from "vitest";
import { comparisonReducer } from "./comparisonState";

describe("comparisonReducer", () => {
  it("preserves order, toggles uniquely, and caps at two", () => { let state = { ids: [] as number[], open: false }; for (const id of [3, 1, 4]) state = comparisonReducer(state, { type: "toggle", id }); expect(state.ids).toEqual([3, 1]); });
  it("automatically closes details below two players", () => expect(comparisonReducer({ ids: [1, 2], open: true }, { type: "remove", id: 1 })).toEqual({ ids: [2], open: false }));
  it("does not open below two players", () => expect(comparisonReducer({ ids: [1], open: false }, { type: "set-open", open: true }).open).toBe(false));
  it("clears and reconciles", () => { expect(comparisonReducer({ ids: [1, 2], open: true }, { type: "clear" })).toEqual({ ids: [], open: false }); expect(comparisonReducer({ ids: [1, 2], open: true }, { type: "reconcile", validIds: new Set([2]) })).toEqual({ ids: [2], open: false }); });
});
