import {
  advanceTableRunout,
  applyTableHandAction,
  createTableState,
  enterTable,
  HandLifecycleStatus,
  legalActions,
  PlayerActionType,
  startSession,
  TableLifecycleStatus,
} from "../src/index.js";
import type {
  PlayerId,
  TableSeat,
  TableState,
} from "../src/index.js";
import { seededRandom } from "./helpers.js";

export function seatedTable(
  playerIds: readonly PlayerId[] = ["A", "B"],
  seats: readonly TableSeat[] = playerIds.map((_, index) => index as TableSeat),
): TableState {
  let state = createTableState();
  for (let index = 0; index < playerIds.length; index += 1) {
    state = enterTable(state, {
      playerId: playerIds[index]!,
      nickname: playerIds[index]!,
      position: { kind: "SEAT", seat: seats[index]! },
    });
  }
  return state;
}

export function startedSession(
  playerIds: readonly PlayerId[] = ["A", "B"],
  seats?: readonly TableSeat[],
  sessionId = "session-1",
): TableState {
  return startSession(seatedTable(playerIds, seats), {
    operatorPlayerId: playerIds[0]!,
    sessionId,
    initialGrants: playerIds.map((playerId) => ({
      playerId,
      ledgerEntryId: `${sessionId}-initial-${playerId}`,
    })),
  });
}

export function callOrCheckTable(state: TableState): TableState {
  const hand = state.activeHand;
  if (hand === null || hand.status !== HandLifecycleStatus.Betting) {
    throw new Error("Test expected an active betting hand");
  }
  const legal = legalActions(hand.bettingState);
  return applyTableHandAction(state, {
    playerId: legal.playerId,
    type: legal.canCheck ? PlayerActionType.Check : PlayerActionType.Call,
  });
}

export function completeTableHand(state: TableState): TableState {
  let next = state;
  while (next.status === TableLifecycleStatus.HandInProgress) {
    const hand = next.activeHand!;
    next =
      hand.status === HandLifecycleStatus.RunoutRequired
        ? advanceTableRunout(next)
        : callOrCheckTable(next);
  }
  return next;
}

export function rng(seed = 0x5e551005) {
  return seededRandom(seed);
}

export function player(state: TableState, playerId: PlayerId) {
  const found = state.players.find((candidate) => candidate.playerId === playerId);
  if (found === undefined) throw new Error(`Missing player ${playerId}`);
  return found;
}

export function totalBalances(state: TableState): number {
  return state.players.reduce((total, candidate) => total + candidate.chipBalance, 0);
}
