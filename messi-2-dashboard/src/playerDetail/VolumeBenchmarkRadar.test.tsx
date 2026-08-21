// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { observedZeroBenchmarkData, successBenchmarkData, unavailableBenchmarkData } from "../test/volumeBenchmarkFixtures";
import { VolumeBenchmarkRadar } from "./VolumeBenchmarkRadar";

afterEach(cleanup);

describe("server volume benchmark radar", () => {
  it("draws exactly player and average polygons, server labels, and zero/null/imputed readouts", () => {
    render(<VolumeBenchmarkRadar state={{ kind: "ready", data: observedZeroBenchmarkData }} playerName="Player" onRetry={vi.fn()} />);
    const panel = screen.getByRole("region", { name: "Volume benchmark radar" });
    expect(panel.querySelectorAll("[data-series]")).toHaveLength(2);
    expect(panel.querySelectorAll("[data-series=player]")).toHaveLength(1);
    expect(panel.querySelectorAll("[data-series=average]")).toHaveLength(1);
    expect(panel).toHaveTextContent("Outside-box shot attempts");
    expect(panel).toHaveTextContent("Core activity radius");
    expect(panel).toHaveTextContent("Player 0/100");
    expect(panel).toHaveTextContent("Raw 0");
    expect(panel).toHaveTextContent("Raw unavailable");
    expect(panel).toHaveTextContent("source-incomplete");
    expect(screen.getAllByRole("button")).toHaveLength(6);
  });

  it("uses canonical success labels rather than client labels", () => {
    render(<VolumeBenchmarkRadar state={{ kind: "ready", data: successBenchmarkData }} playerName="Player" onRetry={vi.fn()} />);
    expect(screen.getByText("Ground duel attempts")).toBeInTheDocument();
  });

  it("contains very large finite readouts at 320px", () => {
    const data = { ...successBenchmarkData, axes: successBenchmarkData.axes.map((axis) => ({ ...axis, playerRawValue: 9.99e300, averageRawValue: 8.88e299, playerRank: 999999999, population: 999999999 })) };
    render(<VolumeBenchmarkRadar state={{ kind: "ready", data: data as typeof successBenchmarkData }} playerName="A very long player name" onRetry={vi.fn()} />);
    const panel = screen.getByRole("region", { name: "Volume benchmark radar" });
    expect(panel).toHaveClass("min-w-0", "overflow-hidden", "[overflow-wrap:anywhere]", "[&_button]:min-w-0", "[&_button]:break-words");
    expect(screen.getAllByRole("button")).toHaveLength(6);
  });

  it("draws no data polygon in non-ready states and exposes retry only for error", () => {
    const retry = vi.fn();
    const view = render(<VolumeBenchmarkRadar state={{ kind: "loading" }} playerName="Player" onRetry={retry} />);
    expect(document.querySelectorAll("[data-series]")).toHaveLength(0);
    view.rerender(<VolumeBenchmarkRadar state={{ kind: "error" }} playerName="Player" onRetry={retry} />);
    screen.getByRole("button", { name: "Retry" }).click();
    expect(retry).toHaveBeenCalledOnce();
    expect(document.querySelectorAll("[data-series]")).toHaveLength(0);
    view.rerender(<VolumeBenchmarkRadar state={{ kind: "unavailable", data: unavailableBenchmarkData }} playerName="Player" onRetry={retry} />);
    expect(document.querySelectorAll("[data-series]")).toHaveLength(0);
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });
});
