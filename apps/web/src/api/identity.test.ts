import { describe, expect, it } from "vitest";
import { validateNicknameForEntry } from "./identity.js";

describe("validateNicknameForEntry", () => {
  it("counts supplementary Han characters by Unicode code point", () => {
    const supplementaryHan = "𠀀";

    expect(validateNicknameForEntry(supplementaryHan.repeat(12))).toBeNull();
    expect(validateNicknameForEntry(supplementaryHan.repeat(13))).toBe("昵称最多 12 个字符");
  });
});
