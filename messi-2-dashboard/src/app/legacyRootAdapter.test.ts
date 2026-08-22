import { describe, expect, it } from "vitest";
import { legacyRootAdapter } from "./legacyRootAdapter";

describe("legacy root adapter", () => {
  it("converts only an unambiguous native detail route", () => {
    expect(legacyRootAdapter("?page=detail&player=7&season=24%2F25&mode=league&scope=8&competition=all")).toBe("/players/7?season=2024%2F2025&mode=league&scope=8");
    expect(legacyRootAdapter("?page=about")).toBe("/about/messi");
  });
  it("rejects duplicate and unsupported detail/about query values", () => {
    for (const search of ["?page=detail&page=detail&player=7&season=24%2F25&mode=league&scope=8", "?page=detail&player=7&player=8&season=24%2F25&mode=league&scope=8", "?page=detail&player=7&season=24%2F25&season=25%2F26&mode=league&scope=8", "?page=detail&player=7&season=24%2F25&mode=league&mode=league&scope=8", "?page=detail&player=7&season=24%2F25&mode=league&scope=8&scope=8", "?page=detail&player=7&season=24%2F25&mode=league&scope=8&competition=all&competition=all", "?page=detail&player=7&season=24%2F25&mode=league&scope=8&extra=1", "?page=about&page=about", "?page=about&season=24%2F25"]) expect(legacyRootAdapter(search)).toBe("/?recovery=invalid-legacy-link");
  });
  it("rejects duplicate, ambiguous, malformed, and unsupported compare contexts", () => {
    const valid = "?page=compare&left_player=1&left_season=24%2F25&left_mode=league&left_scope=8&left_competition=all&right_player=2&right_season=24%2F25&right_mode=europe&right_competition=ucl";
    expect(legacyRootAdapter(valid)).toContain("/compare?leftPlayerId=1");
    for (const suffix of ["&page=compare", "&left_player=3", "&leftPlayerId=1", "&right_season=25%2F26", "&left_mode=league", "&left_scope=8", "&right_competition=ucl", "&left_mode=domestic", "&left_scope=9", "&right_competition=pl", "&left_unknown=1"]) expect(legacyRootAdapter(valid + suffix)).toBe("/compare?recovery=invalid-legacy-link");
  });
  it("fails closed for malformed mode/scope/competition combinations", () => {
    expect(legacyRootAdapter("?page=detail&player=7&season=24%2F25&mode=europe&scope=8&competition=ucl")).toBe("/?recovery=invalid-legacy-link");
    expect(legacyRootAdapter("?page=compare&left_player=1&left_season=24%2F25&left_mode=europe&left_scope=8&right_player=2&right_season=24%2F25&right_mode=league&right_scope=8")).toBe("/compare?recovery=invalid-legacy-link");
  });
});
