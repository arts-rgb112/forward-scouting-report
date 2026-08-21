// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup } from "@testing-library/react";

import { MetricScore } from "./MetricScore";

afterEach(cleanup);

describe("MetricScore metric-ranks companion display", () => {
  it("shows the exact server rank in the tooltip slot, not a visible score-band label", () => {
    render(<MetricScore playerId={1} metric="outsideShot" value={82} surface="table" metricRank={{ state: "resolved", rank: 14, population: 673 }} />);
    fireEvent.focus(screen.getByLabelText(/82/));
    expect(screen.getByRole("tooltip")).toHaveTextContent("82/100 · 전체 14위 / 673명");
    expect(screen.getByRole("tooltip")).not.toHaveTextContent("82/100 · 80–89");
  });

  it("keeps saved, pending, and unavailable rank states explicit", () => {
    const { rerender } = render(<MetricScore playerId={1} metric="outsideShot" value={82} surface="table" snapshot />);
    fireEvent.focus(screen.getByLabelText(/82/));
    expect(screen.getByRole("tooltip")).toHaveTextContent("전체 순위 정보 없음");
    rerender(<MetricScore playerId={1} metric="outsideShot" value={82} surface="table" metricRank={{ state: "pending" }} />);
    fireEvent.focus(screen.getByLabelText(/82/));
    expect(screen.getByRole("tooltip")).toHaveTextContent("전체 순위 확인 중");
    rerender(<MetricScore playerId={1} metric="outsideShot" value={82} surface="table" metricRank={{ state: "unavailable" }} />);
    fireEvent.focus(screen.getByLabelText(/82/));
    expect(screen.getByRole("tooltip")).toHaveTextContent("전체 순위 정보 없음");
  });
});
