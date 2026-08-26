// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { currentPagePath, currentRouteKey, ensureGa4, gaMeasurementId, pageViewContext, sendGa4PageView, useGa4PageViews } from "./ga4";

function Tracker({ id }: { id?: string }) { useGa4PageViews(id); return null; }
function resetGa() {
  document.querySelectorAll("script[data-messi-ga4-id]").forEach((node) => node.remove());
  delete (window as Window & { dataLayer?: unknown[][] }).dataLayer;
  delete (window as Window & { gtag?: unknown }).gtag;
  delete (window as Window & { __messiGa4ConfiguredId?: string }).__messiGa4ConfiguredId;
  delete (window as Window & { __messiGa4LastPath?: string }).__messiGa4LastPath;
  window.history.replaceState(null, "", "/");
}
afterEach(resetGa);

describe("GA4 SPA telemetry", () => {
  it("is fail-closed for missing or invalid environment values", () => {
    expect(gaMeasurementId({})).toBeUndefined();
    expect(gaMeasurementId({ VITE_GA_MEASUREMENT_ID: "not-a-ga-id" })).toBeUndefined();
    expect(ensureGa4(undefined)).toBe(false);
    expect(document.querySelector("script[data-messi-ga4-id]")).toBeNull();
  });

  it("loads the tag once, disables automatic page views, and de-duplicates the same route", () => {
    const id = gaMeasurementId({ VITE_GA_MEASUREMENT_ID: "G-8ZFS0ZM3NS" });
    window.history.replaceState(null, "", "/players/194165?season=2025%2F2026&mode=league&scope=7&competition=all");
    expect(sendGa4PageView(id, currentPagePath(), "Kane", currentRouteKey())).toBe(true);
    expect(sendGa4PageView(id, currentPagePath(), "Kane", currentRouteKey())).toBe(false);
    expect(document.querySelectorAll("script[data-messi-ga4-id=G-8ZFS0ZM3NS]")).toHaveLength(1);
    expect((window as Window & { dataLayer: unknown[][] }).dataLayer).toContainEqual(["config", "G-8ZFS0ZM3NS", { send_page_view: false }]);
    expect((window as Window & { dataLayer: unknown[][] }).dataLayer.filter(([kind, name]) => kind === "event" && name === "page_view")).toHaveLength(1);
    expect((window as Window & { dataLayer: unknown[][] }).dataLayer).toContainEqual(["event", "page_view", expect.objectContaining({ page_path: "/players/194165", messi_season: "2025/2026", messi_mode: "league", messi_scope: "7", messi_competition: "all" })]);
  });

  it("emits a new page_view when SPA history changes", async () => {
    render(<Tracker id="G-8ZFS0ZM3NS" />);
    await waitFor(() => expect((window as Window & { dataLayer?: unknown[][] }).dataLayer?.filter(([kind, name]) => kind === "event" && name === "page_view")).toHaveLength(1));
    act(() => { window.history.pushState(null, "", "/players/194165?season=2025%2F2026"); });
    await waitFor(() => expect((window as Window & { dataLayer?: unknown[][] }).dataLayer?.filter(([kind, name]) => kind === "event" && name === "page_view")).toHaveLength(2));
    expect(currentPagePath()).toBe("/players/194165");
    expect(currentRouteKey()).toBe("/players/194165?season=2025%2F2026");
    expect(pageViewContext()).toEqual({ messi_season: "2025/2026" });
  });

  it("keeps player page_path stable while recording a changed analysis context", async () => {
    render(<Tracker id="G-8ZFS0ZM3NS" />);
    await waitFor(() => expect((window as Window & { dataLayer?: unknown[][] }).dataLayer?.filter(([kind, name]) => kind === "event" && name === "page_view")).toHaveLength(1));
    act(() => { window.history.pushState(null, "", "/players/194165?season=2024%2F2025&mode=league&scope=8&competition=all"); });
    await waitFor(() => expect((window as Window & { dataLayer?: unknown[][] }).dataLayer?.filter(([kind, name]) => kind === "event" && name === "page_view")).toHaveLength(2));
    const events = (window as Window & { dataLayer: unknown[][] }).dataLayer.filter(([kind, name]) => kind === "event" && name === "page_view");
    expect(events.at(-1)).toEqual(["event", "page_view", expect.objectContaining({ page_path: "/players/194165", messi_season: "2024/2025", messi_scope: "8" })]);
  });
});
