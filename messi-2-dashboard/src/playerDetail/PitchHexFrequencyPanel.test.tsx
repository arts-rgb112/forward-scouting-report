// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { goalMouthBaselinePlayerFixture } from "../test/fixtures/goalMouthBaseline";
import { PitchHexFrequencyPanel } from "./PitchHexFrequencyPanel";

describe("PitchHexFrequencyPanel", () => {
  it("renders only server-authored occupied cells and keeps the color baseline empty", () => {
    const { container } = render(<PitchHexFrequencyPanel state={{ kind: "ready", key: "player", data: goalMouthBaselinePlayerFixture }}/>);
    expect(screen.getByText("좋은 자리에서 쏘나")).not.toBeNull();
    expect(container.querySelectorAll("[data-pitch-hex-cell]")).toHaveLength(2);
    expect(container.querySelector("[data-pitch-hex-cell='hex_p01_p00']")?.getAttribute("data-shots")).toBe("6");
    expect(container.querySelector("[data-pitch-hex-cell='hex_p01_p00']")?.getAttribute("fill")).toBe("none");
    expect(screen.getByText("헥스 색 = 리그 배치 기준선 · 준비 중")).not.toBeNull();
    expect(screen.getByText("표시 범위 밖 1 shots")).not.toBeNull();
  });
});
