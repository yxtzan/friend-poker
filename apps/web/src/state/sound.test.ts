import { describe, expect, it } from "vitest";
import { REACTION_EMOJIS } from "@friend-poker/shared";
import { REACTION_SOUND_CUES } from "./sound.js";

describe("reaction sound cues", () => {
  it("maps every fixed reaction emoji to a distinct short cue", () => {
    const signatures = REACTION_EMOJIS.map((emoji) => JSON.stringify(REACTION_SOUND_CUES[emoji]));

    expect(Object.keys(REACTION_SOUND_CUES)).toEqual([...REACTION_EMOJIS]);
    expect(new Set(signatures).size).toBe(REACTION_EMOJIS.length);
    for (const emoji of REACTION_EMOJIS) {
      expect(REACTION_SOUND_CUES[emoji].duration).toBeGreaterThanOrEqual(0.06);
      expect(REACTION_SOUND_CUES[emoji].duration).toBeLessThanOrEqual(0.3);
    }
  });
});
