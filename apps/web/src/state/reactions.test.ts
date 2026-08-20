import { describe, expect, it } from "vitest";
import { ReactionRateLimiter } from "./reactions.js";

describe("ReactionRateLimiter", () => {
  it("allows four reactions, then shows the local cooldown egg once", () => {
    const limiter = new ReactionRateLimiter();

    expect(Array.from({ length: 4 }, () => limiter.attempt(100))).toEqual([
      { accepted: true, showEgg: false },
      { accepted: true, showEgg: false },
      { accepted: true, showEgg: false },
      { accepted: true, showEgg: false },
    ]);
    expect(limiter.attempt(100)).toEqual({ accepted: false, showEgg: true });
    expect(limiter.attempt(100)).toEqual({ accepted: false, showEgg: false });
    expect(limiter.attempt(1_100)).toEqual({ accepted: true, showEgg: false });
  });

  it("uses a rolling one-second window", () => {
    const limiter = new ReactionRateLimiter();

    expect(limiter.attempt(0).accepted).toBe(true);
    expect(limiter.attempt(250).accepted).toBe(true);
    expect(limiter.attempt(500).accepted).toBe(true);
    expect(limiter.attempt(750).accepted).toBe(true);
    expect(limiter.attempt(1_001).accepted).toBe(true);
  });
});
