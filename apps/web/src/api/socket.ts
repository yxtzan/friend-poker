import { io, type Socket } from "socket.io-client";
import type {
  M12ClientToServerEvents,
  ServerToClientEvents,
} from "@friend-poker/shared";

export type TableSocket = Socket<ServerToClientEvents, M12ClientToServerEvents>;

export function connectToTable(): TableSocket {
  return io("/", {
    withCredentials: true,
  });
}
