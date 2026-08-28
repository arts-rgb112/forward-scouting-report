// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TacticalSummaryV2Panel } from "./TacticalSummaryV2";
import { tacticalSummaryV2EnvelopeSchema } from "../api/tacticalSummaryV2Contracts";
import { tacticalSummaryV2Fixture, tacticalSummaryV2SubjectCoordinateLowFixture } from "../test/fixtures/tacticalSummaryV2";
afterEach(cleanup);
const panel = (fixture: unknown) => <TacticalSummaryV2Panel state={{kind:"ready",data:tacticalSummaryV2EnvelopeSchema.parse(fixture).data}} onRetry={vi.fn()}/>;
describe("TacticalSummaryV2Panel",()=>{
  it("translates the final Figma hierarchy from server positioning, lane, and two-axis activity values",()=>{const {container}=render(panel(tacticalSummaryV2Fixture()));expect(screen.getByText("볼 받는 구역")).toBeInTheDocument();expect(screen.getByText("박스 안 활동")).toBeInTheDocument();expect(screen.getByText("20.0%")).toBeInTheDocument();expect(screen.getByText("침투 레인")).toBeInTheDocument();expect(screen.getByText("왼쪽 하프스페이스")).toBeInTheDocument();expect(screen.getByText(/다음 레인 · 중앙 레인 34.0%/)).toBeInTheDocument();expect(screen.getByText("종적 왕복형")).toBeInTheDocument();expect(screen.getByText("전후 활동폭")).toBeInTheDocument();expect(screen.getByText("좌우 활동폭")).toBeInTheDocument();expect(screen.getByText("활동 폭은 위치 분포의 범위이며 이동 거리가 아닙니다.")).toBeInTheDocument();expect(container.querySelector('[data-layout="approved-tactical-summary"]')).toHaveClass("max-w-[560px]","p-6","gap-4");expect(screen.queryByText("핵심 활동 면적")).not.toBeInTheDocument();});
  it("keeps low-sample values and reports both cohort and coordinate causes without recalculation",()=>{render(panel(tacticalSummaryV2Fixture("low_sample")));expect(screen.getAllByText("저표본 비교군 · N=7").length).toBeGreaterThan(0);cleanup();render(panel(tacticalSummaryV2SubjectCoordinateLowFixture()));expect(screen.getByText("측정 표본 부족 · 좌표 N=42")).toBeInTheDocument();});
  it("uses the rose below-median label and left-sided bar",()=>{const {container}=render(panel(tacticalSummaryV2Fixture()));expect(screen.getByText("하위 35%")).toHaveClass("text-[#fa6e7a]");expect(container.querySelector('[data-track-direction="below"] [style*="right: 50%"]')).not.toBeNull();});
  it("does not substitute a global value for unavailable position data",()=>{render(panel(tacticalSummaryV2Fixture("unavailable")));expect(screen.getAllByText("비교 기준 없음 · 선수 역할 정보 없음").length).toBeGreaterThan(0);expect(screen.getAllByText("—").length).toBeGreaterThan(2);expect(screen.queryByText(/8대리그 평균/)).not.toBeInTheDocument();});
  it("renders a three-block loading skeleton and an accessible retry",()=>{const {container}=render(<TacticalSummaryV2Panel state={{kind:"loading"}} onRetry={vi.fn()}/>);expect(container.querySelectorAll('[aria-busy="true"] .animate-pulse').length).toBe(3);cleanup();const retry=vi.fn();render(<TacticalSummaryV2Panel state={{kind:"error"}} onRetry={retry}/>);screen.getByRole("button",{name:"다시 시도"}).click();expect(retry).toHaveBeenCalledOnce();});
});
