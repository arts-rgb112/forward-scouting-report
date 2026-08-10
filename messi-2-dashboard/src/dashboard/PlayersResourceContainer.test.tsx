// @vitest-environment jsdom
import "@testing-library/jest-dom/vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { PlayersPayload } from "./types";
import { sampleMeta, samplePlayers } from "../test/fixtures/players";

const transport = vi.hoisted(() => ({ fetchPlayers: vi.fn() }));
const apiEnvironment = vi.hoisted(() => {
  class TestConfigError extends Error {
    constructor(public category: string, message = "test configuration error") { super(message); }
  }
  return { parseMessiApiConfig: vi.fn(), MessiConfigError: TestConfigError };
});
vi.mock("../api/env", () => apiEnvironment);
vi.mock("../api/playersApi", () => ({ fetchPlayers: transport.fetchPlayers }));

import { PlayersResourceContainer } from "./PlayersResourceContainer";

type Deferred = { promise: Promise<PlayersPayload>; resolve(value: PlayersPayload): void };
function deferred(): Deferred {
  let resolve!: (value: PlayersPayload) => void;
  const promise = new Promise<PlayersPayload>((next) => { resolve = next; });
  return { promise, resolve };
}

const validConfig = { baseUrl: "http://localhost:8000", season: "2025/2026", scope: 7, limit: 1000 };

beforeEach(() => { apiEnvironment.parseMessiApiConfig.mockReturnValue(validConfig); });
afterEach(() => { cleanup(); transport.fetchPlayers.mockReset(); apiEnvironment.parseMessiApiConfig.mockReset(); });

describe("PlayersResourceContainer request lifecycle", () => {
  it("aborts the StrictMode replacement and unmount request, while only the surviving result renders", async () => {
    const calls: Array<{ signal: AbortSignal; request: Deferred }> = [];
    transport.fetchPlayers.mockImplementation((_config, signal: AbortSignal) => {
      const request = deferred(); calls.push({ signal, request }); return request.promise;
    });
    const { unmount } = render(<StrictMode><PlayersResourceContainer /></StrictMode>);
    await waitFor(() => expect(calls.length).toBeGreaterThanOrEqual(2));
    expect(calls[0].signal.aborted).toBe(true);
    const active = calls[calls.length - 1];
    await act(async () => { calls[0].request.resolve({ players: [{ ...samplePlayers[0], name: "Stale player" }], meta: { ...sampleMeta, population: 1, returned: 1 } }); });
    await act(async () => { active.request.resolve({ players: [{ ...samplePlayers[0], name: "Current player" }], meta: { ...sampleMeta, population: 1, returned: 1 } }); });
    expect(screen.queryByText("Stale player")).not.toBeInTheDocument();
    expect(screen.getAllByText("Current player")).toHaveLength(2);
    unmount();
    expect(active.signal.aborted).toBe(true);
  });
});

describe("PlayersResourceContainer configuration safety", () => {
  it.each([
    ["MISSING_API_BASE_URL", "필수 API 주소가 설정되지 않았습니다."],
    ["INVALID_API_ORIGIN", "API 주소 형식이 허용되지 않습니다."],
    ["INSECURE_API_ORIGIN", "이 환경에서는 보안 HTTPS API 주소가 필요합니다."],
    ["INVALID_DATASET_SETTINGS", "데이터셋 설정 값이 허용 범위를 벗어났습니다."],
  ])("renders %s as a terminal no-request state", async (category, reason) => {
    apiEnvironment.parseMessiApiConfig.mockImplementation(() => { throw new apiEnvironment.MessiConfigError(category); });
    render(<PlayersResourceContainer />);
    expect(await screen.findByRole("heading", { name: "Config Error (환경 변수 누락)" })).toHaveFocus();
    expect(screen.getByText(reason)).toBeInTheDocument();
    expect(screen.queryByText("No players in this dataset")).not.toBeInTheDocument();
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
  });

  it("never renders a malformed credential-bearing value or sends it to the transport", async () => {
    const rejectedValue = "https://operator:do-not-expose@api.invalid/?private=1";
    apiEnvironment.parseMessiApiConfig.mockImplementation(() => { throw new apiEnvironment.MessiConfigError("INVALID_API_ORIGIN", rejectedValue); });
    render(<PlayersResourceContainer />);
    await screen.findByRole("heading", { name: "Config Error (환경 변수 누락)" });
    expect(document.body.textContent).not.toContain(rejectedValue);
    expect(document.body.textContent).not.toContain("do-not-expose");
    expect(transport.fetchPlayers).not.toHaveBeenCalled();
  });
});
