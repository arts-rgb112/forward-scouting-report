// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { duelPressDetailReadoutEnvelopeSchema } from "../api/duelPressDetailReadoutContracts";
import { detailReadoutFixture } from "../test/fixtures/duelPressDetailReadouts";
import { DuelPressDetailReadoutBoard } from "./DuelPressDetailReadoutBoard";

describe("duel-press detailed stats board", () => {
  it("renders the six renewed labels, raw rows, duel subgroups, and two auxiliary modules", () => { const data = duelPressDetailReadoutEnvelopeSchema.parse(detailReadoutFixture); const { container } = render(<DuelPressDetailReadoutBoard data={data}/>); const section = screen.getByRole("region", { name: "Duel press detailed stats board" }); expect(within(section).getAllByRole("heading", { level: 3 }).map((node) => node.textContent)).toEqual(["박스 밖 슈팅", "박스 안 슈팅", "온볼 전개 영향력", "통합 경합", "오프 더 볼", "전방 압박 효율", "순수 전진 기여도", "득점 운 · 상대 선방"]); expect(within(section).queryByText("AER")).not.toBeInTheDocument(); expect(within(section).getByRole("region", { name: "지상 경합" })).toHaveTextContent("groundWonPer90"); expect(within(section).getByRole("region", { name: "공중 경합" })).toHaveTextContent("aerialWonPer90"); expect(within(section).getByText("제공 불가")).toBeInTheDocument(); expect(within(section).getAllByText("0").length).toBeGreaterThan(0); expect(container.querySelector('[data-layout="detail-readout-grid"]')).toHaveClass("md:grid-cols-2", "xl:grid-cols-3"); expect(container.querySelector('[data-layout="auxiliary-measurements"]')).toHaveClass("md:grid-cols-2"); expect(container.querySelector('[data-layout="auxiliary-measurements"] .shadow')).toBeNull(); });
});
