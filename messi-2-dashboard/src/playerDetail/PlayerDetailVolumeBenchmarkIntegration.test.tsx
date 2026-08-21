// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
const hook = vi.hoisted(() => vi.fn(() => ({state:{kind:"disabled" as const},retry:vi.fn()})));
vi.mock("./useVolumeBenchmark", () => ({ useVolumeBenchmark: hook }));
import { VolumeBenchmarkRadar } from "./PlayerDetailRoute";
import { samplePlayers } from "../test/fixtures/players";
describe("detail benchmark integration", () => { it("passes the parent API config, player id and dataset unchanged", () => { const config={baseUrl:"https://authoritative.example.test",season:"2024/2025",scope:7 as const,limit:1000}; const dataset={season:"2024/2025",mode:"europe" as const,scope:7 as const,competition:"uel" as const}; render(<VolumeBenchmarkRadar player={samplePlayers[0]} config={config} dataset={dataset}/>); expect(screen.getByRole("region",{name:"Volume benchmark radar"})).toBeInTheDocument(); expect(hook).toHaveBeenCalledWith(config,samplePlayers[0].id,dataset); }); });
