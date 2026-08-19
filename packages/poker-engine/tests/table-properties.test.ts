import { describe, expect, it } from "vitest";

import {
  applyTableHandAction,
  LedgerEntryType,
  PlayerActionType,
  replenishPlayer,
  seatPlayer,
  standToSpectate,
  startFirstHand,
  startNextHand,
  TableLifecycleStatus,
} from "../src/index.js";
import { seededRandom } from "./helpers.js";
import {
  completeTableHand,
  player,
  startedSession,
  totalBalances,
} from "./table-helpers.js";

const TABLE_SEQUENCE_SEED = 0x5e55_cafe;

function replayLongSequence() {
  const random = seededRandom(TABLE_SEQUENCE_SEED);
  let state = startedSession(["A", "B", "C", "D", "E", "F"]);
  let ledgerCounter = 0;

  for (let handNumber = 1; handNumber <= 110; handNumber += 1) {
    for (const candidate of state.players) {
      if (candidate.chipBalance === 0) {
        state = replenishPlayer(state, {
          playerId: candidate.playerId,
          ledgerEntryId: `replenish-${ledgerCounter++}`,
        });
      }
    }

    if (handNumber % 15 === 0) {
      const oldSeat = player(state, "C").seat!;
      const ledgerLength = state.session!.ledger.length;
      state = standToSpectate(state, "C");
      state = seatPlayer(state, { playerId: "C", seat: oldSeat });
      expect(state.session?.ledger).toHaveLength(ledgerLength);
    }

    const totalBeforeHand = totalBalances(state);
    const ledgerLengthBeforeStart = state.session!.ledger.length;
    const handRng = seededRandom(Math.floor(random() * 0xffff_ffff));
    state =
      handNumber === 1
        ? startFirstHand(
            state,
            { operatorPlayerId: "A", handId: "long-1", buttonSeat: 0 },
            handRng,
          )
        : startNextHand(
            state,
            { operatorPlayerId: "A", handId: `long-${handNumber}` },
            handRng,
          );

    expect(state.session?.ledger).toHaveLength(ledgerLengthBeforeStart);
    expect(totalBalances(state)).toBe(totalBeforeHand);
    if (handNumber % 7 === 0) {
      const actor = state.activeHand!.bettingState.currentActorId!;
      state = applyTableHandAction(state, {
        playerId: actor,
        type: PlayerActionType.Fold,
      });
      state = completeTableHand(state);
    } else {
      state = completeTableHand(state);
    }

    expect(state.status).toBe(TableLifecycleStatus.BetweenHands);
    expect(totalBalances(state)).toBe(totalBeforeHand);
    expect(state.players.every((candidate) => candidate.chipBalance >= 0)).toBe(true);
    const externalFlows = state.session!.ledger.reduce(
      (total, entry) => total + entry.amount,
      0,
    );
    expect(totalBalances(state)).toBe(externalFlows);
    for (const record of state.recentHands) {
      const foldedIds = record.record.actions
        .filter((action) => action.semantic === "FOLD")
        .map((action) => action.playerId);
      expect(
        record.record.revealedHoleCards.every(
          (revealed) => !foldedIds.includes(revealed.playerId),
        ),
      ).toBe(true);
      expect(record.record).not.toHaveProperty("privateHoleCards");
    }
  }

  return state;
}

describe(`deterministic table invariants (seed ${TABLE_SEQUENCE_SEED})`, () => {
  it("conserves internal chips and audits every external flow across 110 hands", () => {
    const state = replayLongSequence();
    expect(state.session?.completedHandCount).toBe(110);
    expect(state.recentHands).toHaveLength(20);
    expect(
      state.session?.ledger.filter((entry) => entry.type === LedgerEntryType.InitialGrant),
    ).toHaveLength(6);
  });

  it("replays the same table commands and seeded RNG to identical output", () => {
    expect(replayLongSequence()).toEqual(replayLongSequence());
  });
});
