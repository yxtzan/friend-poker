import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@friend-poker/shared";
import { TableCommandClient } from "./commands.js";
import type { TableSocket } from "./socket.js";
import { projectionFixture } from "../test/fixtures.js";

describe("TableCommandClient", () => {
  it("submits only commandId, expectedVersion, and a typed command", async () => {
    const projection = projectionFixture();
    const emit = vi.fn((_event: string, _input: unknown, acknowledge: (result: CommandResult) => void) => {
      acknowledge({
        status: "APPLIED",
        commandId: "command-1",
        version: 8,
        data: { kind: "NONE" },
        projection: { ...projection, version: 8 },
      });
    });
    const socket = { emit } as unknown as TableSocket;
    const acceptProjection = vi.fn();
    const client = new TableCommandClient(socket, {
      getProjection: () => projection,
      acceptProjection,
    });

    await client.submit({ type: "SIT", seat: 1 });

    const input = emit.mock.calls[0]?.[1] as Record<string, unknown>;
    expect(input).toMatchObject({
      expectedVersion: 7,
      command: { type: "SIT", seat: 1 },
    });
    expect(input).not.toHaveProperty("actorId");
    expect(input).not.toHaveProperty("principal");
    expect(acceptProjection).toHaveBeenCalledTimes(1);
  });

  it("adopts stale and duplicate projections without retrying", async () => {
    const projection = projectionFixture();
    const fresh = { ...projection, version: 9, ownHoleCards: null };
    const emit = vi.fn(
      (_event: string, _input: unknown, acknowledge: (result: CommandResult) => void) => {
        if (emit.mock.calls.length === 1) {
          acknowledge({
            status: "REJECTED",
            commandId: "command-2",
            version: 9,
            reason: "STALE_VERSION",
            message: "stale",
            projection: fresh,
          });
          return;
        }
        acknowledge({
          status: "DUPLICATE",
          commandId: "command-2",
          version: 9,
          originalVersion: 8,
          originalStatus: "APPLIED",
          data: { kind: "NONE" },
          projection: fresh,
        });
      },
    );
    const socket = { emit } as unknown as TableSocket;
    const acceptProjection = vi.fn();
    const client = new TableCommandClient(socket, {
      getProjection: () => projection,
      acceptProjection,
    });

    const result = await client.submit({ type: "STAND_TO_SPECTATE" });

    expect(result.status).toBe("REJECTED");
    const duplicateResult = await client.submit({ type: "STAND_TO_SPECTATE" });

    expect(duplicateResult.status).toBe("DUPLICATE");
    expect(emit).toHaveBeenCalledTimes(2);
    expect(acceptProjection).toHaveBeenCalledTimes(2);
    expect(acceptProjection).toHaveBeenLastCalledWith(fresh);
  });
});
