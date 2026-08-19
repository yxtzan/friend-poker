import { describe, expect, it } from "vitest";

import { constructPots, settleHand } from "../src/index.js";
import { seededRandom } from "./helpers.js";
import { settlementState } from "./settlement-helpers.js";

const SETTLEMENT_PROPERTY_SEED = 0x51de_9073;

describe(`deterministic settlement properties (seed ${SETTLEMENT_PROPERTY_SEED})`, () => {
  it("preserves construction invariants across 1,000 contribution/fold patterns", () => {
    const random = seededRandom(SETTLEMENT_PROPERTY_SEED);

    for (let sample = 0; sample < 1_000; sample += 1) {
      const playerCount = 2 + Math.floor(random() * 5);
      const contributions = Array.from(
        { length: playerCount },
        () => Math.floor(random() * 101),
      );
      if (Math.max(...contributions) === 0) contributions[0] = 1;
      const maximum = Math.max(...contributions);
      const liveIndex = contributions.indexOf(maximum);
      const state = settlementState(
        contributions.map((contribution, index) => ({
          playerId: String.fromCharCode(65 + index),
          seat: index * 3 + 1,
          contribution,
          folded: index !== liveIndex && random() < 0.45,
        })),
      );
      const before = JSON.stringify(state.participants);
      const result = constructPots(state.participants);

      expect(result.pots.every((pot) => pot.amount > 0)).toBe(true);
      expect(result.pots.every((pot) => pot.contributorPlayerIds.length >= 2)).toBe(true);
      expect(
        result.pots.every((pot) =>
          pot.eligiblePlayerIds.every((playerId) => {
            const participant = state.participants.find((candidate) => candidate.playerId === playerId)!;
            return !participant.folded && participant.totalContribution >= pot.contributionTo;
          }),
        ),
      ).toBe(true);
      expect(result.totalContribution).toBe(result.totalRefund + result.totalMatched);
      expect(result.totalMatched).toBe(result.pots.reduce((total, pot) => total + pot.amount, 0));
      expect(JSON.stringify(state.participants)).toBe(before);
    }
  });

  it("settles 500 reproducible uncontested patterns without losing or creating chips", () => {
    const random = seededRandom(SETTLEMENT_PROPERTY_SEED ^ 0x0ddc_41f0);

    for (let sample = 0; sample < 500; sample += 1) {
      const playerCount = 2 + Math.floor(random() * 5);
      const contributions = Array.from(
        { length: playerCount },
        () => Math.floor(random() * 101),
      );
      if (Math.max(...contributions) === 0) contributions[0] = 1;
      const maximum = Math.max(...contributions);
      const winnerIndex = contributions.indexOf(maximum);
      const state = settlementState(
        contributions.map((contribution, index) => ({
          playerId: String.fromCharCode(65 + index),
          seat: index * 2,
          contribution,
          folded: index !== winnerIndex,
        })),
        { status: "UNCONTESTED" },
      );
      const before = JSON.stringify(state);
      const first = settleHand({ state });
      const second = settleHand({ state });

      expect(first).toEqual(second);
      expect(first.totalContribution).toBe(first.totalRefund + first.totalPotAmount);
      expect(first.totalPotAmount).toBe(first.totalPotPayout);
      expect(first.totalStartingStacks).toBe(first.totalFinalStacks);
      expect(first.pots.every((pot) => pot.payouts.reduce((total, payout) => total + payout.amount, 0) === pot.amount)).toBe(true);
      expect(JSON.stringify(state)).toBe(before);
    }
  });
});
