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
}

/**
 * The only browser command path. It sends a command intent and adopts the
 * projection returned by the authoritative server for every acknowledgement.
 */
export class TableCommandClient {
  readonly #socket: TableSocket;
  readonly #getProjection: CommandClientOptions["getProjection"];
  readonly #acceptProjection: CommandClientOptions["acceptProjection"];

  public constructor(socket: TableSocket, options: CommandClientOptions) {
    this.#socket = socket;
    this.#getProjection = options.getProjection;
    this.#acceptProjection = options.acceptProjection;
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
    return new Promise((resolve) => {
      this.#socket.emit(TransportEvent.TableCommand, input, (result) => {
        this.#acceptProjection(result.projection);
        resolve(result);
      });
    });
  }
}
