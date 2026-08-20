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
      this.#uncertainEnvelope = null;
      this.#uncertainRetryCount = 0;
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
    return this.#send(input);
  }

  public retryUncertain(): Promise<CommandResult> {
    if (this.#uncertainEnvelope === null) {
      return Promise.reject(new Error("当前没有需要重新确认的操作"));
    }
    if (this.#uncertainRetryCount >= 1) {
      return Promise.reject(new UncertainCommandRetryLimitError());
    }
    this.#uncertainRetryCount += 1;
    return this.#send(this.#uncertainEnvelope);
  }

  #send(input: M11ClientCommandInput): Promise<CommandResult> {
    this.#inFlight = true;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        settled = true;
        this.#inFlight = false;
        this.#uncertainEnvelope = input;
        reject(new CommandAcknowledgementTimeoutError(input.commandId, this.#ackTimeoutMs));
      }, this.#ackTimeoutMs);
      const acknowledge = (result: CommandResult): void => {
        // A late ACK may prove that the server applied the command after the
        // client timed out. It is still authoritative and resolves uncertainty.
        this.#acceptProjection(result.projection);
        if (result.commandId === input.commandId) {
          this.#uncertainEnvelope = null;
          this.#uncertainRetryCount = 0;
        }
        if (settled) return;
        settled = true;
        this.#inFlight = false;
        clearTimeout(timeoutId);
        resolve(result);
      };
      try {
        this.#socket.emit(TransportEvent.TableCommand, input, acknowledge);
      } catch (error) {
        if (settled) return;
        settled = true;
        this.#inFlight = false;
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }
}
