import {
  TransportEvent,
  type CommandResult,
  type M11ClientCommandInput,
  type M11Command,
  type SafeTableProjection,
} from "@friend-poker/shared";
import type { TableSocket } from "./socket.js";

export function createCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `m11-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `m11-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export interface CommandClientOptions {
  readonly getProjection: () => SafeTableProjection | null;
  readonly acceptProjection: (projection: SafeTableProjection) => void;
  readonly ackTimeoutMs?: number;
}

export const DEFAULT_COMMAND_ACK_TIMEOUT_MS = 10_000;

export class CommandAcknowledgementTimeoutError extends Error {
  public readonly commandId: string;
  public readonly timeoutMs: number;

  public constructor(commandId: string, timeoutMs: number) {
    super(`服务器确认命令 ${commandId} 超时（${timeoutMs}ms）`);
    this.name = "CommandAcknowledgementTimeoutError";
    this.commandId = commandId;
    this.timeoutMs = timeoutMs;
  }
}

export class UncertainCommandError extends Error {
  public constructor() {
    super("上一条牌局操作仍在等待权威确认");
    this.name = "UncertainCommandError";
  }
}

export class UncertainCommandRetryLimitError extends Error {
  public constructor() {
    super("这条操作已经完成一次重新确认，请等待牌桌状态或刷新后再继续");
    this.name = "UncertainCommandRetryLimitError";
  }
}

interface CommandLifecycle {
  readonly input: M11ClientCommandInput;
  readonly attempts: Set<CommandAttempt>;
  acknowledged: boolean;
}

interface CommandAttempt {
  readonly lifecycle: CommandLifecycle;
  readonly resolve: (result: CommandResult) => void;
  readonly reject: (reason?: unknown) => void;
  settled: boolean;
  timeoutId: ReturnType<typeof setTimeout> | null;
}

/**
 * The only browser command path. It sends a command intent and adopts the
 * projection returned by the authoritative server for every acknowledgement.
 * A timed-out envelope is retained so recovery never creates a new command ID.
 */
export class TableCommandClient {
  readonly #socket: TableSocket;
  readonly #getProjection: CommandClientOptions["getProjection"];
  readonly #acceptProjection: CommandClientOptions["acceptProjection"];
  readonly #ackTimeoutMs: number;
  #uncertainEnvelope: M11ClientCommandInput | null = null;
  #uncertainRetryCount = 0;
  #inFlight = false;
  #inFlightCommandId: string | null = null;
  readonly #lifecycles = new Map<string, CommandLifecycle>();

  public constructor(socket: TableSocket, options: CommandClientOptions) {
    this.#socket = socket;
    this.#getProjection = options.getProjection;
    this.#acceptProjection = options.acceptProjection;
    const ackTimeoutMs = options.ackTimeoutMs ?? DEFAULT_COMMAND_ACK_TIMEOUT_MS;
    if (!Number.isFinite(ackTimeoutMs) || ackTimeoutMs <= 0) {
      throw new RangeError("ackTimeoutMs must be a finite positive number");
    }
    this.#ackTimeoutMs = ackTimeoutMs;
  }

  public get uncertainCommand(): M11ClientCommandInput | null {
    return this.#uncertainEnvelope;
  }

  public observeProjection(projection: SafeTableProjection): void {
    // Once the authoritative version moved beyond the envelope's expected
    // version, that envelope can no longer newly apply. It is safe to unblock
    // the next user action; an already-applied command is represented by the
    // newer projection, while an unapplied one is now stale.
    if (
      this.#uncertainEnvelope !== null &&
      projection.version > this.#uncertainEnvelope.expectedVersion
    ) {
      const commandId = this.#uncertainEnvelope.commandId;
      this.#uncertainEnvelope = null;
      this.#uncertainRetryCount = 0;
      const lifecycle = this.#lifecycles.get(commandId);
      if (lifecycle !== undefined && lifecycle.attempts.size === 0) {
        this.#lifecycles.delete(commandId);
      }
    }
  }

  public submit(command: M11Command): Promise<CommandResult> {
    if (this.#uncertainEnvelope !== null) {
      return Promise.reject(new UncertainCommandError());
    }
    if (this.#inFlight) {
      return Promise.reject(new Error("上一条操作仍在等待服务器确认"));
    }
    const projection = this.#getProjection();
    if (projection === null) {
      return Promise.reject(new Error("尚未收到服务器牌桌状态"));
    }
    const input: M11ClientCommandInput = Object.freeze({
      commandId: createCommandId(),
      expectedVersion: projection.version,
      command,
    });
    const lifecycle = {
      input,
      attempts: new Set<CommandAttempt>(),
      acknowledged: false,
    } satisfies CommandLifecycle;
    this.#lifecycles.set(input.commandId, lifecycle);
    return this.#send(lifecycle);
  }

  public retryUncertain(): Promise<CommandResult> {
    if (this.#uncertainEnvelope === null) {
      return Promise.reject(new Error("当前没有需要重新确认的操作"));
    }
    if (this.#uncertainRetryCount >= 1) {
      return Promise.reject(new UncertainCommandRetryLimitError());
    }
    this.#uncertainRetryCount += 1;
    const input = this.#uncertainEnvelope;
    const lifecycle = this.#lifecycles.get(input.commandId) ?? {
      input,
      attempts: new Set<CommandAttempt>(),
      acknowledged: false,
    } satisfies CommandLifecycle;
    this.#lifecycles.set(input.commandId, lifecycle);
    return this.#send(lifecycle);
  }

  #send(lifecycle: CommandLifecycle): Promise<CommandResult> {
    const input = lifecycle.input;
    this.#lifecycles.set(input.commandId, lifecycle);
    this.#inFlight = true;
    this.#inFlightCommandId = input.commandId;
    return new Promise((resolve, reject) => {
      const attempt: CommandAttempt = {
        lifecycle,
        resolve,
        reject,
        settled: false,
        timeoutId: null,
      };
      lifecycle.attempts.add(attempt);

      const releaseInFlight = (): void => {
        if (this.#inFlightCommandId !== input.commandId) return;
        this.#inFlight = false;
        this.#inFlightCommandId = null;
      };
      const forgetIfComplete = (): void => {
        if (lifecycle.acknowledged && lifecycle.attempts.size === 0) {
          this.#lifecycles.delete(input.commandId);
        }
      };
      const settleAttempt = (settlement: () => void): void => {
        if (attempt.settled) return;
        attempt.settled = true;
        if (attempt.timeoutId !== null) clearTimeout(attempt.timeoutId);
        lifecycle.attempts.delete(attempt);
        settlement();
      };
      const settleAnyAttempt = (pending: CommandAttempt, result: CommandResult): void => {
        if (pending.settled) return;
        pending.settled = true;
        if (pending.timeoutId !== null) clearTimeout(pending.timeoutId);
        pending.lifecycle.attempts.delete(pending);
        pending.resolve(result);
      };

      attempt.timeoutId = setTimeout(() => {
        settleAttempt(() => {
          releaseInFlight();
          if (lifecycle.acknowledged) {
            forgetIfComplete();
            return;
          }
          this.#uncertainEnvelope = input;
          reject(new CommandAcknowledgementTimeoutError(input.commandId, this.#ackTimeoutMs));
        });
      }, this.#ackTimeoutMs);

      const acknowledge = (result: CommandResult): void => {
        this.#acceptProjection(result.projection);
        if (result.commandId === input.commandId) {
          lifecycle.acknowledged = true;
          this.#uncertainEnvelope = null;
          this.#uncertainRetryCount = 0;
          for (const pending of [...lifecycle.attempts]) {
            settleAnyAttempt(pending, result);
          }
          releaseInFlight();
          forgetIfComplete();
          return;
        }
        settleAttempt(() => {
          releaseInFlight();
          resolve(result);
        });
      };

      try {
        this.#socket.emit(TransportEvent.TableCommand, input, acknowledge);
      } catch (error) {
        settleAttempt(() => {
          releaseInFlight();
          reject(error);
        });
      }
    });
  }
}
