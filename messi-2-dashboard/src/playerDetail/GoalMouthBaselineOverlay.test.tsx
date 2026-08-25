// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { finalThirdShotMapFixture } from "../test/fixtures/finalThirdShotMap";
import { goalMouthBaselineFixture, goalMouthBaselineLowSampleFixture } from "../test/fixtures/goalMouthBaseline";
const baseline = vi.hoisted(() => ({ value: undefined as any }));
vi.mock("./useGoalMouthBaseline", () => ({ useGoalMouthBaseline: () => baseline.value }));
import { GoalMouthView } from "./GoalMouthView";
describe("Goal-Mouth baseline overlay", () => {
  it("renders the exact server grid under markers, toggles it, and maps top-row z without inversion", () => {
    baseline.value = { state: { kind: "ready", key: "goal-mouth-baseline-v1", data: goalMouthBaselineFixture }, retry: vi.fn() };
    const { container } = render(<GoalMouthView data={finalThirdShotMapFixture.data as never} config={{ baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 50 }}/>);
    expect(container.querySelectorAll("[data-goal-mouth-baseline-cell]")).toHaveLength(50);
    const topLeft = container.querySelector("[data-goal-mouth-baseline-cell='row5_column1'] rect")!;
    const bottomLeft = container.querySelector("[data-goal-mouth-baseline-cell='row1_column1'] rect")!;
    expect(Number(topLeft.getAttribute("y"))).toBeLessThan(Number(bottomLeft.getAttribute("y")));
    expect(container.querySelector("[data-goal-mouth-shot]")!.compareDocumentPosition(container.querySelector("[data-goal-mouth-baseline]")!)).toBe(Node.DOCUMENT_POSITION_PRECEDING);
    fireEvent.click(screen.getByRole("button", { name: "Goal probability baseline" })); expect(container.querySelector("[data-goal-mouth-baseline]")).toBeNull();
  });
  it("keeps a low-sample server value visible with hatch and confidence tooltip", () => {
    baseline.value = { state: { kind: "ready", key: "goal-mouth-baseline-v1", data: goalMouthBaselineLowSampleFixture }, retry: vi.fn() };
    const { container } = render(<GoalMouthView data={finalThirdShotMapFixture.data as never} config={{ baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 50 }}/>);
    const cell = container.querySelector("[data-goal-mouth-baseline-cell='row1_column1']")!; expect(cell).toHaveAttribute("data-baseline-state", "low_sample"); expect(cell.querySelector("[data-baseline-low-sample-hatch]")).toBeInTheDocument(); fireEvent.focus(cell); expect(container.querySelector("[data-goal-mouth-baseline-tooltip]")).toHaveTextContent("95% CI 12.0–65.0%");
  });
});
