import { expect, it } from "vitest";
import { nativePitchEventsV2EnvelopeSchema } from "./nativePitchEventsV2Contracts";

// Explicit opt-in integration check against the running local QA API, never a CI dependency.
it.skipIf(process.env.PITCH_LOCAL_API_CHECK !== "1")("decodes the current local native v2 packet", async () => {
  const response = await fetch("http://127.0.0.1:8001/api/v2/players/194165/native-pitch-events-v2?season=2025%2F2026&mode=league&scope=8&competition=all&includePenalties=true");
  expect(response.status).toBe(200);
  const parsed = nativePitchEventsV2EnvelopeSchema.safeParse(await response.json());
  expect(parsed.success, parsed.success ? "valid" : JSON.stringify(parsed.error.issues, null, 2)).toBe(true);
}, 60000);
