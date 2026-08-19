import type { PlayerId, TableSeat } from "@friend-poker/poker-engine";
import type {
  CommandExecutionResult,
  RuntimeCommand,
  SafeTableProjection,
} from "../runtime/types.js";

export const TransportEvent = Object.freeze({
  TableCommand: "TABLE_COMMAND",
  TableState: "TABLE_STATE",
  IdentityRevoked: "IDENTITY_REVOKED",
} as const);

export interface ClientCommandInput {
  readonly commandId: string;
  readonly expectedVersion: number;
  readonly command: RuntimeCommand;
}

export type EntryPosition =
  | { readonly kind: "SPECTATOR" }
  | { readonly kind: "SEAT"; readonly seat: TableSeat };

export interface IdentityResponse {
  readonly status: "CREATED" | "RESTORED" | "REENTERED";
  readonly playerId: PlayerId;
  readonly nickname: string;
}

export interface TransportErrorResponse {
  readonly error: string;
  readonly message: string;
}

export interface ServerToClientEvents {
  TABLE_STATE: (projection: SafeTableProjection) => void;
  IDENTITY_REVOKED: (event: { readonly reason: "KICKED" }) => void;
}

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
