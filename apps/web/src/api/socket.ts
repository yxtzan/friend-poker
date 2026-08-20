import { io, type Socket } from "socket.io-client";
import type {
  M11ClientToServerEvents,
  ServerToClientEvents,
} from "@friend-poker/shared";

export type TableSocket = Socket<ServerToClientEvents, M11ClientToServerEvents>;

export function connectToTable(): TableSocket {
  return io("/", {
    withCredentials: true,
  });
}
