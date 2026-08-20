import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CommandResult,
  IdentityResponse,
  M10ClientCommandInput,
} from "@friend-poker/shared";
import { TransportEvent } from "@friend-poker/shared";
import type { TableSocket } from "../api/socket.js";
import { projectionFixture } from "../test/fixtures.js";
import { useTableApp } from "./use-table-app.js";

class FakeSocket {
  public active = true;
  public connected = false;
  readonly #listeners = new Map<string, ((...args: never[]) => void)[]>();
  public readonly emitted: M10ClientCommandInput[] = [];
  public acknowledge: ((result: CommandResult) => void) | null = null;

  public on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  public emit(event: string, ...args: unknown[]): boolean {
    if (event === TransportEvent.TableCommand) {
      this.emitted.push(args[0] as M10ClientCommandInput);
      this.acknowledge = args[1] as (result: CommandResult) => void;
    }
    return true;
  }

  public disconnect(): this {
    this.active = false;
    this.connected = false;
    return this;
  }

  public trigger(event: string, ...args: unknown[]): void {
    for (const listener of this.#listeners.get(event) ?? []) listener(...(args as never[]));
  }
}

const identity: IdentityResponse = { status: "RESTORED", playerId: "alice", nickname: "Alice" };

describe("useTableApp", () => {
  it("shows identity-required state when no valid recovery credential exists", async () => {
    const restoreIdentity = vi.fn(async () => null);
    const { result } = renderHook(() => useTableApp({ restoreIdentity }));

    await waitFor(() => expect(result.current.phase).toBe("ENTRY"));
    expect(restoreIdentity).toHaveBeenCalledTimes(1);
  });

  it("replaces projection on Socket.IO sync and handles revoked state", async () => {
    const socket = new FakeSocket();
    const { result } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );
    const first = projectionFixture({ version: 4 });
    const second = projectionFixture({ version: 5, ownHoleCards: null });

    await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
    act(() => socket.trigger("connect"));
    act(() => socket.trigger(TransportEvent.TableState, first));
    await waitFor(() => expect(result.current.projection).toBe(first));
    act(() => socket.trigger(TransportEvent.TableState, second));
    await waitFor(() => expect(result.current.projection).toBe(second));
    act(() => socket.trigger(TransportEvent.IdentityRevoked, { reason: "SESSION_ENDED" }));

    await waitFor(() => expect(result.current.phase).toBe("SESSION_ENDED"));
    expect(result.current.identity).toBeNull();
  });

  it("submits presence commands with the current version and adopts stale state", async () => {
    const socket = new FakeSocket();
    const { result } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );
    const initial = projectionFixture({ version: 10 });
    const fresh = projectionFixture({ version: 11, ownHoleCards: null });

    await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
    act(() => {
      socket.trigger("connect");
      socket.trigger(TransportEvent.TableState, initial);
    });
    let commandPromise: Promise<CommandResult | null> | undefined;
    act(() => {
      commandPromise = result.current.submitCommand({ type: "SIT", seat: 1 });
    });
    await waitFor(() => expect(socket.emitted).toHaveLength(1));
    expect(socket.emitted[0]).toMatchObject({ expectedVersion: 10, command: { type: "SIT", seat: 1 } });
    expect(socket.emitted[0]).not.toHaveProperty("actorId");
    act(() => {
      socket.acknowledge?.({
        status: "REJECTED",
        commandId: socket.emitted[0]?.commandId ?? "missing",
        version: 11,
        reason: "STALE_VERSION",
        message: "stale",
        projection: fresh,
      });
    });
    if (commandPromise === undefined) throw new Error("command was not submitted");
    const commandResult = await commandPromise;
    await waitFor(() => expect(result.current.projection).toBe(fresh));
    expect(commandResult?.status).toBe("REJECTED");
  });
});
