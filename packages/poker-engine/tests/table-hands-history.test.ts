import { describe, expect, it } from "vitest";

import {
  adjustPlayerChips,
  applyTableHandAction,
  changeBlinds,
  createTableState,
  endSession,
  enterTable,
  prepareEndSession,
  PlayerActionType,
  revealTableUncontestedWinner,
  setPlayerOnline,
  startFirstHand,
  startNextHand,
  startSession,
  TableLifecycleStatus,
} from "../src/index.js";
import {
  completeTableHand,
  player,
  rng,
  startedSession,
  totalBalances,
} from "./table-helpers.js";

function foldCurrentActor(state: ReturnType<typeof startedSession>) {
  const actor = state.activeHand?.bettingState.currentActorId;
  if (actor === null || actor === undefined) throw new Error("Expected a current actor");
  return applyTableHandAction(state, { playerId: actor, type: PlayerActionType.Fold });
}

describe("multi-hand table composition", () => {
  it("starts explicitly, reconciles exact final stacks, waits, then explicitly starts next", () => {
    let state = startedSession(["A", "B", "C"]);
    const initialTotal = totalBalances(state);
    state = startFirstHand(
      state,
      { operatorPlayerId: "A", handId: "hand-1", buttonSeat: 0 },
      rng(1),
    );
    expect(state.status).toBe(TableLifecycleStatus.HandInProgress);
    expect(state.session?.completedHandCount).toBe(0);

    state = completeTableHand(state);
    expect(state.status).toBe(TableLifecycleStatus.BetweenHands);
    expect(state.activeHand).toBeNull();
    expect(state.session?.completedHandCount).toBe(1);
    expect(totalBalances(state)).toBe(initialTotal);
    for (const stack of state.recentHands[0]!.record.settlement!.finalStacks) {
      expect(player(state, stack.playerId).chipBalance).toBe(stack.stack);
    }

    const waitingSnapshot = state;
    expect(waitingSnapshot.status).toBe(TableLifecycleStatus.BetweenHands);
    state = startNextHand(
      state,
      { operatorPlayerId: "A", handId: "hand-2" },
      rng(2),
    );
    expect(state.status).toBe(TableLifecycleStatus.HandInProgress);
    expect(state.activeHand?.handId).toBe("hand-2");
  });

  it("uses configured blinds for each hand without automatic escalation", () => {
    let state = startedSession();
    state = changeBlinds(state, {
      operatorPlayerId: "A",
      smallBlind: 3,
      bigBlind: 7,
    });
    state = startFirstHand(
      state,
      { operatorPlayerId: "A", handId: "blinds-1", buttonSeat: 0 },
      rng(),
    );
    expect(state.activeHand?.bettingState).toMatchObject({ smallBlind: 3, bigBlind: 7 });
    state = foldCurrentActor(state);
    state = startNextHand(
      state,
      { operatorPlayerId: "A", handId: "blinds-2" },
      rng(2),
    );
    expect(state.activeHand?.bettingState).toMatchObject({ smallBlind: 3, bigBlind: 7 });
  });

  it("moves Button through sparse seats and re-evaluates online/zero-stack eligibility", () => {
    let state = startedSession(["A", "B", "C"], [0, 2, 5]);
    state = startFirstHand(
      state,
      { operatorPlayerId: "A", handId: "button-1", buttonSeat: 0 },
      rng(1),
    );
    state = foldCurrentActor(state);
    state = completeTableHand(state);
    state = setPlayerOnline(state, "B", false);
    state = startNextHand(
      state,
      { operatorPlayerId: "A", handId: "button-2" },
      rng(2),
    );
    expect(state.activeHand?.bettingState.buttonSeat).toBe(5);
    expect(state.activeHand?.bettingState.participants.map(({ playerId }) => playerId)).toEqual([
      "A",
      "C",
    ]);

    state = foldCurrentActor(state);
    state = completeTableHand(state);
    state = setPlayerOnline(state, "B", true);
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "C",
      amount: -player(state, "C").chipBalance,
      ledgerEntryId: "zero-c",
    });
    state = startNextHand(
      state,
      { operatorPlayerId: "A", handId: "button-3" },
      rng(3),
    );
    expect(state.activeHand?.bettingState.buttonSeat).toBe(0);
    expect(state.activeHand?.bettingState.participants.map(({ playerId }) => playerId)).toEqual([
      "A",
      "B",
    ]);
  });
});

describe("safe hand history", () => {
  it("stores only a safe record and never a folded player's unrevealed cards", () => {
    let state = startFirstHand(
      startedSession(["A", "B", "C"]),
      { operatorPlayerId: "A", handId: "privacy", buttonSeat: 0 },
      rng(44),
    );
    const actor = state.activeHand!.bettingState.currentActorId!;
    const foldedCards = state.activeHand!.privateHoleCards.find(
      (hand) => hand.playerId === actor,
    )!.cards;
    state = applyTableHandAction(state, { playerId: actor, type: PlayerActionType.Fold });
    state = completeTableHand(state);
    const stored = state.recentHands[0]!;

    expect(stored).toMatchObject({ sessionId: "session-1", handNumber: 1 });
    expect(stored).not.toHaveProperty("privateHoleCards");
    expect(stored.record).not.toHaveProperty("privateHoleCards");
    expect(stored.record).not.toHaveProperty("remainingDeck");
    expect(JSON.stringify(stored.record)).not.toContain(JSON.stringify(foldedCards));
  });

  it("delegates an uncontested voluntary reveal and updates only the safe record", () => {
    let state = startFirstHand(
      startedSession(),
      { operatorPlayerId: "A", handId: "reveal", buttonSeat: 0 },
      rng(7),
    );
    state = foldCurrentActor(state);
    const winnerId = state.uncontestedRevealOpportunity!.hand.bettingState.uncontestedWinnerId!;
    state = revealTableUncontestedWinner(state, winnerId);
    expect(state.recentHands[0]?.record.revealedHoleCards).toHaveLength(1);
    expect(state.recentHands[0]?.record.revealedHoleCards[0]).toMatchObject({
      playerId: winnerId,
      reason: "VOLUNTARY_UNCONTESTED",
    });
    expect(state.activeHand).toBeNull();
  });

  it("keeps only the newest 20 detailed hands across the table", () => {
    let state = startedSession();
    for (let hand = 1; hand <= 21; hand += 1) {
      state =
        hand === 1
          ? startFirstHand(
              state,
              { operatorPlayerId: "A", handId: `hand-${hand}`, buttonSeat: 0 },
              rng(hand),
            )
          : startNextHand(
              state,
              { operatorPlayerId: "A", handId: `hand-${hand}` },
              rng(hand),
            );
      state = foldCurrentActor(state);
    }
    expect(state.recentHands).toHaveLength(20);
    expect(state.recentHands[0]?.record.handId).toBe("hand-2");
    expect(state.recentHands.at(-1)?.record.handId).toBe("hand-21");
  });
});

describe("Session summary history", () => {
  it("keeps the newest 20 summaries independently from hand history", () => {
    let state = createTableState();
    for (let sessionNumber = 1; sessionNumber <= 21; sessionNumber += 1) {
      const sessionId = `session-${sessionNumber}`;
      const hostId = `A-${sessionNumber}`;
      const playerId = `B-${sessionNumber}`;
      state = enterTable(state, {
        playerId: hostId,
        position: { kind: "SEAT", seat: 0 },
      });
      state = enterTable(state, {
        playerId,
        position: { kind: "SEAT", seat: 1 },
      });
      state = startSession(state, {
        operatorPlayerId: hostId,
        sessionId,
        initialGrants: [
          { playerId: hostId, ledgerEntryId: `${sessionId}-a` },
          { playerId, ledgerEntryId: `${sessionId}-b` },
        ],
        startMetadata: { order: sessionNumber },
      });
      state = endSession(state, {
        operatorPlayerId: hostId,
        confirmation: prepareEndSession(state, hostId),
        endMetadata: { order: sessionNumber },
      });
    }
    expect(state.recentSessions).toHaveLength(20);
    expect(state.recentSessions[0]?.sessionId).toBe("session-2");
    expect(state.recentSessions.at(-1)?.sessionId).toBe("session-21");
    expect(state.recentSessions.at(-1)?.players).toEqual([
      {
        playerId: "A-21",
        initialGrants: 100,
        replenishments: 0,
        hostAdjustments: 0,
        finalChipBalance: 100,
        netResult: 0,
      },
      {
        playerId: "B-21",
        initialGrants: 100,
        replenishments: 0,
        hostAdjustments: 0,
        finalChipBalance: 100,
        netResult: 0,
      },
    ]);
  });
});
