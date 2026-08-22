// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const child = vi.hoisted(() => ({ normalizeRoot: false }));

vi.mock("../dashboard/PlayersResourceContainer", async () => {
  const { useLayoutEffect } = await import("react");
  return {
    PlayersResourceContainer: () => {
      useLayoutEffect(() => {
        if (child.normalizeRoot) window.history.replaceState(null, "", "/?season=2025%2F2026&mode=league&scope=8&page=1&pageSize=50&sort=score&direction=desc");
      }, []);
      return <main data-testid="dashboard-container">Native dashboard</main>;
    },
  };
});

import App from "./App";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
beforeEach(() => { child.normalizeRoot = false; });

describe("root routing", () => {
  it.each(["/", "/?"])("keeps %s on the native dashboard without a recovery rewrite", (path) => {
    window.history.replaceState(null, "", path);
    render(<App />);
    expect(screen.getByTestId("dashboard-container")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).not.toContain("recovery=invalid-legacy-link");
  });

  it("keeps the dashboard when its child normalizes root before legacy routing", async () => {
    child.normalizeRoot = true;
    window.history.replaceState(null, "", "/");
    render(<App />);
    await waitFor(() => expect(window.location.search).toContain("page=1"));
    expect(screen.getByTestId("dashboard-container")).toBeInTheDocument();
    expect(window.location.search).not.toContain("recovery=invalid-legacy-link");
  });
});
