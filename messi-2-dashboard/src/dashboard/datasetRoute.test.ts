import { describe, expect, it } from "vitest";
import { datasetFromSearch, datasetHref, datasetKeyOf, leaderboardHref, leaderboardSearchFromSearch, pageFromSearch, PAGE_SIZE } from "./datasetRoute";

const fallback = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const };

describe("dataset route serialization", () => {
  it("keys only the dataset and normalizes an empty competition", () => {
    const key = datasetKeyOf(fallback);
    expect(datasetKeyOf({ ...fallback, competition: "" as "all" })).toBe(key);
    expect(datasetKeyOf({ ...fallback, season: "2024/2025" })).not.toBe(key);
    expect(datasetKeyOf({ ...fallback, mode: "europe" })).not.toBe(key);
    expect(datasetKeyOf({ ...fallback, scope: 5 })).not.toBe(key);
    expect(datasetKeyOf({ ...fallback, competition: "ucl" })).not.toBe(key);
    expect(leaderboardHref(fallback, { ...leaderboardSearchFromSearch(""), q: "Haaland", role: "Type A", page: 4 })).not.toBe(leaderboardHref(fallback));
    expect(datasetKeyOf(fallback)).toBe(key);
  });
  it("keeps only league context and removes a page from player links", () => {
    const route = datasetFromSearch("?season=2024%2F2025&mode=league&scope=5&competition=ucl&page=3", fallback);
    expect(datasetHref("/players/12", route)).toBe("/players/12?season=2024%2F2025&mode=league&scope=5");
  });

  it("keeps only Europe competition and rejects invalid page values", () => {
    const route = datasetFromSearch("?mode=europe&competition=ucl&scope=3", fallback);
    expect(datasetHref("/compare", route)).toBe("/compare?season=2025%2F2026&mode=europe&competition=ucl");
    expect(pageFromSearch("?page=0")).toBe(1);
    expect(PAGE_SIZE).toBe(50);
  });

  it("normalizes stale pageSize values to the fixed 50-row contract", () => {
    const search = leaderboardSearchFromSearch("?page=3&pageSize=250");
    expect(search.pageSize).toBe(PAGE_SIZE);
    expect(leaderboardHref(fallback, { ...search, pageSize: 250 })).toContain("pageSize=50");
  });

  it("normalizes all age/minutes bands out of the URL and retains valid non-default bands", () => {
    expect(leaderboardSearchFromSearch("?ageBand=u23&minutesBand=1000-1499")).toMatchObject({ ageBand: "u23", minutesBand: "1000-1499" });
    expect(leaderboardHref(fallback, { ...leaderboardSearchFromSearch(""), ageBand: "all", minutesBand: "all" })).not.toMatch(/ageBand|minutesBand/);
  });

  it("retains explicit scope 8 while existing 3/5/7 URLs remain valid", () => {
    expect(datasetFromSearch("?scope=8", fallback).scope).toBe(8);
    expect([3, 5, 7].map((scope) => datasetFromSearch(`?scope=${scope}`, fallback).scope)).toEqual([3, 5, 7]);
  });

  it("defaults a missing or invalid URL scope to the fixed eight-league route policy", () => {
    const environmentConfiguredSeven = { ...fallback, scope: 7 as const };
    expect(datasetFromSearch("", environmentConfiguredSeven).scope).toBe(8);
    expect(datasetFromSearch("?scope=6", environmentConfiguredSeven).scope).toBe(8);
  });
});
