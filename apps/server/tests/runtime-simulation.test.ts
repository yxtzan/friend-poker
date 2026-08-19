import { describe, expect, it } from "vitest";

import {
  HandLifecycleStatus,
  PlayerActionType,
} from "@friend-poker/poker-engine";
import type { TableSeat } from "@friend-poker/poker-engine";
import {
  CommandRejectionReason,
  RuntimeCommandType,
} from "../src/index.js";
import type { SafeTableProjection } from "../src/index.js";
import {
  publicProjection,
  startedRuntime,
} from "./helpers.js";

function allPublicPlayers(projection: SafeTableProjection) {
  return [
    ...projection.seats.filter((player) => player !== null),
    ...projection.spectators,
  ];
}

async function runMixedSimulation() {
  const playerIds = ["A", "B", "C", "D", "E", "F"] as const;
  const fixture = await startedRuntime(playerIds);
  let attemptedCommands = playerIds.length + 1;
  let staleRejections = 0;
  let duplicateRetries = 0;

  for (let handNumber = 1; handNumber <= 20; handNumber += 1) {
    if (handNumber % 4 === 0) {
      const oldSeat = fixture.system.projection().seats.findIndex(
        (player) => player?.playerId === "F",
      ) as TableSeat;
      await fixture.clients.F!.execute({ type: RuntimeCommandType.StandToSpectate });
      await fixture.clients.F!.execute({ type: RuntimeCommandType.Sit, seat: oldSeat });
      attemptedCommands += 2;
    }
    if (handNumber % 5 === 0) {
      await fixture.clients.A!.execute({
        type: RuntimeCommandType.Replenish,
        ledgerEntryId: `simulation-replenish-${handNumber}`,
      });
      attemptedCommands += 1;
    }
    if (handNumber % 6 === 0) {
      await fixture.system.execute({
        type: RuntimeCommandType.SetOnline,
        targetPlayerId: "E",
        online: false,
      });
      attemptedCommands += 1;
    }
    if (handNumber % 7 === 0) {
      await fixture.clients.A!.execute({
        type: RuntimeCommandType.HostAdjustChips,
        targetPlayerId: "A",
        amount: 1,
        ledgerEntryId: `simulation-plus-${handNumber}`,
      });
      await fixture.clients.A!.execute({
        type: RuntimeCommandType.HostAdjustChips,
        targetPlayerId: "A",
        amount: -1,
        ledgerEntryId: `simulation-minus-${handNumber}`,
      });
      attemptedCommands += 2;
    }

    const startEnvelope = fixture.clients.A!.envelope(
      handNumber === 1
        ? {
            type: RuntimeCommandType.StartFirstHand,
            handId: "simulation-hand-1",
            buttonSeat: 0,
          }
        : {
            type: RuntimeCommandType.StartNextHand,
            handId: `simulation-hand-${handNumber}`,
          },
    );
    const started = await fixture.clients.A!.replay(startEnvelope);
    const duplicateStart = await fixture.clients.A!.replay(startEnvelope);
    attemptedCommands += 2;
    duplicateRetries += 1;
    expect(started.status).toBe("APPLIED");
    expect(duplicateStart.status).toBe("DUPLICATE");

    let firstAction = true;
    while (fixture.system.projection().currentHand !== null) {
      const hand = fixture.system.projection().currentHand!;
      if (hand.status === HandLifecycleStatus.RunoutRequired) {
        const runout = await fixture.system.execute({ type: RuntimeCommandType.AdvanceRunout });
        attemptedCommands += 1;
        expect(runout.status).toBe("APPLIED");
        continue;
      }
      const actorId = hand.currentActorId!;
      const actor = fixture.clients[actorId]!;
      const actionVersion = fixture.runtime.version;
      const fold = actor.envelope(
        {
          type: RuntimeCommandType.PokerAction,
          action: { type: PlayerActionType.Fold },
        },
        { expectedVersion: actionVersion },
      );
      const folded = await actor.replay(fold);
      attemptedCommands += 1;
      expect(folded.status).toBe("APPLIED");

      if (firstAction && fixture.system.projection().currentHand !== null) {
        const stale = actor.envelope(
          {
            type: RuntimeCommandType.PokerAction,
            action: { type: PlayerActionType.Fold },
          },
          { expectedVersion: actionVersion },
        );
        const staleResult = await actor.replay(stale);
        attemptedCommands += 1;
        staleRejections += 1;
        expect(staleResult).toMatchObject({
          status: "REJECTED",
          reason: CommandRejectionReason.StaleVersion,
        });
      }
      firstAction = false;
    }

    if (handNumber % 6 === 0) {
      await fixture.system.execute({
        type: RuntimeCommandType.SetOnline,
        targetPlayerId: "E",
        online: true,
      });
      attemptedCommands += 1;
    }

    const reference = publicProjection(fixture.system.projection());
    for (const playerId of playerIds) {
      const projection = fixture.clients[playerId]!.projection();
      expect(publicProjection(projection)).toEqual(reference);
      expect(projection.version).toBe(fixture.runtime.version);
      expect(projection.ownHoleCards).toBeNull();
    }

    const balanceTotal = allPublicPlayers(reference).reduce(
      (total, player) => total + player.chipBalance,
      0,
    );
    const externalFlowTotal = reference.session!.ledger.reduce(
      (total, entry) => total + entry.amount,
      0,
    );
    expect(balanceTotal).toBe(externalFlowTotal);
    expect(allPublicPlayers(reference).every((player) => player.chipBalance >= 0)).toBe(true);
    expect(
      reference.recentHands.every(
        (record) => record.record.revealedHoleCards.length === 0,
      ),
    ).toBe(true);
  }

  return Object.freeze({
    projection: fixture.system.projection(),
    version: fixture.runtime.version,
    attemptedCommands,
    staleRejections,
    duplicateRetries,
  });
}

describe("deterministic six-client runtime simulation", () => {
  it("keeps all clients synchronized through 100+ mixed serialized commands", async () => {
    const result = await runMixedSimulation();
    expect(result.attemptedCommands).toBe(188);
    expect(result.staleRejections).toBe(20);
    expect(result.duplicateRetries).toBe(20);
    expect(result.projection.recentHands).toHaveLength(20);
    expect(result.projection.session?.completedHandCount).toBe(20);
  });

  it("replays the complete simulation to identical versioned output", async () => {
    const first = await runMixedSimulation();
    const second = await runMixedSimulation();
    expect(second).toEqual(first);
  });
});
