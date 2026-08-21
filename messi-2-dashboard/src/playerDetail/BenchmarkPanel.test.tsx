// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import ratioObservedZero from "../../../docs/fixtures/ratio_benchmark_v1/observed_zero_imputed.json";
import volumeObservedZero from "../../../docs/fixtures/volume_benchmark_v1/observed_zero.json";

import { ratioBenchmarkEnvelopeSchema } from "../api/ratioBenchmarkContracts";
import { volumeBenchmarkEnvelopeSchema } from "../api/volumeBenchmarkContracts";
import { BenchmarkPanel } from "./VolumeBenchmarkRadar";

const volume = volumeBenchmarkEnvelopeSchema.parse(volumeObservedZero).data;
const ratio = ratioBenchmarkEnvelopeSchema.parse(ratioObservedZero).data;
if (!volume.available || !ratio.available) throw new Error("test fixtures must be available");
afterEach(cleanup);
describe("compact authoritative benchmark panel", () => {
  it("uses roving WAI-ARIA tabs and switches focus with keyboard to namespaced ratio polygons", () => {
    render(<BenchmarkPanel volume={{ kind: "ready", data: volume }} ratio={{ kind: "ready", data: ratio }} playerName="Player" onVolumeRetry={vi.fn()} onRatioRetry={vi.fn()}/>);
    const volumeTab = screen.getByRole("tab", { name: "volume" }); const ratioTab = screen.getByRole("tab", { name: "ratio" });
    expect(volumeTab).toHaveClass("min-h-11"); expect(volumeTab).toHaveAttribute("tabindex", "0"); expect(ratioTab).toHaveAttribute("tabindex", "-1"); expect(volumeTab).toHaveAttribute("aria-controls"); expect(volumeTab).toHaveAttribute("id");
    const volumePanel = screen.getByRole("tabpanel"); expect(volumePanel).toHaveAttribute("id", volumeTab.getAttribute("aria-controls")!); expect(volumePanel).toHaveAttribute("aria-labelledby", volumeTab.id); expect(document.querySelectorAll("[data-series]")).toHaveLength(2); expect(document.querySelectorAll('[data-benchmark-mode="volume"]')).toHaveLength(2);
    volumeTab.focus(); fireEvent.keyDown(volumeTab, { key: "ArrowRight" }); expect(document.activeElement).toBe(ratioTab); expect(ratioTab).toHaveAttribute("aria-selected", "true"); expect(ratioTab).toHaveAttribute("tabindex", "0"); expect(volumeTab).toHaveAttribute("tabindex", "-1"); const ratioPanel = screen.getByRole("tabpanel"); expect(ratioPanel).toHaveAttribute("id", ratioTab.getAttribute("aria-controls")!); expect(ratioPanel).toHaveAttribute("aria-labelledby", ratioTab.id); expect(screen.getByRole("region", { name: "Ratio benchmark radar" })).toBeInTheDocument(); expect(document.querySelectorAll("[data-series]")).toHaveLength(2); expect(document.querySelectorAll('[data-benchmark-mode="ratio"]')).toHaveLength(2); expect(document.querySelector('[id*="ratio"][data-series="player"]')).toBeTruthy();
    fireEvent.keyDown(ratioTab, { key: "ArrowLeft" }); expect(document.activeElement).toBe(volumeTab); expect(screen.getByRole("region", { name: "Volume benchmark radar" })).toBeInTheDocument();
  });
  it("keeps zero distinct from null and exposes imputation without a 50 fallback", () => {
    render(<BenchmarkPanel volume={{ kind: "ready", data: volume }} ratio={{ kind: "ready", data: ratio }} playerName="Player" onVolumeRetry={vi.fn()} onRatioRetry={vi.fn()}/>); fireEvent.click(screen.getByRole("tab", { name: "ratio" }));
    const panel = screen.getByRole("region", { name: "Ratio benchmark radar" }); expect(panel).toHaveTextContent("Raw 0"); expect(panel).toHaveTextContent("Raw unavailable"); expect(panel).toHaveTextContent("source-imputed"); expect(panel).not.toHaveTextContent("Raw 50");
  });
});
