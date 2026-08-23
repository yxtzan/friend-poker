import { afterEach, describe, expect, it, vi } from "vitest";
import type { EntryAvailability } from "@friend-poker/shared";
import { fetchEntryAvailability, isEntryPositionAvailable, validateNicknameForEntry } from "./identity.js";

describe("validateNicknameForEntry", () => {
  it("counts supplementary Han characters by Unicode code point", () => {
    const supplementaryHan = "𠀀";

    expect(validateNicknameForEntry(supplementaryHan.repeat(12))).toBeNull();
    expect(validateNicknameForEntry(supplementaryHan.repeat(13))).toBe("昵称最多 12 个字符");
  });
});

describe("entry availability API", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("parses the narrow same-origin response and checks positions without identity data", async () => {
    const response: EntryAvailability = {
      seats: [
        { seat: 0, occupied: true },
        { seat: 1, occupied: false },
        { seat: 2, occupied: false },
        { seat: 3, occupied: false },
        { seat: 4, occupied: false },
        { seat: 5, occupied: false },
      ],
      spectatorCount: 1,
      spectatorCapacity: 2,
    };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchEntryAvailability()).resolves.toEqual(response);
    expect(fetchMock).toHaveBeenCalledWith("/identity/entry-status", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
    expect(isEntryPositionAvailable(response, { kind: "SEAT", seat: 0 })).toBe(false);
    expect(isEntryPositionAvailable(response, { kind: "SEAT", seat: 1 })).toBe(true);
    expect(isEntryPositionAvailable(response, { kind: "SPECTATOR" })).toBe(true);
  });

  it("surfaces malformed or failed availability responses as non-fatal API errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 503 })));

    await expect(fetchEntryAvailability()).rejects.toMatchObject({ status: 503, code: "HTTP_ERROR" });
  });
});
