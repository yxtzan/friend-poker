import { describe, expect, it } from "vitest";
import { ReactionRateLimiter } from "./reactions.js";

describe("server reaction rate limiter", () => {
  it("blocks the fifth reaction and remains blocked during cooldown", () => {
    const limiter = new ReactionRateLimiter();
    expect(Array.from({ length: 4 }, () => limiter.tryAccept("player-1", 500))).toEqual([
      true,
      true,
      true,
      true,
    ]);
    expect(limiter.tryAccept("player-1", 500)).toBe(false);
    expect(limiter.tryAccept("player-1", 1_499)).toBe(false);
    expect(limiter.tryAccept("player-1", 1_500)).toBe(true);
  });

  it("keeps each player's window independent", () => {
    const limiter = new ReactionRateLimiter();
    for (let index = 0; index < 4; index += 1) expect(limiter.tryAccept("player-1", index)).toBe(true);
    expect(limiter.tryAccept("player-1", 4)).toBe(false);
    expect(limiter.tryAccept("player-2", 4)).toBe(true);
  });
});
