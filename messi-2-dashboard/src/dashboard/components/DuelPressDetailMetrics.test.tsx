// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { adaptDuelPressPlayerCore } from "../../api/duelPressAdapter";
import { DuelPressDetailMetrics } from "./DuelPressDetailMetrics";
const wire = { id: 7, idNamespace: "fotmob" as const, rank: 9, score: 87.25, stats: { outsideShot: 1, boxThreat: 2, dangerZone: 3, combinedDuel: 4, spaceControl: 5, forwardPress: 6 }, components: { combinedDuelVolume: 7, combinedDuelEfficiency: 8, recoveries: 9, finalThirdPossessionsWon: 10 }, pressingRawMetrics: { recoveries: 0, recoveriesPer90: 0, recoveriesSource: "player_season_total" as const, finalThirdPossessionsWon: null, finalThirdPossessionsWonPer90: null, finalThirdPossessionsWonSource: null } };
describe("DuelPressDetailMetrics", () => {
  it("copies server score/rank/stats without recomputation", () => { const player = adaptDuelPressPlayerCore(wire); expect(player).toMatchObject({ score: 87.25, rank: 9, stats: wire.stats }); expect(player.stats).not.toBe(wire.stats); });
  it("renders measured zero separately from unavailable raw data with 3x2 metrics", () => {
    const { container } = render(<DuelPressDetailMetrics player={adaptDuelPressPlayerCore(wire)} />);
    expect(screen.getByLabelText("Recoveries per 90: 0.00, player season total")).toHaveTextContent("0.00");
    expect(screen.getByLabelText("Final-third possessions won per 90: 데이터 없음, 측정된 0이 아님, unavailable")).toHaveTextContent("-");
    expect(container.querySelector(".grid-cols-3.md\\:grid-cols-6")?.children).toHaveLength(6);
    expect(screen.getByText("구성요소는 지표 설명용이며 전체 점수를 브라우저에서 다시 계산하지 않습니다.")).toBeInTheDocument();
  });
});
