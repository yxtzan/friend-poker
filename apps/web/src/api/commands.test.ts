import { describe, expect, it, vi } from "vitest";
import type { CommandResult } from "@friend-poker/shared";
import {
  CommandAcknowledgementTimeoutError,
  CommandReconciledByProjectionError,
  TableCommandClient,
} from "./commands.js";
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

  it("rejects after an ACK timeout without retrying or mutating projection state", async () => {
    vi.useFakeTimers();
    try {
      const projection = projectionFixture();
      const emit = vi.fn();
      const socket = { emit } as unknown as TableSocket;
      const acceptProjection = vi.fn();
      const client = new TableCommandClient(socket, {
        getProjection: () => projection,
        acceptProjection,
        ackTimeoutMs: 50,
      });

      const submission = client.submit({ type: "SIT", seat: 1 });
      const rejection = expect(submission).rejects.toBeInstanceOf(CommandAcknowledgementTimeoutError);
      expect(emit).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(50);

      await rejection;
      expect(emit).toHaveBeenCalledTimes(1);
      expect(acceptProjection).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("retries one lost ACK with the exact same command envelope", async () => {
    vi.useFakeTimers();
    try {
      const projection = projectionFixture();
      const emit = vi.fn();
      const socket = { emit } as unknown as TableSocket;
      let currentProjection = projection;
      const acceptProjection = vi.fn((next: typeof projection) => {
        currentProjection = next;
      });
      const client = new TableCommandClient(socket, {
        getProjection: () => currentProjection,
        acceptProjection,
        ackTimeoutMs: 50,
      });

      const first = client.submit({ type: "CALL" });
      const firstRejection = expect(first).rejects.toBeInstanceOf(CommandAcknowledgementTimeoutError);
      await vi.advanceTimersByTimeAsync(50);
      await firstRejection;
      const firstEnvelope = emit.mock.calls[0]?.[1] as Record<string, unknown>;

      const retry = client.retryUncertain();
      const secondEnvelope = emit.mock.calls[1]?.[1] as Record<string, unknown>;
      expect(secondEnvelope.commandId).toBe(firstEnvelope.commandId);
      expect(secondEnvelope.expectedVersion).toBe(firstEnvelope.expectedVersion);
      expect(secondEnvelope.command).toEqual(firstEnvelope.command);

      const firstAcknowledge = emit.mock.calls[0]?.[2] as (result: CommandResult) => void;
      const reconciled = { ...projection, version: projection.version + 1, ownHoleCards: null };
      currentProjection = reconciled;
      const retryRejection = expect(retry).rejects.toBeInstanceOf(CommandReconciledByProjectionError);
      client.observeProjection(reconciled);
      await retryRejection;
      expect(client.uncertainCommand).toBeNull();

      const authoritative = {
        status: "APPLIED",
        commandId: String(firstEnvelope.commandId),
        version: reconciled.version,
        data: { kind: "NONE" },
        projection: reconciled,
      } satisfies CommandResult;
      firstAcknowledge(authoritative);
      expect(client.uncertainCommand).toBeNull();

      await vi.advanceTimersByTimeAsync(50);
      expect(emit).toHaveBeenCalledTimes(2);

      const next = client.submit({ type: "CHECK" });
      expect(emit).toHaveBeenCalledTimes(3);
      const nextAcknowledge = emit.mock.calls[2]?.[2] as (result: CommandResult) => void;
      nextAcknowledge({
        status: "APPLIED",
        commandId: String((emit.mock.calls[2]?.[1] as Record<string, unknown>).commandId),
        version: 9,
        data: { kind: "NONE" },
        projection: { ...projection, version: 9 },
      });
      await expect(next).resolves.toMatchObject({ status: "APPLIED" });
      expect(client.uncertainCommand).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("unblocks only after a newer authoritative projection makes the old envelope stale", async () => {
    vi.useFakeTimers();
    try {
      const projection = projectionFixture();
      const fresh = { ...projection, version: projection.version + 1, ownHoleCards: null };
      let currentProjection = projection;
      const emit = vi.fn();
      const socket = { emit } as unknown as TableSocket;
      const client = new TableCommandClient(socket, {
        getProjection: () => currentProjection,
        acceptProjection: vi.fn(),
        ackTimeoutMs: 50,
      });
      const first = client.submit({ type: "FOLD" });
      const firstRejection = expect(first).rejects.toBeInstanceOf(CommandAcknowledgementTimeoutError);
      await vi.advanceTimersByTimeAsync(50);
      await firstRejection;
      currentProjection = fresh;
      client.observeProjection(fresh);
      const next = client.submit({ type: "CHECK" });
      const acknowledge = emit.mock.calls[1]?.[2] as (result: CommandResult) => void;
      acknowledge({
        status: "APPLIED",
        commandId: String((emit.mock.calls[1]?.[1] as Record<string, unknown>).commandId),
        version: fresh.version + 1,
        data: { kind: "NONE" },
        projection: { ...fresh, version: fresh.version + 1 },
      });
      await expect(next).resolves.toMatchObject({ status: "APPLIED" });
    } finally {
      vi.useRealTimers();
    }
  });
});
