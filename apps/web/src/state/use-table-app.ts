import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandResult,
  IdentityResponse,
  M10Command,
  SafeTableProjection,
} from "@friend-poker/shared";
import {
  attemptIdentityRecovery,
  enterIdentity,
  type EntryPosition,
  type IdentityEntryInput,
  IdentityApiError,
  validateNicknameForEntry,
} from "../api/identity.js";
import { TableCommandClient } from "../api/commands.js";
import { connectToTable, type TableSocket } from "../api/socket.js";
import { acceptProjection, commandErrorMessage, identityErrorMessage } from "./projection.js";
import { TransportEvent } from "@friend-poker/shared";

export type AppPhase =
  | "BOOTING"
  | "ENTRY"
  | "CONNECTING"
  | "CONNECTED"
  | "RECONNECTING"
  | "DISCONNECTED"
  | "REVOKED"
  | "SESSION_ENDED"
  | "ERROR";

export interface TableAppOptions {
  readonly restoreIdentity?: () => Promise<IdentityResponse | null>;
  readonly enterIdentity?: (input: IdentityEntryInput) => Promise<IdentityResponse>;
  readonly createSocket?: () => TableSocket;
}

export interface TableAppState {
  readonly phase: AppPhase;
  readonly identity: IdentityResponse | null;
  readonly projection: SafeTableProjection | null;
  readonly nickname: string;
  readonly position: EntryPosition;
  readonly canReenterAfterKick: boolean;
  readonly pendingCommand: M10Command["type"] | null;
  readonly notice: string | null;
  readonly setNickname: (nickname: string) => void;
  readonly setPosition: (position: EntryPosition) => void;
  readonly submitEntry: () => Promise<void>;
  readonly submitCommand: (command: M10Command) => Promise<CommandResult | null>;
  readonly retry: () => void;
}

const SAVED_NICKNAME_KEY = "friend-poker:nickname";

function savedNickname(): string {
  try {
    return window.localStorage.getItem(SAVED_NICKNAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveNickname(nickname: string): void {
  try {
    window.localStorage.setItem(SAVED_NICKNAME_KEY, nickname);
  } catch {
    // A blocked storage API does not affect the HttpOnly credential flow.
  }
}

function socketErrorMessage(error: Error & { readonly data?: { readonly code?: string } }): string {
  const code = error.data?.code;
  if (code === "DUPLICATE_CONNECTION") return "这个身份已经在另一台设备上连接";
  if (code === "AUTH_REQUIRED") return "身份恢复凭证已失效，请重新输入昵称";
  if (code === "IDENTITY_NOT_PRESENT") return "身份已经不在当前牌桌，请重新进入";
  return "无法连接牌桌服务器，请稍后重试";
}

export function useTableApp(options: TableAppOptions = {}): TableAppState {
  const restore = options.restoreIdentity ?? attemptIdentityRecovery;
  const enter = options.enterIdentity ?? enterIdentity;
  const createSocket = options.createSocket ?? connectToTable;
  const [phase, setPhase] = useState<AppPhase>("BOOTING");
  const [identity, setIdentity] = useState<IdentityResponse | null>(null);
  const [projection, setProjection] = useState<SafeTableProjection | null>(null);
  const [nickname, setNickname] = useState(savedNickname);
  const [position, setPosition] = useState<EntryPosition>({ kind: "SPECTATOR" });
  const [canReenterAfterKick, setCanReenterAfterKick] = useState(false);
  const [pendingCommand, setPendingCommand] = useState<M10Command["type"] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const projectionRef = useRef<SafeTableProjection | null>(null);
  const socketRef = useRef<TableSocket | null>(null);
  const commandClientRef = useRef<TableCommandClient | null>(null);
  const explicitLeaveRef = useRef(false);
  const bootSequenceRef = useRef(0);
  const restoreRef = useRef(restore);
  const enterRef = useRef(enter);
  const createSocketRef = useRef(createSocket);
  restoreRef.current = restore;
  enterRef.current = enter;
  createSocketRef.current = createSocket;

  const acceptAuthoritativeProjection = useCallback((next: SafeTableProjection): void => {
    setProjection((previous) => {
      const accepted = acceptProjection(previous, next);
      projectionRef.current = accepted;
      return accepted;
    });
  }, []);

  const connectSocket = useCallback(
    (nextIdentity: IdentityResponse): void => {
      socketRef.current?.disconnect();
      explicitLeaveRef.current = false;
      const socket = createSocketRef.current();
      socketRef.current = socket;
      commandClientRef.current = new TableCommandClient(socket, {
        getProjection: () => projectionRef.current,
        acceptProjection: acceptAuthoritativeProjection,
      });
      setIdentity(nextIdentity);
      setPhase("CONNECTING");
      socket.on(TransportEvent.TableState, acceptAuthoritativeProjection);
      socket.on("connect", () => {
        setPhase("CONNECTED");
        setNotice(null);
      });
      socket.on("disconnect", () => {
        if (explicitLeaveRef.current) return;
        setPhase(socket.active ? "RECONNECTING" : "DISCONNECTED");
      });
      socket.on("connect_error", (error) => {
        const typedError = error as Error & { readonly data?: { readonly code?: string } };
        if (typedError.data?.code !== undefined) {
          setPhase("ERROR");
          setNotice(socketErrorMessage(typedError));
          return;
        }
        setPhase(socket.active ? "RECONNECTING" : "ERROR");
        setNotice(socketErrorMessage(typedError));
      });
      socket.on(TransportEvent.IdentityRevoked, (event) => {
        explicitLeaveRef.current = true;
        socket.disconnect();
        setProjection(null);
        setIdentity(null);
        setPhase(event.reason === "SESSION_ENDED" ? "SESSION_ENDED" : "REVOKED");
        setNotice(
          event.reason === "SESSION_ENDED"
            ? "本场已结束，请重新开始新的聚会"
            : "当前身份已被移出牌桌，请重新进入",
        );
      });
    },
    [acceptAuthoritativeProjection],
  );

  const boot = useCallback((): void => {
    const bootSequence = bootSequenceRef.current + 1;
    bootSequenceRef.current = bootSequence;
    setPhase("BOOTING");
    setNotice(null);
    void restoreRef.current()
      .then((recovered) => {
        if (bootSequenceRef.current !== bootSequence) return;
        if (recovered === null) {
          setPhase("ENTRY");
          return;
        }
        saveNickname(recovered.nickname);
        setNickname(recovered.nickname);
        connectSocket(recovered);
      })
      .catch((error: unknown) => {
        if (bootSequenceRef.current !== bootSequence) return;
        setPhase("ERROR");
        setNotice(
          error instanceof IdentityApiError
            ? identityErrorMessage(error.code, error.message)
            : "服务器暂时不可用，请稍后重试",
        );
      });
  }, [connectSocket]);

  useEffect(() => {
    boot();
    return () => {
      bootSequenceRef.current += 1;
      explicitLeaveRef.current = true;
      socketRef.current?.disconnect();
    };
  }, [boot]);

  const submitEntry = useCallback(async (): Promise<void> => {
    const validationMessage = validateNicknameForEntry(nickname);
    if (validationMessage !== null) {
      setNotice(validationMessage);
      setPhase("ENTRY");
      return;
    }
    setNotice(null);
    setPhase("CONNECTING");
    const input: IdentityEntryInput = {
      nickname,
      position,
      ...(canReenterAfterKick ? { reenterAfterKick: true } : {}),
    };
    try {
      const entered = await enterRef.current(input);
      saveNickname(entered.nickname);
      setNickname(entered.nickname);
      connectSocket(entered);
    } catch (error) {
      setPhase("ENTRY");
      if (error instanceof IdentityApiError && error.code === "NICKNAME_UNAVAILABLE") {
        setCanReenterAfterKick(true);
      }
      setNotice(
        error instanceof IdentityApiError
          ? identityErrorMessage(error.code, error.message)
          : "服务器暂时不可用，请稍后重试",
      );
    }
  }, [canReenterAfterKick, connectSocket, nickname, position]);

  const submitCommand = useCallback(async (command: M10Command): Promise<CommandResult | null> => {
    const commandClient = commandClientRef.current;
    if (commandClient === null) {
      setNotice("牌桌尚未连接");
      return null;
    }
    setPendingCommand(command.type);
    try {
      const result = await commandClient.submit(command);
      if (result.status === "REJECTED") {
        setNotice(commandErrorMessage(result.reason, result.message));
      } else if (result.status === "DUPLICATE") {
        setNotice("这次操作已经由服务器处理");
      } else {
        setNotice(null);
      }
      if (command.type === "LEAVE_TABLE" && result.status !== "REJECTED") {
        explicitLeaveRef.current = true;
        socketRef.current?.disconnect();
        setPhase("ENTRY");
        setNotice("你已离开牌桌；再次选择位置即可重新进入");
      }
      return result;
    } catch {
      setNotice("操作未能送达服务器，请检查连接");
      return null;
    } finally {
      setPendingCommand(null);
    }
  }, []);

  return {
    phase,
    identity,
    projection,
    nickname,
    position,
    pendingCommand,
    notice,
    setNickname: (nextNickname) => {
      setNickname(nextNickname);
      setCanReenterAfterKick(false);
    },
    setPosition,
    canReenterAfterKick,
    submitEntry,
    submitCommand,
    retry: boot,
  };
}
