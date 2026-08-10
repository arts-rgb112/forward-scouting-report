// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ConfigErrorFallback } from "./ConfigErrorFallback";

afterEach(() => { vi.restoreAllMocks(); });

describe("ConfigErrorFallback", () => {
  it("focuses its heading and copies only a safe diagnostic", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    render(<ConfigErrorFallback category="INVALID_API_ORIGIN" mode="production" />);
    expect(screen.getByRole("heading", { name: "Config Error (환경 변수 누락)" })).toHaveFocus();
    expect(screen.getByText("API 주소 형식이 허용되지 않습니다.")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "문제 정보 복사" })).toHaveClass("min-h-11");
    fireEvent.click(screen.getByRole("button", { name: "문제 정보 복사" }));
    expect(await screen.findByRole("status")).toHaveTextContent("복사되었습니다. 배포 담당자에게 전달하세요.");
    expect(writeText).toHaveBeenCalledWith(expect.stringContaining("category: INVALID_API_ORIGIN"));
    expect(writeText).not.toHaveBeenCalledWith(expect.stringContaining("https://"));
  });
});
