import { describe, expect, it } from "vitest";

import {
  adjustPlayerChips,
  calculateNetResult,
  changeBlinds,
  endSession,
  enterTable,
  getEligiblePlayers,
  getPlayerNetResult,
  kickPlayer,
  LedgerEntryType,
  prepareEndSession,
  replenishPlayer,
  seatPlayer,
  standToSpectate,
  startFirstHand,
  startSession,
  TableLifecycleStatus,
} from "../src/index.js";
import { completeTableHand, player, rng, startedSession } from "./table-helpers.js";

describe("Session lifecycle", () => {
  it("starts a Session separately from its first hand and resets blinds to 1/2", () => {
    let state = startedSession();
    expect(state.status).toBe(TableLifecycleStatus.WaitingForFirstHand);
    expect(state.activeHand).toBeNull();
    expect(state.session?.blinds).toEqual({ smallBlind: 1, bigBlind: 2 });

    state = changeBlinds(state, {
      operatorPlayerId: "A",
      smallBlind: 2,
      bigBlind: 5,
    });
    state = endSession(state, {
      operatorPlayerId: "A",
      confirmation: prepareEndSession(state, "A"),
    });
    state = startSession(state, {
      operatorPlayerId: "A",
      sessionId: "session-2",
      initialGrants: [
        { playerId: "A", ledgerEntryId: "s2-a" },
        { playerId: "B", ledgerEntryId: "s2-b" },
      ],
    });

    expect(state.session?.blinds).toEqual({ smallBlind: 1, bigBlind: 2 });
    expect(state.session?.completedHandCount).toBe(0);
    expect(state.session?.lastButtonSeat).toBeNull();
  });

  it("cannot end during a hand and ends between hands using a matching confirmation", () => {
    let state = startedSession();
    state = startFirstHand(
      state,
      { operatorPlayerId: "A", handId: "h1", buttonSeat: 0 },
      rng(),
    );
    expect(() => prepareEndSession(state, "A")).toThrow(/hand is in progress/u);
    expect(() =>
      endSession(state, {
        operatorPlayerId: "A",
        confirmation: {
          sessionId: "session-1",
          completedHandCount: 0,
          participantPlayerIds: ["A", "B"],
          finalChipBalances: { A: 100, B: 100 },
        },
      }),
    ).toThrow(/hand is in progress/u);

    state = completeTableHand(state);
    state = endSession(state, {
      operatorPlayerId: "A",
      confirmation: prepareEndSession(state, "A"),
    });
    expect(state.status).toBe(TableLifecycleStatus.SessionEnded);
    expect(state.recentSessions[0]?.handCount).toBe(1);
  });

  it("rejects a stale end confirmation and records deterministic metadata", () => {
    let state = startedSession();
    const stale = prepareEndSession(state, "A");
    state = replenishPlayer(state, { playerId: "A", ledgerEntryId: "replenish-a" });
    expect(() =>
      endSession(state, { operatorPlayerId: "A", confirmation: stale }),
    ).toThrow(/stale|does not match/u);

    state = endSession(state, {
      operatorPlayerId: "A",
      confirmation: prepareEndSession(state, "A"),
      endMetadata: { endedAt: "caller-time-2" },
    });
    expect(state.status).toBe(TableLifecycleStatus.SessionEnded);
    expect(state.recentSessions[0]?.endMetadata).toEqual({ endedAt: "caller-time-2" });
  });

  it("resets all Session balances, flags, and ledger state for a new Session", () => {
    let state = startedSession();
    state = replenishPlayer(state, { playerId: "A", ledgerEntryId: "r1" });
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "B",
      amount: -20,
      ledgerEntryId: "a1",
    });
    state = endSession(state, {
      operatorPlayerId: "A",
      confirmation: prepareEndSession(state, "A"),
    });
    state = startSession(state, {
      operatorPlayerId: "A",
      sessionId: "new-session",
      initialGrants: [
        { playerId: "A", ledgerEntryId: "new-a" },
        { playerId: "B", ledgerEntryId: "new-b" },
      ],
    });

    expect(state.session?.ledger).toHaveLength(2);
    expect(state.players.map(({ chipBalance }) => chipBalance)).toEqual([100, 100]);
    expect(state.players.every(({ initialGrantReceived }) => initialGrantReceived)).toBe(true);
  });
});

describe("initial Session chips", () => {
  it("grants each already seated player exactly 100 once with ledger entries", () => {
    const state = startedSession(["A", "B", "C"]);
    expect(state.players.map(({ chipBalance }) => chipBalance)).toEqual([100, 100, 100]);
    expect(state.session?.ledger).toHaveLength(3);
    expect(
      state.session?.ledger.every(
        (entry) => entry.type === LedgerEntryType.InitialGrant && entry.amount === 100,
      ),
    ).toBe(true);
  });

  it("grants a mid-Session first sitter once, but not after stand/re-seat or seat change", () => {
    let state = startedSession();
    state = enterTable(state, {
      playerId: "C",
      position: { kind: "SPECTATOR" },
    });
    state = seatPlayer(state, {
      playerId: "C",
      seat: 2,
      initialGrant: { ledgerEntryId: "initial-c" },
    });
    expect(player(state, "C").chipBalance).toBe(100);

    state = standToSpectate(state, "C");
    state = seatPlayer(state, { playerId: "C", seat: 3 });
    state = seatPlayer(state, { playerId: "C", seat: 4 });
    expect(player(state, "C").chipBalance).toBe(100);
    expect(state.session?.ledger.filter((entry) => entry.playerId === "C")).toHaveLength(1);
  });

  it("does not re-grant after kick and identity-based return", () => {
    let state = startedSession(["A", "B", "C"]);
    state = kickPlayer(state, { operatorPlayerId: "A", targetPlayerId: "C" });
    state = enterTable(state, {
      playerId: "C",
      position: { kind: "SEAT", seat: 2 },
    });
    expect(player(state, "C").chipBalance).toBe(100);
    expect(state.session?.ledger.filter((entry) => entry.playerId === "C")).toHaveLength(1);
  });
});

describe("chip ledger and net result", () => {
  it("returns frozen transitions without mutating prior table or ledger state", () => {
    const before = startedSession();
    const snapshot = JSON.stringify(before);
    const after = replenishPlayer(before, { playerId: "A", ledgerEntryId: "immutable-r" });

    expect(JSON.stringify(before)).toBe(snapshot);
    expect(after).not.toBe(before);
    expect(Object.isFrozen(after)).toBe(true);
    expect(Object.isFrozen(after.players)).toBe(true);
    expect(Object.isFrozen(after.session?.ledger)).toBe(true);
    expect(after.session?.ledger).toHaveLength(before.session!.ledger.length + 1);
  });

  it("adds exactly 100 per replenishment, repeatedly and while nonzero", () => {
    let state = startedSession();
    state = replenishPlayer(state, { playerId: "A", ledgerEntryId: "r1" });
    state = replenishPlayer(state, { playerId: "A", ledgerEntryId: "r2" });
    state = replenishPlayer(state, { playerId: "A", ledgerEntryId: "r3" });
    expect(player(state, "A").chipBalance).toBe(400);
    expect(
      state.session?.ledger.filter((entry) => entry.type === LedgerEntryType.Replenishment),
    ).toHaveLength(3);
  });

  it("records positive and negative host adjustments and their operator", () => {
    let state = startedSession();
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "B",
      amount: 20,
      ledgerEntryId: "plus",
    });
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "B",
      amount: -35,
      ledgerEntryId: "minus",
      metadata: { at: "caller-time" },
    });
    expect(player(state, "B").chipBalance).toBe(85);
    expect(state.session?.ledger.at(-1)).toMatchObject({
      amount: -35,
      type: LedgerEntryType.HostAdjustment,
      operatorPlayerId: "A",
      metadata: { at: "caller-time" },
    });
  });

  it("rejects below-zero, fractional, zero, and duplicate-ledger adjustments", () => {
    const state = startedSession();
    expect(() =>
      adjustPlayerChips(state, {
        operatorPlayerId: "A",
        playerId: "B",
        amount: -101,
        ledgerEntryId: "below",
      }),
    ).toThrow(/negative/u);
    expect(() =>
      adjustPlayerChips(state, {
        operatorPlayerId: "A",
        playerId: "B",
        amount: 1.5,
        ledgerEntryId: "fractional",
      }),
    ).toThrow(/integer/u);
    expect(() =>
      adjustPlayerChips(state, {
        operatorPlayerId: "A",
        playerId: "B",
        amount: 0,
        ledgerEntryId: "zero",
      }),
    ).toThrow(/non-zero/u);
    const once = replenishPlayer(state, { playerId: "A", ledgerEntryId: "repeat" });
    expect(() =>
      replenishPlayer(once, { playerId: "A", ledgerEntryId: "repeat" }),
    ).toThrow(/duplicate/iu);
  });

  it("rejects replenishment and host adjustment during an active hand", () => {
    const state = startFirstHand(
      startedSession(),
      { operatorPlayerId: "A", handId: "h1", buttonSeat: 0 },
      rng(),
    );
    expect(() =>
      replenishPlayer(state, { playerId: "A", ledgerEntryId: "r-active" }),
    ).toThrow(/hand is in progress/u);
    expect(() =>
      adjustPlayerChips(state, {
        operatorPlayerId: "A",
        playerId: "B",
        amount: 1,
        ledgerEntryId: "a-active",
      }),
    ).toThrow(/hand is in progress/u);
  });

  it("uses signed external flows in net result, including the SPEC +30 example", () => {
    let state = startedSession();
    expect(getPlayerNetResult(state, "A")).toBe(0);
    state = replenishPlayer(state, { playerId: "A", ledgerEntryId: "r" });
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "A",
      amount: 20,
      ledgerEntryId: "plus-20",
    });
    expect(
      calculateNetResult({
        finalChips: 250,
        initialGrants: 100,
        replenishments: 100,
        hostAdjustments: 20,
      }),
    ).toBe(30);
    expect(
      calculateNetResult({
        finalChips: 90,
        initialGrants: 100,
        replenishments: 0,
        hostAdjustments: -20,
      }),
    ).toBe(10);
    expect(
      calculateNetResult({
        finalChips: 105,
        initialGrants: 100,
        replenishments: 0,
        hostAdjustments: 0,
      }),
    ).toBe(5);
    expect(getPlayerNetResult(state, "A")).toBe(0);
  });

  it("makes a zero-stack seated player eligible after replenishing", () => {
    let state = startedSession();
    state = adjustPlayerChips(state, {
      operatorPlayerId: "A",
      playerId: "B",
      amount: -100,
      ledgerEntryId: "zero-b",
    });
    expect(getEligiblePlayers(state).map(({ playerId }) => playerId)).toEqual(["A"]);
    state = replenishPlayer(state, { playerId: "B", ledgerEntryId: "restore-b" });
    expect(getEligiblePlayers(state).map(({ playerId }) => playerId)).toEqual(["A", "B"]);
  });
});

describe("blind configuration", () => {
  it("allows valid changes before and between hands and rejects invalid values", () => {
    const state = startedSession();
    expect(() =>
      changeBlinds(state, { operatorPlayerId: "A", smallBlind: 2, bigBlind: 2 }),
    ).toThrow(/small blind below big blind/u);
    expect(() =>
      changeBlinds(state, { operatorPlayerId: "A", smallBlind: 0, bigBlind: 2 }),
    ).toThrow(/positive integers/u);
    expect(() =>
      changeBlinds(state, { operatorPlayerId: "A", smallBlind: 1.5, bigBlind: 3 }),
    ).toThrow(/positive integers/u);
  });
});
