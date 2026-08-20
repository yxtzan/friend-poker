import { io, type Socket } from "socket.io-client";
import type {
  M10ClientToServerEvents,
  ServerToClientEvents,
} from "@friend-poker/shared";

export type TableSocket = Socket<ServerToClientEvents, M10ClientToServerEvents>;

export function connectToTable(): TableSocket {
  return io("/", {
    withCredentials: true,
  });
}
