import type { PlayerId } from "@friend-poker/poker-engine";
import type {
  EntryPosition as SharedEntryPosition,
  IdentityResponse as SharedIdentityResponse,
  M11ClientCommandInput as SharedM11ClientCommandInput,
  ServerToClientEvents as SharedServerToClientEvents,
  TransportErrorResponse as SharedTransportErrorResponse,
} from "@friend-poker/shared";
export { TransportEvent } from "@friend-poker/shared";
import type { CommandExecutionResult } from "../runtime/types.js";

/** The only command envelope exposed by the browser-facing Socket.IO contract. */
export type ClientCommandInput = SharedM11ClientCommandInput;

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
