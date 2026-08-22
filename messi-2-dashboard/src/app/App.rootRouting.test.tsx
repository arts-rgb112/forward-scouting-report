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

vi.mock("./StaticRoute", () => ({ StaticRoute: () => <main data-testid="static-route">Native route</main> }));

import App from "./App";

afterEach(() => { cleanup(); window.history.replaceState(null, "", "/"); });
beforeEach(() => { child.normalizeRoot = false; });

describe("root routing", () => {
  it.each(["/", "/?"])("keeps %s on the native dashboard without a recovery rewrite", (path) => {
    const navigate = vi.fn();
    window.history.replaceState(null, "", path);
    render(<App navigate={navigate}/>);
    expect(screen.getByTestId("dashboard-container")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(window.location.search).not.toContain("recovery=invalid-legacy-link");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the dashboard when its child normalizes root before legacy routing", async () => {
    const navigate = vi.fn();
    child.normalizeRoot = true;
    window.history.replaceState(null, "", "/");
    render(<App navigate={navigate}/>);
    await waitFor(() => expect(window.location.search).toContain("page=1"));
    expect(screen.getByTestId("dashboard-container")).toBeInTheDocument();
    expect(window.location.search).not.toContain("recovery=invalid-legacy-link");
    expect(navigate).not.toHaveBeenCalled();
  });

  it("keeps the exact root recovery sentinel on the nonblank dashboard without navigating", () => {
    const navigate = vi.fn();
    window.history.replaceState(null, "", "/?recovery=invalid-legacy-link");
    render(<App navigate={navigate}/>);
    expect(screen.getByTestId("dashboard-container")).toBeInTheDocument();
    expect(window.location.pathname).toBe("/");
    expect(navigate).not.toHaveBeenCalled();
  });

  it.each([
    ["?page=detail&player=194165&season=25%2F26&mode=league&scope=8", "/players/194165?season=2025%2F2026&mode=league&scope=8"],
    ["?page=about", "/about/messi"],
    ["?page=compare&left_player=1&left_season=24%2F25&left_mode=league&left_scope=8&left_competition=all&right_player=2&right_season=24%2F25&right_mode=europe&right_competition=ucl", "/compare?leftPlayerId=1&leftTaxonomy=legacy-v1&leftSeason=2024%2F2025&leftMode=league&leftScope=8&leftCompetition=all&rightPlayerId=2&rightTaxonomy=legacy-v1&rightSeason=2024%2F2025&rightMode=europe&rightScope=null&rightCompetition=ucl"],
  ])("uses the initial legacy query after child normalization: %s", async (search, target) => {
    const navigate = vi.fn();
    child.normalizeRoot = true;
    window.history.replaceState(null, "", `/${search}`);
    render(<App navigate={navigate}/>);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(target));
    expect(navigate).toHaveBeenCalledTimes(1);
    expect(window.location.search).toContain("page=1");
  });

  it.each([
    ["?page=detail&player=bad&season=25%2F26&mode=league&scope=8", "/?recovery=invalid-legacy-link"],
    ["?page=detail&page=detail&player=194165&season=25%2F26&mode=league&scope=8", "/?recovery=invalid-legacy-link"],
    ["?page=compare&leftPlayerId=1&leftSeason=24%2F25&leftMode=league&leftScope=8&leftCompetition=all&rightPlayerId=2&rightSeason=24%2F25&rightMode=league&rightScope=8&rightCompetition=all", "/compare?recovery=invalid-legacy-link"],
    ["?page=compare&left_player=1&left_season=24%2F25&left_mode=league&left_scope=8&left_competition=all&left_taxonomy=legacy-v1&right_player=2&right_season=24%2F25&right_mode=league&right_scope=8&right_competition=all", "/compare?recovery=invalid-legacy-link"],
    ["?page=players&season=25%2F26", "/?recovery=invalid-legacy-link"],
  ])("keeps strict recovery targets after child normalization: %s", async (search, target) => {
    const navigate = vi.fn();
    child.normalizeRoot = true;
    window.history.replaceState(null, "", `/${search}`);
    render(<App navigate={navigate}/>);
    await waitFor(() => expect(navigate).toHaveBeenCalledWith(target));
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it("does not hard-navigate again after mounting the root recovery target", async () => {
    const firstNavigate = vi.fn();
    window.history.replaceState(null, "", "/?page=detail&playerId=194165&season=25%2F26&mode=league&scope=8");
    const first = render(<App navigate={firstNavigate}/>);
    await waitFor(() => expect(firstNavigate).toHaveBeenCalledWith("/?recovery=invalid-legacy-link"));
    first.unmount();

    const recoveryNavigate = vi.fn();
    window.history.replaceState(null, "", "/?recovery=invalid-legacy-link");
    render(<App navigate={recoveryNavigate}/>);
    expect(screen.getByTestId("dashboard-container")).toBeInTheDocument();
    expect(recoveryNavigate).not.toHaveBeenCalled();
  });

  it("does not adapt a direct non-root route", () => {
    const navigate = vi.fn();
    window.history.replaceState(null, "", "/about/messi");
    render(<App navigate={navigate}/>);
    expect(screen.getByTestId("static-route")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });

  it("leaves the direct compare recovery route to StaticRoute", () => {
    const navigate = vi.fn();
    window.history.replaceState(null, "", "/compare?recovery=invalid-legacy-link");
    render(<App navigate={navigate}/>);
    expect(screen.getByTestId("static-route")).toBeInTheDocument();
    expect(navigate).not.toHaveBeenCalled();
  });
});
