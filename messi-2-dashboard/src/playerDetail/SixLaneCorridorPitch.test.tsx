// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { PitchPenaltyProvider, PitchPenaltyToggle } from "./PitchPenaltyContext";
import { SixLaneCorridorPitch } from "./SixLaneCorridorPitch";
import { DEFAULT_PITCH_LAYERS } from "./pitchLayers";

const analysis = {
  spatial: {
    available: true,
    heatmapPointCount: 3,
    heatmapPoints: [{ x: 80, y: 40 }, { x: 81, y: 42 }, { x: 82, y: 44 }],
    shotmapSnapshotAvailable: true,
    shotmapPointCount: 3,
    shotmapPoints: [
      { x: 80, y: 40, outcome: "goal", xg: .4, xgot: .6 },
      { x: 89.524, y: 50, outcome: "goal", xg: .79, xgot: .8 },
      { x: 71.049, y: 50, outcome: "off_target", xg: .02, xgot: null },
    ],
    continuousCore: { available: false },
  },
} as never;

describe("SixLaneCorridorPitch", () => {
  it("keeps the field clear, uses simple result markers, and shares the PK state", () => {
    const { container } = render(<PitchPenaltyProvider><PitchPenaltyToggle/><SixLaneCorridorPitch analysis={analysis} layers={DEFAULT_PITCH_LAYERS}/></PitchPenaltyProvider>);
    const corridor = container.querySelector('[data-layout="six-lane-corridor-pitch"]')!;
    const svg = within(corridor).getByRole("img");
    expect(svg.querySelectorAll("text")).toHaveLength(0);
    expect(svg.querySelectorAll("[data-lane]")).toHaveLength(6);
    expect(svg.querySelector('[data-layer="positional-grid"]')).not.toBeNull();
    expect(svg.querySelector('[data-layer="pk-axis"]')).toBeNull();
    expect(svg.querySelectorAll('[data-pitch-shot-marker]')).toHaveLength(0);
    expect(within(svg).getAllByRole("button", { name: /슛 상세/ })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "페널티 제외" }));
    expect(within(svg).getAllByRole("button", { name: /슛 상세/ })).toHaveLength(2);
    fireEvent.click(within(svg).getAllByRole("button", { name: "goal 슛 상세" })[0]);
    expect(within(corridor).getByLabelText("슈팅 상세")).toHaveTextContent("xG 0.40");
    fireEvent.click(within(corridor).getByRole("button", { name: "확대" }));
    expect(within(corridor).getByText("1.2배")).toBeInTheDocument();
    Object.defineProperty(corridor.querySelector('[data-zoom-pan]')!.parentElement!, "getBoundingClientRect", { value: () => ({ width: 300, height: 190 }) });
    fireEvent.pointerDown(svg, { pointerId: 1, clientX: 50, clientY: 50 });
    fireEvent.pointerMove(svg, { pointerId: 1, clientX: 70, clientY: 60 });
    fireEvent.pointerUp(svg, { pointerId: 1 });
    expect(corridor.querySelector('[data-zoom-pan]')).toHaveStyle({ transform: "translate(20px, 10px) scale(1.2)" });
  });
});
