import { afterEach, describe, expect, it } from "vitest";

import { TransportEvent } from "../src/index.js";
import type { TransportFixture } from "./transport-helpers.js";
import {
  connectWithCookie,
  createConnectedClient,
  createTransportFixture,
  waitForDisconnect,
} from "./transport-helpers.js";

let fixture: TransportFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

function waitForReactionCount(reactions: readonly unknown[], count: number): Promise<void> {
  if (reactions.length >= count) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (reactions.length < count) return;
      clearInterval(timer);
      resolve();
    }, 1);
  });
}

describe("reaction reconnect rate limiting", () => {
  it("keeps the same one-second window across a transient reconnect", async () => {
    let now = 10_000;
    fixture = await createTransportFixture({ reactionClock: () => now });
    const client = await createConnectedClient(fixture, "EmojiPlayer", {
      kind: "SPECTATOR",
    });
    const reactions: unknown[] = [];
    client.socket.on(TransportEvent.TableReaction, (reaction) => reactions.push(reaction));

    for (let index = 0; index < 4; index += 1) {
      client.socket.emit(TransportEvent.TableReaction, { emoji: "😂" });
    }
    await waitForReactionCount(reactions, 4);

    client.socket.emit(TransportEvent.TableReaction, { emoji: "😂" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reactions).toHaveLength(4);

    const disconnected = waitForDisconnect(client.socket);
    client.socket.disconnect();
    await disconnected;

    const reconnected = await connectWithCookie(fixture, client.cookie);
    reconnected.socket.on(TransportEvent.TableReaction, (reaction) => reactions.push(reaction));
    reconnected.socket.emit(TransportEvent.TableReaction, { emoji: "😂" });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reactions).toHaveLength(4);

    now = 11_000;
    reconnected.socket.emit(TransportEvent.TableReaction, { emoji: "😂" });
    await waitForReactionCount(reactions, 5);
    expect(reactions).toHaveLength(5);
  });
});
