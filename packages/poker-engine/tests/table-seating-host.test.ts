import { describe, expect, it } from "vitest";

import {
  adjustPlayerChips,
  applyTableHandAction,
  createTableState,
  enterTable,
  getEligiblePlayers,
  kickPlayer,
  leaveTable,
  PlayerActionType,
  seatPlayer,
  setPlayerOnline,
  standToSpectate,
  startFirstHand,
  startSession,
  TableLifecycleStatus,
  transferHost,
} from "../src/index.js";
import { completeTableHand, player, rng, seatedTable, startedSession } from "./table-helpers.js";

describe("six seats and two spectator positions", () => {
  it("fills exactly six numbered seats and rejects any occupied seat", () => {
    const state = seatedTable(["A", "B", "C", "D", "E", "F"]);
    expect(state.players.filter(({ seat }) => seat !== null)).toHaveLength(6);
    expect(() =>
      enterTable(state, {
        playerId: "G",
        position: { kind: "SEAT", seat: 5 },
      }),
    ).toThrow(/occupied/u);
  });

  it("allows exactly two spectators and rejects a third", () => {
    let state = createTableState();
    state = enterTable(state, { playerId: "A", position: { kind: "SPECTATOR" } });
    state = enterTable(state, { playerId: "B", position: { kind: "SPECTATOR" } });
    expect(() =>
      enterTable(state, { playerId: "C", position: { kind: "SPECTATOR" } }),
    ).toThrow(/both spectator slots/iu);
  });

  it("rejects standing to spectate when both spectator slots are occupied", () => {
    let state = seatedTable(["A", "B", "C"]);
    state = enterTable(state, { playerId: "S1", position: { kind: "SPECTATOR" } });
    state = enterTable(state, { playerId: "S2", position: { kind: "SPECTATOR" } });
    expect(() => standToSpectate(state, "C")).toThrow(/spectator slots/u);
    expect(player(state, "C").seat).toBe(2);
  });

  it("distinguishes explicit leave from standing to spectate", () => {
    let state = seatedTable(["A", "B"]);
    state = standToSpectate(state, "B");
    expect(player(state, "B")).toMatchObject({ present: true, seat: null });
    state = leaveTable(state, "B");
    expect(player(state, "B")).toMatchObject({ present: false, seat: null });
  });
});

describe("seat timing and eligibility snapshots", () => {
  it("allows a seat change between hands and rejects it during a hand", () => {
    let state = startedSession(["A", "B", "C"]);
    state = seatPlayer(state, { playerId: "C", seat: 5 });
    expect(player(state, "C").seat).toBe(5);
    state = startFirstHand(
      state,
      { operatorPlayerId: "A", handId: "h1", buttonSeat: 0 },
      rng(),
    );
    expect(() => seatPlayer(state, { playerId: "C", seat: 4 })).toThrow(/seat changes/iu);
  });

  it("lets a mid-hand spectator sit but keeps them out until the next hand", () => {
    let state = startedSession();
    state = enterTable(state, { playerId: "C", position: { kind: "SPECTATOR" } });
    state = startFirstHand(
      state,
      { operatorPlayerId: "A", handId: "h1", buttonSeat: 0 },
      rng(),
    );
    state = seatPlayer(state, {
      playerId: "C",
      seat: 2,
      initialGrant: { ledgerEntryId: "initial-c" },
    });
    expect(state.activeHand?.bettingState.participants.map(({ playerId }) => playerId)).toEqual([
      "A",
      "B",
    ]);
    state = completeTableHand(state);
    expect(getEligiblePlayers(state).map(({ playerId }) => playerId)).toContain("C");
  });

  it("skips offline, zero-stack, spectator, left, and pending-removal players", () => {
    let state = startedSession(["A", "B", "C", "D"]);
    state = setPlayerOnline(state, "C", false);
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "D",
      amount: -100,
      ledgerEntryId: "zero-d",
    });
    state = standToSpectate(state, "B");
    expect(getEligiblePlayers(state).map(({ playerId }) => playerId)).toEqual(["A"]);
    expect(() =>
      startFirstHand(
        state,
        { operatorPlayerId: "A", handId: "not-enough", buttonSeat: 0 },
        rng(),
      ),
    ).toThrow(/at least two/iu);
  });

  it("retains a zero-chip player's seat", () => {
    let state = startedSession();
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "B",
      amount: -100,
      ledgerEntryId: "zero-b",
    });
    expect(player(state, "B")).toMatchObject({ seat: 1, chipBalance: 0 });
  });
});

describe("host authority", () => {
  it("makes the first entrant host even when spectating", () => {
    let state = createTableState();
    state = enterTable(state, { playerId: "A", position: { kind: "SPECTATOR" } });
    expect(state.hostPlayerId).toBe("A");
    state = enterTable(state, { playerId: "B", position: { kind: "SEAT", seat: 0 } });
    state = enterTable(state, { playerId: "C", position: { kind: "SEAT", seat: 1 } });
    expect(state.hostPlayerId).toBe("A");
    state = startSession(state, {
      operatorPlayerId: "A",
      sessionId: "spectator-host-session",
      initialGrants: [
        { playerId: "B", ledgerEntryId: "initial-b" },
        { playerId: "C", ledgerEntryId: "initial-c" },
      ],
    });
    expect(state.status).toBe(TableLifecycleStatus.WaitingForFirstHand);
  });

  it("transfers explicitly, rejects non-host operations, and does not let the old host reclaim", () => {
    let state = seatedTable(["A", "B"]);
    state = transferHost(state, { operatorPlayerId: "A", targetPlayerId: "B" });
    expect(state.hostPlayerId).toBe("B");
    expect(() =>
      startSession(state, {
        operatorPlayerId: "A",
        sessionId: "forbidden",
        initialGrants: [
          { playerId: "A", ledgerEntryId: "a" },
          { playerId: "B", ledgerEntryId: "b" },
        ],
      }),
    ).toThrow(/current host/u);
    state = leaveTable(state, "A");
    state = enterTable(state, { playerId: "A", position: { kind: "SPECTATOR" } });
    expect(state.hostPlayerId).toBe("B");
  });

  it("permits between-hand kick while preserving the recoverable player record", () => {
    let state = startedSession(["A", "B", "C"]);
    state = kickPlayer(state, { operatorPlayerId: "A", targetPlayerId: "C" });
    expect(player(state, "C")).toMatchObject({ present: false, seat: null, chipBalance: 100 });
    expect(state.session?.participantPlayerIds).toContain("C");
  });
});

describe("explicit in-hand leave boundary", () => {
  it("marks a current participant pending without deleting chips, then releases after settlement", () => {
    let state = startFirstHand(
      startedSession(),
      { operatorPlayerId: "A", handId: "leave-hand", buttonSeat: 0 },
      rng(),
    );
    const beforeTotal = state.players.reduce((sum, candidate) => sum + candidate.chipBalance, 0);
    state = leaveTable(state, "B");
    expect(player(state, "B")).toMatchObject({
      seat: 1,
      present: false,
      pendingLeaveAfterHand: true,
    });

    while (state.status === TableLifecycleStatus.HandInProgress) {
      const actor = state.activeHand?.bettingState.currentActorId;
      if (actor === null || actor === undefined) {
        state = completeTableHand(state);
      } else {
        state = applyTableHandAction(state, { playerId: actor, type: PlayerActionType.Fold });
      }
    }
    expect(player(state, "B")).toMatchObject({
      seat: null,
      pendingLeaveAfterHand: false,
    });
    expect(state.players.reduce((sum, candidate) => sum + candidate.chipBalance, 0)).toBe(
      beforeTotal,
    );
  });
});
