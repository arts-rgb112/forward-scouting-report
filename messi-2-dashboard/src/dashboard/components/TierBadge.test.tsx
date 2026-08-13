// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { TierBadge } from "./TierBadge";

describe("TierBadge taxonomy compatibility", () => {
  it.each([
    ["diamond", "Diamond", "◆", "border-violet-300/45"], ["emerald", "Emerald", "✦", "border-emerald-300/45"],
    ["platinum", "Platinum", "⬟", "border-cyan-300/45"], ["gold", "Gold", "●", "border-amber-300/45"],
    ["silver", "Silver", "●", "border-slate-300/45"], ["bronze", "Bronze", "●", "border-orange-300/45"],
  ] as const)("shows full crystal-v2 %s text, glyph, color and level even when compact", (code, label, glyph, token) => {
    const { container } = render(<TierBadge compact tier={{ code, label, level: 3, taxonomyVersion: "crystal-v2" }} />);
    expect(screen.getByLabelText(`Overall M.E.S.S.I. tier: ${label}, level 3`)).toHaveTextContent(`${glyph}${label}Lv.3`);
    expect(container.firstElementChild).toHaveClass(token);
  });

  it("does not mistake legacy platinum for crystal Platinum", () => {
    const { container } = render(<TierBadge tier={{ code: "platinum", label: "Platinum I", level: 1 }} />);
    expect(screen.getByLabelText("Overall M.E.S.S.I. tier: Legacy Platinum, level 1")).toBeInTheDocument();
    expect(container.firstElementChild).toHaveClass("border-emerald-300/45");
  });

  it("renders unrecognized input as a neutral safe badge", () => {
    render(<TierBadge tier={{ code: "ruby", label: "Ruby", level: 1, taxonomyVersion: "future-v9" }} />);
    expect(screen.getByLabelText("Overall M.E.S.S.I. tier: Unknown tier, level 1")).toHaveAttribute("title", expect.stringContaining("Unknown tier"));
  });
});
