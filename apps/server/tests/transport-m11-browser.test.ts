import { afterEach, describe, expect, it } from "vitest";

import { TableLifecycleStatus } from "@friend-poker/poker-engine";
import {
  createConnectedClient,
  createTransportFixture,
  executeSocketCommand,
  nextCommand,
  synchronizeClients,
} from "./transport-helpers.js";
import type { ConnectedClient, TransportFixture } from "./transport-helpers.js";

let fixture: TransportFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

async function createTwoPlayers(): Promise<readonly [ConnectedClient, ConnectedClient]> {
  fixture = await createTransportFixture();
  const alice = await createConnectedClient(fixture, "Alice", { kind: "SEAT", seat: 0 });
  const bob = await createConnectedClient(fixture, "Bob", { kind: "SEAT", seat: 1 });
  await synchronizeClients([alice, bob]);
  return [alice, bob];
}

describe("M11 browser intent transport", () => {
  it("enriches Session, hand, ledger, and poker intents on the server", async () => {
    const [alice, bob] = await createTwoPlayers();

    const started = await executeSocketCommand(
      alice.socket,
      nextCommand(alice.latestProjection, "browser-start-session", { type: "START_SESSION" }),
    );
    expect(started.status).toBe("APPLIED");
    expect(started.projection.session?.sessionId).toContain("browser-session");
    expect(started.projection.session?.ledger).toHaveLength(2);
    expect(started.projection.session?.ledger.every((entry) => entry.ledgerEntryId !== "browser-ledger")).toBe(true);

    await synchronizeClients([alice, bob]);
    const replenished = await executeSocketCommand(
      bob.socket,
      nextCommand(bob.latestProjection, "browser-replenish", { type: "REPLENISH" }),
    );
    expect(replenished.status).toBe("APPLIED");
    expect(replenished.projection.session?.ledger.at(-1)).toMatchObject({
      playerId: bob.identity.playerId,
      type: "REPLENISHMENT",
      amount: 100,
    });

    await synchronizeClients([alice, bob]);
    const firstHand = await executeSocketCommand(
      alice.socket,
      nextCommand(alice.latestProjection, "browser-start-first-hand", { type: "START_FIRST_HAND" }),
    );
    expect(firstHand.status).toBe("APPLIED");
    expect(firstHand.projection.currentHand?.handId).toContain("browser-first-hand");

    await synchronizeClients([alice, bob]);
    const actorId = firstHand.projection.currentHand?.currentActorId;
    if (actorId === null || actorId === undefined) throw new Error("Missing current actor");
    const actor = actorId === alice.identity.playerId ? alice : bob;
    const folded = await executeSocketCommand(
      actor.socket,
      nextCommand(actor.latestProjection, "browser-fold", { type: "FOLD" }),
    );
    expect(folded.status).toBe("APPLIED");
    expect(folded.projection.status).toBe(TableLifecycleStatus.BetweenHands);

    await synchronizeClients([alice, bob]);
    const nextHand = await executeSocketCommand(
      alice.socket,
      nextCommand(alice.latestProjection, "browser-start-next-hand", { type: "START_NEXT_HAND" }),
    );
    expect(nextHand.status).toBe("APPLIED");
    expect(nextHand.projection.currentHand?.handId).toContain("browser-next-hand");
  });

  it("accepts direct browser actions without exposing an actor field", async () => {
    const [alice, bob] = await createTwoPlayers();
    const started = await executeSocketCommand(
      alice.socket,
      nextCommand(alice.latestProjection, "browser-contract-session", { type: "START_SESSION" }),
    );
    expect(started.status).toBe("APPLIED");
    await synchronizeClients([alice, bob]);
    const handInput = nextCommand(
      alice.latestProjection,
      "browser-contract-hand",
      { type: "START_FIRST_HAND" },
    );
    const maliciousHandInput = {
      ...handInput,
      command: { type: "START_FIRST_HAND", buttonSeat: 4 },
    };
    const hand = await executeSocketCommand(alice.socket, maliciousHandInput);
    expect(hand.status).toBe("APPLIED");
    expect(hand.projection.currentHand?.buttonSeat).toBe(0);
    const duplicateHand = await executeSocketCommand(alice.socket, maliciousHandInput);
    expect(duplicateHand.status).toBe("DUPLICATE");
    await synchronizeClients([alice, bob]);
    const actor = hand.projection.currentHand?.currentActorId === alice.identity.playerId ? alice : bob;
    const input = nextCommand(actor.latestProjection, "browser-contract-fold", { type: "FOLD" });
    expect(input).not.toHaveProperty("actorId");
    expect(input.command).not.toHaveProperty("ledgerEntryId");
    expect((await executeSocketCommand(actor.socket, input)).status).toBe("APPLIED");
  });
});
