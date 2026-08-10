import { describe, expect, it } from "vitest";
import { parseWatchlist } from "./watchlistStorage";

describe("parseWatchlist", () => {
  const valid = new Set([1, 2, 3]);
  it.each(["not json", "{}", "null"])("returns empty for malformed/non-array %s", (raw) => expect(parseWatchlist(raw, valid)).toEqual([]));
  it("deduplicates and removes invalid values", () => expect(parseWatchlist('[1,1,2,"3",99]', valid)).toEqual([1, 2]));
});
