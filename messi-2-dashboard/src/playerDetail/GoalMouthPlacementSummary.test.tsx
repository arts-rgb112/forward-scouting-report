// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { goalMouthBaselinePlayerFixture } from "../test/fixtures/goalMouthBaseline";
import { finalThirdShotMapFixture } from "../test/fixtures/finalThirdShotMap";
import { GoalMouthView } from "./GoalMouthView";

describe("GoalMouth placement summary", () => {
  it("renders only the server-authored placement value and sample", () => {
    const { container } = render(<GoalMouthView data={finalThirdShotMapFixture.data as never} baselineResource={{ kind: "ready", key: "player", data: goalMouthBaselinePlayerFixture }}/>);
    expect(container.querySelector("[data-placement-summary]")?.textContent).toContain("골문 안 슛67");
    expect(container.querySelector("[data-placement-summary]")?.textContent).toContain("기대 득점23.55");
    expect(container.querySelector("[data-placement-summary]")?.textContent).toContain("실제 득점36");
    expect(container.querySelector("[data-placement-summary]")?.textContent).toContain("차이+12.45");
  });
});
