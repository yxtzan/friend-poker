import { describe, expect, it } from "vitest";
import { acceptProjection, commandErrorMessage, identityErrorMessage } from "./projection.js";
import { projectionFixture } from "../test/fixtures.js";

describe("authoritative projection helpers", () => {
  it("replaces state with a newer projection and ignores an older packet", () => {
    const initial = projectionFixture({ version: 4 });
    const newer = projectionFixture({ version: 5, ownHoleCards: null });
    const older = projectionFixture({ version: 3, ownHoleCards: null });

    expect(acceptProjection(initial, newer)).toBe(newer);
    expect(acceptProjection(newer, older)).toBe(newer);
  });

  it("keeps server-facing errors understandable without exposing internals", () => {
    expect(commandErrorMessage("STALE_VERSION", "ignored")).toContain("状态已更新");
    expect(identityErrorMessage("NICKNAME_UNAVAILABLE", "internal")).toContain("昵称");
  });
});
