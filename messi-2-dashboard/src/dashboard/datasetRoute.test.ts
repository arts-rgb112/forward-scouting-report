import { describe, expect, it } from "vitest";
import { datasetFromSearch, datasetHref, pageFromSearch, PAGE_SIZE } from "./datasetRoute";

const fallback = { season: "2025/2026", mode: "league" as const, scope: 7 as const, competition: "all" as const };

describe("dataset route serialization", () => {
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
});
