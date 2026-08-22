import { describe, expect, it } from "vitest";

import { textComparisonKey } from "./textComparisonKey";

describe("textComparisonKey", () => {
  it.each([
    ["Díaz", "Diaz"],
    ["Gündoğan", "Gundogan"],
    ["Šeško", "Sesko"],
    ["João", "Joao"],
    ["Ødegaard", "Odegaard"],
    ["Łukasz", "Lukasz"],
    ["Đurić", "Duric"],
    ["Ðorđe", "Dorde"],
    ["Çalhanoğlu", "Calhanoglu"],
    ["Ægir", "Aegir"],
    ["Œuvre", "Oeuvre"],
    ["Þór", "Thor"],
    ["Straße", "Strasse"],
    ["김 민재", "김   민재"],
  ])("makes %s and %s equivalent", (left, right) => {
    expect(textComparisonKey(left)).toBe(textComparisonKey(right));
  });

  it("preserves Korean text while collapsing Unicode whitespace", () => {
    expect(textComparisonKey("  김\u00a0민재\n")).toBe("김 민재");
  });
});
