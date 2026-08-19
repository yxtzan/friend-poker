import { describe, expect, it } from "vitest";

import {
  getHandRecord,
  HandCompletionReason,
  HoleCardRevealReason,
  PlayerActionType,
  revealUncontestedWinner,
} from "../src/index.js";
import {
  actHand,
  callOrCheck,
  finishByCallingAndChecking,
  privateCards,
  startOrchestratedHand,
} from "./hand-helpers.js";

describe("safe hand history and hole-card privacy", () => {
  it("reveals both cards of every non-folded contender at Showdown", () => {
    const state = finishByCallingAndChecking(startOrchestratedHand([100, 100, 100]));
    const record = getHandRecord(state);
    expect(record.revealedHoleCards.map(({ playerId }) => playerId).sort()).toEqual([
      "A", "B", "C",
    ]);
    expect(record.revealedHoleCards.every(({ cards }) => cards.length === 2)).toBe(true);
    expect(record.revealedHoleCards.every(({ reason }) => reason === HoleCardRevealReason.Showdown)).toBe(true);
  });

  it("never includes a folded player's cards in the safe record", () => {
    let state = startOrchestratedHand([100, 100, 100], { buttonSeat: 0 });
    const foldedCards = privateCards(state, "A");
    state = actHand(state, PlayerActionType.Fold);
    state = callOrCheck(state);
    state = callOrCheck(state);
    state = finishByCallingAndChecking(state);
    const record = getHandRecord(state);

    expect(record.revealedHoleCards.map(({ playerId }) => playerId)).not.toContain("A");
    expect(record.events.some((event) => event.type === "HOLE_CARDS_REVEALED" && event.hands.some((hand) => hand.playerId === "A"))).toBe(false);
    expect(JSON.stringify(record)).not.toContain(JSON.stringify(foldedCards));
  });

  it("keeps an uncontested winner hidden by default", () => {
    let state = startOrchestratedHand([100, 100]);
    state = actHand(state, PlayerActionType.Fold);
    expect(state.completionReason).toBe(HandCompletionReason.Uncontested);
    expect(getHandRecord(state).revealedHoleCards).toEqual([]);
  });

  it("voluntarily reveals exactly both cards of the uncontested winner", () => {
    let state = startOrchestratedHand([100, 100]);
    state = actHand(state, PlayerActionType.Fold);
    const settlement = state.settlement;
    state = revealUncontestedWinner(state, "B");
    const record = getHandRecord(state);

    expect(record.revealedHoleCards).toEqual([
      {
        playerId: "B",
        cards: privateCards(state, "B"),
        reason: HoleCardRevealReason.VoluntaryUncontested,
      },
    ]);
    expect(state.settlement).toBe(settlement);
  });

  it("makes repeated voluntary reveal an exact no-op without duplicate events", () => {
    let state = startOrchestratedHand([100, 100]);
    state = actHand(state, PlayerActionType.Fold);
    state = revealUncontestedWinner(state, "B");
    const repeated = revealUncontestedWinner(state, "B");
    expect(repeated).toBe(state);
    expect(repeated.events.filter((event) => event.type === "HOLE_CARDS_REVEALED")).toHaveLength(1);
  });

  it("rejects voluntary reveal by anyone except the uncontested winner", () => {
    let state = startOrchestratedHand([100, 100]);
    state = actHand(state, PlayerActionType.Fold);
    expect(() => revealUncontestedWinner(state, "A")).toThrow(/actual winner|winner may reveal/u);
  });

  it("does not expose the remaining deck or private-hole-card map", () => {
    const record = getHandRecord(startOrchestratedHand([100, 100, 100]));
    expect(record).not.toHaveProperty("remainingDeck");
    expect(record).not.toHaveProperty("privateHoleCards");
    expect(record.revealedHoleCards).toEqual([]);
  });

  it("records hand identity, seats, blinds, board, actions, and settlement", () => {
    const state = finishByCallingAndChecking(
      startOrchestratedHand([100, 100], { handId: "hand-0042", buttonSeat: 0 }),
    );
    const record = getHandRecord(state);
    expect(record).toMatchObject({
      handId: "hand-0042",
      buttonSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 1,
      smallBlind: 1,
      bigBlind: 2,
      completionReason: HandCompletionReason.Showdown,
    });
    expect(record.actions.length).toBeGreaterThan(0);
    expect(record.flop).toHaveLength(3);
    expect(record.turn).not.toBeNull();
    expect(record.river).not.toBeNull();
    expect(record.settlement).not.toBeNull();
  });
});
