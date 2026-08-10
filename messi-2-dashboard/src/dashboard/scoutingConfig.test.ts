import { describe, expect, it } from "vitest";
import { getScoreBand } from "./scoutingConfig";

describe("getScoreBand", () => {
  it.each([[100, "엘리트"], [90, "엘리트"], [89, "우수"], [80, "우수"], [79, "보통"], [70, "보통"], [69, "보완"], [0, "보완"]] as const)("maps %s to %s", (score, label) => expect(getScoreBand(score).label).toBe(label));
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("handles invalid %s defensively", (score) => expect(getScoreBand(score).label).toBe("보완"));
});
