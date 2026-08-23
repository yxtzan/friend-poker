import type { PlayerId } from "@friend-poker/poker-engine";
import type {
  EntryAvailability as SharedEntryAvailability,
  EntryPosition as SharedEntryPosition,
  IdentityResponse as SharedIdentityResponse,
  M11ClientCommandInput as SharedM11ClientCommandInput,
  M12ClientToServerEvents as SharedM12ClientToServerEvents,
  ServerToClientEvents as SharedServerToClientEvents,
  TransportErrorResponse as SharedTransportErrorResponse,
} from "@friend-poker/shared";
export { TransportEvent } from "@friend-poker/shared";

/** The only command envelope exposed by the browser-facing Socket.IO contract. */
export type ClientCommandInput = SharedM11ClientCommandInput;

export type EntryPosition = SharedEntryPosition;
export type EntryAvailability = SharedEntryAvailability;
export type IdentityResponse = SharedIdentityResponse;
export type TransportErrorResponse = SharedTransportErrorResponse;

export type ServerToClientEvents = SharedServerToClientEvents;

export type ClientToServerEvents = SharedM12ClientToServerEvents;

export type InterServerEvents = Record<never, never>;

export interface SocketData {
  playerId?: PlayerId;
  onlineMutationApplied?: boolean;
  suppressOffline?: boolean;
}
