// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { nativePitchEventsV2EnvelopeSchema } from "../api/nativePitchEventsV2Contracts";
import { NativePitchSelectionCard } from "./NativePitchSelectionCard";

const packet = () => nativePitchEventsV2EnvelopeSchema.parse(JSON.parse(readFileSync(resolve(process.cwd(), "../docs/fixtures/native_pitch_v2/canonical_response.json"), "utf8")));
afterEach(cleanup);
describe("native selection card binding", () => {
  it("uses the selected middle-left box parts, not player-wide counts", () => {
    const data = packet();
    const zone = data.selectionZones.box.find(item => item.id === "L3L")!;
    const { container } = render(<NativePitchSelectionCard data={data} zone={{kind: "box", id: "L3L"}} controls={null} onClose={() => {}} />);
    expect(screen.getByText(zone.label)).toBeTruthy();
    expect(container.querySelector('[data-pitch-selection-card="zone"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: new RegExp(`오른발.*${zone.parts.rightFoot.shots}`) })).toBeTruthy();
    expect(container.textContent).toContain(`${zone.shootingSharePct!.toFixed(1)}%`);
  });
  it("one event never displays whole-player body counts and unknown clears highlights", () => {
    const data = packet();
    const event = data.events.find(item => item.bodyPart === "leftFoot")!;
    const props = {data, zone: null, controls: null, onClose: () => {}};
    const {container, rerender} = render(<NativePitchSelectionCard {...props} event={event} />);
    expect(container.querySelector('[data-pitch-selection-card="shot"]')).toBeTruthy();
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(1);
    expect(screen.getByRole("button", {name: /왼발.*1/})).toBeTruthy();
    rerender(<NativePitchSelectionCard {...props} event={{...event, bodyPart: "unknown"}} />);
    expect(container.querySelectorAll('[aria-pressed="true"]')).toHaveLength(0);
    expect(screen.getAllByText(/부위 미상/).length).toBeGreaterThan(0);
  });
  it("an unknown zone stays unavailable, never falls back to overview", () => {
    const {container} = render(<NativePitchSelectionCard data={packet()} zone={{kind: "grid", id: "missing"}} controls={null} onClose={() => {}} />);
    expect(screen.getByText("구역 통계 사용 불가")).toBeTruthy();
    expect(container.querySelector('[data-selection-quality="unavailable"]')).toBeTruthy();
  });
});
