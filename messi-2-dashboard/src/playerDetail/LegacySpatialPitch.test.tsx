// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { LegacySpatialPitch } from "./LegacySpatialPitch";

const core = { available: true, definitionVersion: "continuous-hdr-50-v1", targetDensityPct: 50, achievedDensityPct: 50, coreAreaPct: 5, densityThreshold: .1, thresholdOfPeak: .5, gridColumns: 32, gridRows: 22 };
const baseSpatial = { available: true, source: "messi-static-cohort", heatmapPointCount: 2, heatmapPoints: [{ x: 10, y: 20 }, { x: 90, y: 80 }], shotmapSnapshotAvailable: true, shotmapPointCount: 4, shotmapPoints: [{ x: 10, y: 20, outcome: "goal" }, { x: 20, y: 30, outcome: "on_target" }, { x: 30, y: 40, outcome: "off_target" }, { x: 40, y: 50, outcome: "blocked" }], continuousCore: core, inBoxRatio: null, outBoxFinalRatio: null, midThirdRatio: null, finalThirdRatio: null, ccaAreaPct: null, laneRatios: [], depthRatios: [], positionalGrid: [], trueCore: { available: false, definitionVersion: "true-core-30-zone-v1", targetDensityPct: 50, achievedDensityPct: 0, coreAreaPct: 0, zoneIds: [], zones: [] }, dangerZoneDensity: null, deepBoxZoneScore: null };
const analysis = (spatial: unknown) => ({ spatial }) as never;

describe("LegacySpatialPitch", () => {
  it("renders one source shot per marker and retains the exact legacy summary/count lines", () => {
    render(<LegacySpatialPitch analysis={analysis(baseSpatial)} />);
    const section = screen.getByRole("region", { name: "Spatial pitch" });
    expect(within(section).getByText("2 activity points. 4 shots. Goal ◇ · on target ● · off target × · blocked ■.")).toBeInTheDocument();
    expect(section.querySelectorAll("[data-shot-index]")).toHaveLength(4);
    expect(section.querySelectorAll('[data-shot-outcome="goal"]')).toHaveLength(1);
    expect(section.querySelector('[data-layer="cca-contour"]')).toHaveAttribute("stroke", "#C044FF");
    expect(section).toHaveTextContent("Goals 1"); expect(section).toHaveTextContent("On target 1"); expect(section).toHaveTextContent("Off target 1"); expect(section).toHaveTextContent("Blocked 1");
  });

  it("fails closed on heatmap or shot count integrity mismatches", () => {
    const { rerender, container } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, heatmapPointCount: 3 })} />);
    expect(screen.getByText(/Activity heatmap integrity mismatch/)).toBeInTheDocument();
    rerender(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, shotmapPointCount: 3 })} />);
    expect(screen.getByText(/Shot snapshot integrity mismatch/)).toBeInTheDocument();
    expect(container.querySelectorAll("[data-shot-index]")).toHaveLength(0);
  });

  it("distinguishes unavailable snapshots from verified zero snapshots", () => {
    const { rerender } = render(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, available: false, heatmapPointCount: 0, heatmapPoints: [], shotmapSnapshotAvailable: false, shotmapPointCount: 0, shotmapPoints: [] })} />);
    expect(screen.getByText(/Activity heatmap unavailable.*Shot snapshot unavailable/)).toBeInTheDocument();
    rerender(<LegacySpatialPitch analysis={analysis({ ...baseSpatial, heatmapPointCount: 0, heatmapPoints: [], shotmapPointCount: 0, shotmapPoints: [] })} />);
    expect(screen.getByText(/Verified zero activity points.*Verified zero shots/)).toBeInTheDocument();
  });
});
