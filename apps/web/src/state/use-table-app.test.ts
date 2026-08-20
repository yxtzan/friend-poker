import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type {
  CommandResult,
  IdentityResponse,
  M10ClientCommandInput,
  PublicTableHandRecord,
} from "@friend-poker/shared";
import { TransportEvent } from "@friend-poker/shared";
import type { TableSocket } from "../api/socket.js";
import { projectionFixture } from "../test/fixtures.js";
import { useTableApp } from "./use-table-app.js";

const soundMocks = vi.hoisted(() => ({
  dispose: vi.fn(),
  play: vi.fn(),
  playReaction: vi.fn(),
  unlock: vi.fn(),
}));

vi.mock("./sound.js", () => ({
  TableSoundPlayer: class MockTableSoundPlayer {
    public readonly dispose = soundMocks.dispose;
    public readonly play = soundMocks.play;
    public readonly playReaction = soundMocks.playReaction;
    public readonly unlock = soundMocks.unlock;
  },
}));

class FakeSocket {
  public active = true;
  public connected = false;
  readonly #listeners = new Map<string, ((...args: never[]) => void)[]>();
  public readonly emitted: M10ClientCommandInput[] = [];
  public readonly emittedReactions: unknown[] = [];
  public readonly acknowledgements: ((result: CommandResult) => void)[] = [];
  public acknowledge: ((result: CommandResult) => void) | null = null;

  public on(event: string, listener: (...args: never[]) => void): this {
    const listeners = this.#listeners.get(event) ?? [];
    listeners.push(listener);
    this.#listeners.set(event, listeners);
    return this;
  }

  public emit(event: string, ...args: unknown[]): boolean {
    if (event === TransportEvent.TableReaction) {
      this.emittedReactions.push(args[0]);
    }
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

function completedHandFixture(): PublicTableHandRecord {
  return {
    sessionId: "session-1",
    handNumber: 8,
    record: {
      handId: "hand-8",
      participants: [
        { playerId: "alice", nickname: "Alice", seat: 0, startingStack: 100 },
        { playerId: "bob", nickname: "Bob", seat: 2, startingStack: 100 },
      ],
      buttonSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 2,
      smallBlind: 1,
      bigBlind: 2,
      actions: [],
      board: [],
      flop: [],
      turn: null,
      river: null,
      events: [],
      completionReason: "UNCONTESTED",
      settlement: {
        refunds: [],
        pots: [],
        evaluatedHands: [],
        totalPayouts: [{ playerId: "alice", amount: 4 }],
        finalStacks: [],
        totalContribution: 4,
        totalRefund: 0,
        totalPotAmount: 4,
        totalPotPayout: 4,
        totalStartingStacks: 200,
        totalFinalStacks: 200,
      },
      revealedHoleCards: [],
    },
  };
}

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

  it("animates one accepted street advance, then suppresses reconnect and same-hand replays", async () => {
    const socket = new FakeSocket();
    const { result, unmount } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );
    const base = projectionFixture();
    const preflop = {
      ...base,
      version: 40,
      currentHand: { ...base.currentHand!, street: "PREFLOP" as const, board: [] },
    };
    const flop = {
      ...base,
      version: 41,
      currentHand: { ...base.currentHand!, street: "FLOP" as const, board: [...base.currentHand!.board] },
    };
    const turn = {
      ...base,
      version: 43,
      currentHand: { ...base.currentHand!, street: "TURN" as const, board: [...flop.currentHand.board, { rank: 4, suit: "s" as const }] },
    };

    try {
      await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
      act(() => {
        socket.trigger("connect");
        socket.trigger(TransportEvent.TableState, preflop);
      });
      expect(result.current.streetReveal).toBeNull();

      act(() => socket.trigger(TransportEvent.TableState, flop));
      await waitFor(() => expect(result.current.streetReveal?.street).toBe("FLOP"));
      act(() => result.current.clearStreetReveal());
      act(() => socket.trigger(TransportEvent.TableState, { ...flop, version: 42 }));
      expect(result.current.streetReveal).toBeNull();

      act(() => {
        socket.trigger("disconnect");
        socket.trigger("connect");
        socket.trigger(TransportEvent.TableState, turn);
      });
      await waitFor(() => expect(result.current.projection).toBe(turn));
      expect(result.current.streetReveal).toBeNull();
    } finally {
      unmount();
    }
  });

  it("opens a completed-hand result once, keeps it through unrelated updates, and closes it explicitly", async () => {
    const socket = new FakeSocket();
    const { result, unmount } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );
    const initial = projectionFixture({ version: 50 });
    const completed = completedHandFixture();
    const settled = projectionFixture({ version: 51, recentHands: [completed] });
    try {
      await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
      act(() => {
        socket.trigger("connect");
        socket.trigger(TransportEvent.TableState, initial);
        socket.trigger(TransportEvent.TableState, settled);
      });
      await waitFor(() => expect(result.current.handResult).toBe(completed));

      act(() => socket.trigger(TransportEvent.TableState, { ...settled, version: 52 }));
      expect(result.current.handResult).toBe(completed);
      act(() => result.current.closeHandResult());
      expect(result.current.handResult).toBeNull();

      act(() => socket.trigger(TransportEvent.TableState, { ...settled, version: 53 }));
      expect(result.current.handResult).toBeNull();
    } finally {
      unmount();
    }
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

  it("keeps the local reaction popup open past cooldown and allows a future violation", async () => {
    const socket = new FakeSocket();
    const { result, unmount } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );

    await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    try {
      act(() => {
        for (let index = 0; index < 4; index += 1) result.current.sendReaction("😂");
        result.current.sendReaction("😂");
      });
      expect(socket.emittedReactions).toHaveLength(4);
      expect(result.current.reactionEggVisible).toBe(true);

      act(() => vi.advanceTimersByTime(500));
      expect(result.current.reactionEggVisible).toBe(true);

      act(() => result.current.closeReactionEgg());
      expect(result.current.reactionEggVisible).toBe(false);
      act(() => result.current.sendReaction("😂"));
      expect(result.current.reactionEggVisible).toBe(false);

      act(() => vi.advanceTimersByTime(600));
      act(() => {
        for (let index = 0; index < 4; index += 1) result.current.sendReaction("😂");
        result.current.sendReaction("😂");
      });
      expect(socket.emittedReactions).toHaveLength(8);
      expect(result.current.reactionEggVisible).toBe(true);
    } finally {
      unmount();
      vi.useRealTimers();
    }
  });

  it("restores persisted sound and unlocks it on the first user activation", async () => {
    localStorage.setItem("friend-poker:sound-enabled", "true");
    soundMocks.unlock.mockClear();
    soundMocks.playReaction.mockClear();
    const socket = new FakeSocket();
    const { result, unmount } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );

    try {
      await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
      expect(result.current.soundEnabled).toBe(true);
      expect(soundMocks.unlock).not.toHaveBeenCalled();

      act(() => window.dispatchEvent(new Event("pointerdown")));
      expect(soundMocks.unlock).toHaveBeenCalledTimes(1);
      act(() => window.dispatchEvent(new Event("pointerdown")));
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
      expect(soundMocks.unlock).toHaveBeenCalledTimes(1);

      act(() => socket.trigger(TransportEvent.TableReaction, {
        reactionId: "reaction-persisted-sound",
        playerId: identity.playerId,
        emoji: "🔥",
      }));
      expect(soundMocks.playReaction).toHaveBeenCalledTimes(1);
      expect(soundMocks.playReaction).toHaveBeenLastCalledWith("🔥");
    } finally {
      unmount();
      localStorage.removeItem("friend-poker:sound-enabled");
    }
  });

  it("does not unlock or play sounds when persisted sound is off", async () => {
    localStorage.setItem("friend-poker:sound-enabled", "false");
    soundMocks.unlock.mockClear();
    soundMocks.playReaction.mockClear();
    const socket = new FakeSocket();
    const { result, unmount } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );

    try {
      await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
      expect(result.current.soundEnabled).toBe(false);
      act(() => window.dispatchEvent(new Event("pointerdown")));
      act(() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" })));
      act(() => socket.trigger(TransportEvent.TableReaction, {
        reactionId: "reaction-sound-off",
        playerId: identity.playerId,
        emoji: "👏",
      }));
      expect(soundMocks.unlock).not.toHaveBeenCalled();
      expect(soundMocks.playReaction).not.toHaveBeenCalled();
    } finally {
      unmount();
      localStorage.removeItem("friend-poker:sound-enabled");
    }
  });

  it("plays each authoritative reaction once, never on click, and respects sound off", async () => {
    soundMocks.playReaction.mockClear();
    soundMocks.unlock.mockClear();
    const socket = new FakeSocket();
    const { result, unmount } = renderHook(() =>
      useTableApp({
        restoreIdentity: async () => identity,
        createSocket: () => socket as unknown as TableSocket,
      }),
    );

    await waitFor(() => expect(result.current.phase).toBe("CONNECTING"));
    act(() => result.current.setSoundEnabled(true));
    expect(soundMocks.unlock).toHaveBeenCalledTimes(1);

    act(() => {
      for (let index = 0; index < 4; index += 1) result.current.sendReaction("🔥");
      result.current.sendReaction("🔥");
    });
    expect(soundMocks.playReaction).not.toHaveBeenCalled();
    expect(socket.emittedReactions).toHaveLength(4);

    act(() => socket.trigger(TransportEvent.TableReaction, {
      reactionId: "reaction-1",
      playerId: identity.playerId,
      emoji: "🔥",
    }));
    expect(soundMocks.playReaction).toHaveBeenCalledTimes(1);
    expect(soundMocks.playReaction).toHaveBeenLastCalledWith("🔥");

    act(() => result.current.setSoundEnabled(false));
    act(() => socket.trigger(TransportEvent.TableReaction, {
      reactionId: "reaction-2",
      playerId: "bob",
      emoji: "👏",
    }));
    expect(soundMocks.playReaction).toHaveBeenCalledTimes(1);
    unmount();
  });
});
