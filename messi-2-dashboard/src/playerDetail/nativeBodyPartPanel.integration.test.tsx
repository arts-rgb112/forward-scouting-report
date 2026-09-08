// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BodyPartShootingPanel } from "./BodyPartShootingPanel";
import { PitchPenaltyProvider, PitchPenaltyToggle } from "./PitchPenaltyContext";
import { useNativeBodyPartStats } from "./useNativeBodyPartStats";
import type { DatasetRouteState } from "../dashboard/types";
import type { MessiApiConfig } from "../api/env";

/**
 * Exercises the real chain the 3D/2D routes actually wire: shared
 * `PitchPenaltyProvider` toggle → `useNativeBodyPartStats` (which reads that
 * toggle) → `BodyPartShootingPanel`. `Player3DRoute.test.tsx` mocks
 * `SpatialPitch` entirely, so it cannot prove this path; this file renders
 * the real hook and panel together, against the actual golden fixtures.
 */
const included = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-included-envelope.json"),
  "utf-8",
));
const excluded = JSON.parse(readFileSync(
  resolve(import.meta.dirname, "../../../../messi-specs/fixtures/native-body-parts-kane-2025-2026-quality-v2-excluded-envelope.json"),
  "utf-8",
));

const config: MessiApiConfig = { baseUrl: "https://api.example.com", season: "2025/2026", scope: 8, limit: 1000 };
const dataset: DatasetRouteState = { season: "2025/2026", mode: "league", scope: 8, competition: "all" };

function Wrapper({ dataset: ds, playerId = 194165 }: { dataset: DatasetRouteState; playerId?: number }) {
  return <PitchPenaltyProvider>
    <PitchPenaltyToggle />
    <Inner dataset={ds} playerId={playerId} />
  </PitchPenaltyProvider>;
}
function Inner({ dataset: ds, playerId }: { dataset: DatasetRouteState; playerId: number }) {
  const state = useNativeBodyPartStats(config, playerId, ds);
  return <BodyPartShootingPanel hasSelectedShot={false} state={state} />;
}

/** A shifted player id must be internally consistent (fotmobPlayerId,
 * mappingKey) with the requested playerId, matching what a real backend
 * would actually return for that player. */
function withPlayer(id: number) {
  return {
    ...included,
    context: { ...included.context, playerId: id },
    sources: included.sources.map((source: Record<string, unknown>) => ({ ...source, fotmobPlayerId: id, mappingKey: `${id}:${source.tournamentId}:${source.seasonId}` })),
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

describe("native body-part panel wired through the shared penalty toggle", () => {
  it("switches from included (119/36, right 84/27) to excluded (108/26, right 73/17) when the shared toggle flips, using real fixtures", async () => {
    const fetchSpy = vi.fn().mockImplementation((url: string) => {
      const includePenalties = new URL(url).searchParams.get("includePenalties") === "true";
      return Promise.resolve(new Response(JSON.stringify(includePenalties ? included : excluded), { status: 200, headers: { "content-type": "application/json" } }));
    });
    vi.stubGlobal("fetch", fetchSpy);
    const { container } = render(<Wrapper dataset={dataset} />);
    await waitFor(() => expect(container.querySelector("[data-bodypart-state]")).toHaveAttribute("data-bodypart-state", "ready"));
    expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("합계 119슛 · 36골");
    expect(container.querySelector('[data-shot-part="rightFoot"]')!.getAttribute("aria-label")).toContain("84 슛 · 27 득점");

    fireEvent.click(within(container).getByRole("button", { name: "페널티 제외" }));
    await waitFor(() => expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("합계 108슛 · 26골"));
    expect(container.querySelector('[data-shot-part="rightFoot"]')!.getAttribute("aria-label")).toContain("73 슛 · 17 득점");
    expect(container).toHaveTextContent("PK 제외");
  });

  it("cancels a stale in-flight response when the dataset context changes mid-request", async () => {
    // Both responses keep includePenalties:true (the untouched toggle
    // default) — only the season differs, so the fetch client's own
    // includePenalties identity check doesn't reject either as malformed.
    const shiftedIncluded = { ...included, context: { ...included.context, season: "2024/2025" }, sources: included.sources.map((s: Record<string, unknown>) => ({ ...s, season: "2024/2025" })) };
    let resolveFirst!: (value: Response) => void;
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(shiftedIncluded), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { container, rerender } = render(<Wrapper dataset={dataset} />);
    const nextDataset: DatasetRouteState = { season: "2024/2025", mode: "league", scope: 8, competition: "all" };
    rerender(<Wrapper dataset={nextDataset} />);
    await waitFor(() => expect(container.querySelector("[data-bodypart-source]")).toHaveTextContent("2024/2025"));
    resolveFirst(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } }));
    // the stale first (season 2025/2026) response must never overwrite the newer context's state
    expect(container.querySelector("[data-bodypart-source]")).toHaveTextContent("2024/2025");
    expect(container.querySelector("[data-bodypart-source]")).not.toHaveTextContent("2025/2026");
  });

  it("cancels a stale in-flight response when the selected player changes mid-request, not only season", async () => {
    let resolveFirst!: (value: Response) => void;
    const fetchSpy = vi.fn()
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveFirst = resolve; }))
      .mockResolvedValueOnce(new Response(JSON.stringify(withPlayer(999999)), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchSpy);
    const { container, rerender } = render(<Wrapper dataset={dataset} playerId={194165} />);
    rerender(<Wrapper dataset={dataset} playerId={999999} />);
    await waitFor(() => expect(container.querySelector("[data-bodypart-panel]")).toHaveAttribute("data-bodypart-state", "ready"));
    resolveFirst(new Response(JSON.stringify(withPlayer(194165)), { status: 200, headers: { "content-type": "application/json" } }));
    // still resolved for player 999999's request — the stale player-194165
    // response (which was itself perfectly valid for its own request) must
    // never land after a newer player has already been selected.
    expect(fetchSpy.mock.calls[1][0]).toContain("/players/999999/");
    expect(container.querySelector("[data-bodypart-panel]")).toHaveAttribute("data-bodypart-state", "ready");
  });

  it("cancels a stale response from a rapid PK-toggle double-click, landing on the second (current) choice, not the first", async () => {
    // Three real requests happen here: the initial mount (default 포함), the
    // 제외 click, then the rapid flip back to 포함 — each response must match
    // its own request's includePenalties or the client's own identity check
    // would reject it as malformed, which is not the bug this proves.
    let resolveStale!: (value: Response) => void;
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } })) // mount, 포함
      .mockImplementationOnce(() => new Promise<Response>((resolve) => { resolveStale = resolve; })) // 제외 click — stays pending
      .mockResolvedValueOnce(new Response(JSON.stringify(included), { status: 200, headers: { "content-type": "application/json" } })); // 포함 click — resolves immediately
    vi.stubGlobal("fetch", fetchSpy);
    const { container } = render(<Wrapper dataset={dataset} />);
    await waitFor(() => expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("합계 119슛 · 36골"));
    fireEvent.click(within(container).getByRole("button", { name: "페널티 제외" }));
    fireEvent.click(within(container).getByRole("button", { name: "페널티 포함" })); // rapid flip back before the 제외 request settles
    await waitFor(() => expect(container).toHaveTextContent("PK 포함"));
    expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("합계 119슛 · 36골");
    resolveStale(new Response(JSON.stringify(excluded), { status: 200, headers: { "content-type": "application/json" } }));
    // the stale 제외 response (108/26), even though perfectly valid for its
    // own request, must not clobber the current 포함 state once it lands late.
    expect(container.querySelector("[data-bodypart-totals]")).toHaveTextContent("합계 119슛 · 36골");
    expect(container).toHaveTextContent("PK 포함");
  });
});
