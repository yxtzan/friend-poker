import type { PlayerId } from "@friend-poker/poker-engine";
import type {
  EntryPosition as SharedEntryPosition,
  IdentityResponse as SharedIdentityResponse,
  M11Command as BrowserCommand,
  ServerToClientEvents as SharedServerToClientEvents,
  TransportErrorResponse as SharedTransportErrorResponse,
} from "@friend-poker/shared";
export { TransportEvent } from "@friend-poker/shared";
import type { RuntimeCommandType } from "../runtime/types.js";
import type { CommandExecutionResult, RuntimeCommand } from "../runtime/types.js";

export type ClientRuntimeCommand = Exclude<
  RuntimeCommand,
  {
    readonly type:
      | typeof RuntimeCommandType.EnterTable
      | typeof RuntimeCommandType.SetOnline
      | typeof RuntimeCommandType.AdministrativeFold
      | typeof RuntimeCommandType.AdvanceRunout
      | typeof RuntimeCommandType.SetLifecycleHost
      | typeof RuntimeCommandType.AutoEndSession;
  }
>;

/**
 * The browser uses BrowserCommand. ClientRuntimeCommand remains available to
 * the in-process transport tests; the public web client never imports it.
 */
export type ClientCommand = ClientRuntimeCommand | BrowserCommand;

export interface ClientCommandInput {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly command: ClientCommand;
}

export type EntryPosition = SharedEntryPosition;
export type IdentityResponse = SharedIdentityResponse;
export type TransportErrorResponse = SharedTransportErrorResponse;

export type ServerToClientEvents = SharedServerToClientEvents;

export interface ClientToServerEvents {
  TABLE_COMMAND: (
    input: ClientCommandInput,
    acknowledge: (result: CommandExecutionResult) => void,
  ) => void;
}

export type InterServerEvents = Record<never, never>;

export interface SocketData {
  playerId?: PlayerId;
  onlineMutationApplied?: boolean;
  suppressOffline?: boolean;
}
