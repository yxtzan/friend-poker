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
  public readonly acknowledgements: ((result: CommandResult) => void)[] = [];
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
      this.acknowledgements.push(this.acknowledge);
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

  it("reconciles an in-flight command from an initial newer TABLE_STATE", async () => {
    const socket = new FakeSocket();
    const { result } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
        commandAckTimeoutMs: 20,
      }),
    );
    const initial = projectionFixture({ version: 30 });
    const newer = projectionFixture({ version: 31, ownHoleCards: null });

    await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
    act(() => {
      socket.trigger("connect");
      socket.trigger(TransportEvent.TableState, initial);
    });

    let commandPromise: Promise<CommandResult | null> | undefined;
    act(() => {
      commandPromise = result.current.submitCommand({ type: "CHECK" });
    });
    await waitFor(() => expect(socket.emitted).toHaveLength(1));

    act(() => socket.trigger(TransportEvent.TableState, newer));
    if (commandPromise === undefined) throw new Error("command was not submitted");
    await expect(commandPromise).resolves.toBeNull();
    await waitFor(() => expect(result.current.pendingCommand).toBeNull());
    expect(result.current.uncertainCommand).toBeNull();
    expect(result.current.projection).toBe(newer);
    expect(result.current.notice).toBe("牌桌状态已更新，上一条操作已结束");
    expect(socket.emitted).toHaveLength(1);
  });

  it("clears pending presence commands after disconnect timeout without retrying", async () => {
    const socket = new FakeSocket();
    const { result } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
        commandAckTimeoutMs: 20,
      }),
    );
    const initial = projectionFixture({ version: 20 });
    const newer = projectionFixture({ version: 21, ownHoleCards: null });

    await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
    act(() => {
      socket.trigger("connect");
      socket.trigger(TransportEvent.TableState, initial);
    });
    await waitFor(() => expect(result.current.projection).toBe(initial));

    let commandPromise: Promise<CommandResult | null> | undefined;
    act(() => {
      commandPromise = result.current.submitCommand({ type: "SIT", seat: 1 });
    });
    await waitFor(() => expect(result.current.pendingCommand).toBe("SIT"));
    expect(socket.emitted).toHaveLength(1);

    act(() => {
      socket.active = false;
      socket.trigger("disconnect");
    });
    await waitFor(() => expect(result.current.phase).toBe("DISCONNECTED"));

    if (commandPromise === undefined) throw new Error("command was not submitted");
    await expect(commandPromise).resolves.toBeNull();
    await waitFor(() => expect(result.current.pendingCommand).toBeNull());
    expect(socket.emitted).toHaveLength(1);
    expect(result.current.projection).toBe(initial);
    expect(result.current.notice).toContain("可能已经处理");
    await waitFor(() => expect(result.current.uncertainCommand).not.toBeNull());

    let retryPromise: Promise<CommandResult | null> | undefined;
    act(() => {
      retryPromise = result.current.retryUncertainCommand();
    });
    await waitFor(() => expect(socket.emitted).toHaveLength(2));
    act(() => {
      socket.trigger(TransportEvent.TableState, newer);
    });
    if (retryPromise === undefined) throw new Error("retry was not submitted");
    await expect(retryPromise).resolves.toBeNull();
    await waitFor(() => expect(result.current.pendingCommand).toBeNull());
    await waitFor(() => expect(result.current.uncertainCommand).toBeNull());
    await waitFor(() => expect(result.current.projection).toBe(newer));
    expect(result.current.notice).toBe("牌桌状态已更新，上一条操作已结束");

    act(() => {
      socket.acknowledgements[0]?.({
        status: "APPLIED",
        commandId: socket.emitted[0]?.commandId ?? "missing",
        version: 21,
        data: { kind: "NONE" },
        projection: newer,
      });
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(result.current.uncertainCommand).toBeNull();
    expect(result.current.pendingCommand).toBeNull();
    expect(socket.emitted).toHaveLength(2);

    let nextPromise: Promise<CommandResult | null> | undefined;
    act(() => {
      nextPromise = result.current.submitCommand({ type: "CHECK" });
    });
    await waitFor(() => expect(socket.emitted).toHaveLength(3));
    act(() => {
      socket.acknowledgements[2]?.({
        status: "APPLIED",
        commandId: socket.emitted[2]?.commandId ?? "missing",
        version: 22,
        data: { kind: "NONE" },
        projection: { ...newer, version: 22 },
      });
    });
    if (nextPromise === undefined) throw new Error("next command was not submitted");
    await expect(nextPromise).resolves.toMatchObject({ status: "APPLIED" });

    act(() => socket.trigger(TransportEvent.TableState, newer));
    await waitFor(() => expect(result.current.projection?.version).toBe(22));
  });
});
