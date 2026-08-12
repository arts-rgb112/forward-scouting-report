import { describe, expect, it } from "vitest";
import { getScoreBand } from "./scoutingConfig";

describe("getScoreBand", () => {
  it.each([[100, "90–100"], [90, "90–100"], [89, "80–89"], [80, "80–89"], [79, "70–79"], [70, "70–79"], [69, "60–69"], [60, "60–69"], [59, "50–59"], [50, "50–59"], [49, "0–49"], [0, "0–49"]] as const)("maps %s to %s", (score, rangeLabel) => expect(getScoreBand(score).rangeLabel).toBe(rangeLabel));
  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("uses the stone fallback for invalid %s", (score) => expect(getScoreBand(score).rangeLabel).toBe("0–49"));
});
