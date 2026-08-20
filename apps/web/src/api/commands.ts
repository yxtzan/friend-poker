import {
  TransportEvent,
  type CommandResult,
  type M10ClientCommandInput,
  type M10Command,
  type SafeTableProjection,
} from "@friend-poker/shared";
import type { TableSocket } from "./socket.js";

export function createCommandId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") return cryptoApi.randomUUID();
  if (typeof cryptoApi?.getRandomValues === "function") {
    const bytes = cryptoApi.getRandomValues(new Uint8Array(16));
    return `m10-${Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
  }
  return `m10-${Date.now()}-${Math.random().toString(36).slice(2)}`;
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

/**
 * The only browser command path. It sends a command intent and adopts the
 * projection returned by the authoritative server for every acknowledgement.
 */
export class TableCommandClient {
  readonly #socket: TableSocket;
  readonly #getProjection: CommandClientOptions["getProjection"];
  readonly #acceptProjection: CommandClientOptions["acceptProjection"];
  readonly #ackTimeoutMs: number;

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

  public submit(command: M10Command): Promise<CommandResult> {
    const projection = this.#getProjection();
    if (projection === null) {
      return Promise.reject(new Error("尚未收到服务器牌桌状态"));
    }
    const input: M10ClientCommandInput = Object.freeze({
      commandId: createCommandId(),
      expectedVersion: projection.version,
      command,
    });
    return new Promise((resolve, reject) => {
      let settled = false;
      const timeoutId = setTimeout(() => {
        settled = true;
        reject(new CommandAcknowledgementTimeoutError(input.commandId, this.#ackTimeoutMs));
      }, this.#ackTimeoutMs);
      const acknowledge = (result: CommandResult): void => {
        // A late ACK may prove that the server applied the command after the
        // client timed out. It is still authoritative, and version filtering
        // belongs to the projection consumer.
        this.#acceptProjection(result.projection);
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        resolve(result);
      };
      try {
        this.#socket.emit(TransportEvent.TableCommand, input, acknowledge);
      } catch (error) {
        if (settled) return;
        settled = true;
        clearTimeout(timeoutId);
        reject(error);
      }
    });
  }
}
