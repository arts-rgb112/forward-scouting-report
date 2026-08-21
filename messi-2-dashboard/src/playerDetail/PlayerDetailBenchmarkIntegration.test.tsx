// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const volumeHook = vi.hoisted(() => vi.fn(() => ({ state: { kind: "disabled" as const }, retry: vi.fn() })));
const ratioHook = vi.hoisted(() => vi.fn(() => ({ state: { kind: "disabled" as const }, retry: vi.fn() })));
vi.mock("./useVolumeBenchmark", () => ({ useVolumeBenchmark: volumeHook }));
vi.mock("./useRatioBenchmark", () => ({ useRatioBenchmark: ratioHook }));
import { Benchmark } from "./PlayerDetailRoute";
import { samplePlayers } from "../test/fixtures/players";

describe("detail benchmark route integration", () => {
  it("starts both independent resources from the exact parent identity and mode switching does not restart either", () => {
    const config = { baseUrl: "https://authoritative.example.test", season: "2024/2025", scope: 7 as const, limit: 1000 }; const dataset = { season: "2024/2025", mode: "europe" as const, scope: 7 as const, competition: "uel" as const };
    render(<Benchmark player={samplePlayers[0]} config={config} dataset={dataset}/>); expect(volumeHook).toHaveBeenCalledWith(config, samplePlayers[0].id, dataset); expect(ratioHook).toHaveBeenCalledWith(config, samplePlayers[0].id, dataset);
    fireEvent.click(screen.getByRole("tab", { name: "ratio" })); expect(volumeHook).toHaveBeenCalledTimes(1); expect(ratioHook).toHaveBeenCalledTimes(1);
  });
});
