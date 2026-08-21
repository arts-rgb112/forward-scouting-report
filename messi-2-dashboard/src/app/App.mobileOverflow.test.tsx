// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { GlobalNavigation } from "./App";

afterEach(cleanup);

describe("global navigation mobile overflow contract", () => {
  it("keeps every functional link while allowing the 320px header to wrap within its available width", () => {
    const { container } = render(<GlobalNavigation pathname="/players/194165" />);
    const wrapper = container.querySelector("header > div");
    const navigation = screen.getByRole("navigation");
    expect(wrapper).toHaveClass("flex-wrap");
    expect(navigation).toHaveClass("min-w-0", "flex-1", "flex-wrap", "justify-end");
    expect(screen.getAllByRole("link")).toHaveLength(5);
    expect(screen.getByRole("link", { name: "MESSI stats" })).toHaveClass("whitespace-nowrap", "px-2", "sm:px-3");
  });
});
