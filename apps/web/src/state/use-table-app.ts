import { useCallback, useEffect, useRef, useState } from "react";
import type {
  CommandResult,
  IdentityResponse,
  M11Command,
  PublicTableHandRecord,
  ReactionEmoji,
  SafeTableProjection,
  TableReactionEvent,
} from "@friend-poker/shared";
import {
  attemptIdentityRecovery,
  enterIdentity,
  type EntryPosition,
  type IdentityEntryInput,
  IdentityApiError,
  validateNicknameForEntry,
} from "../api/identity.js";
import {
  CommandAcknowledgementTimeoutError,
  CommandReconciledByProjectionError,
  UncertainCommandError,
  UncertainCommandRetryLimitError,
  TableCommandClient,
} from "../api/commands.js";
import { connectToTable, type TableSocket } from "../api/socket.js";
import { acceptProjection, commandErrorMessage, identityErrorMessage } from "./projection.js";
import { TransportEvent } from "@friend-poker/shared";
import { ReactionRateLimiter } from "./reactions.js";
import { TableSoundPlayer } from "./sound.js";
import {
  detectNewlyCompletedHand,
  detectStreetReveal,
  handRecordKey,
  type StreetRevealPresentation,
} from "./presentations.js";

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
  readonly commandAckTimeoutMs?: number;
}

export interface TableAppState {
  readonly phase: AppPhase;
  readonly identity: IdentityResponse | null;
  readonly projection: SafeTableProjection | null;
  readonly nickname: string;
  readonly position: EntryPosition;
  readonly canReenterAfterKick: boolean;
  readonly pendingCommand: M11Command["type"] | null;
  readonly uncertainCommand: { readonly commandId: string; readonly type: M11Command["type"] } | null;
  readonly reactions: readonly TableReactionEvent[];
  readonly reactionEggVisible: boolean;
  readonly closeReactionEgg: () => void;
  readonly streetReveal: StreetRevealPresentation | null;
  readonly clearStreetReveal: () => void;
  readonly handResult: PublicTableHandRecord | null;
  readonly closeHandResult: () => void;
  readonly soundEnabled: boolean;
  readonly notice: string | null;
  readonly setNickname: (nickname: string) => void;
  readonly setPosition: (position: EntryPosition) => void;
  readonly submitEntry: () => Promise<void>;
  readonly submitCommand: (command: M11Command) => Promise<CommandResult | null>;
  readonly retryUncertainCommand: () => Promise<CommandResult | null>;
  readonly sendReaction: (emoji: ReactionEmoji) => void;
  readonly setSoundEnabled: (enabled: boolean) => void;
  readonly retry: () => void;
}

const SAVED_NICKNAME_KEY = "friend-poker:nickname";
const SOUND_ENABLED_KEY = "friend-poker:sound-enabled";

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

function savedSoundEnabled(): boolean {
  try {
    return window.localStorage.getItem(SOUND_ENABLED_KEY) === "true";
  } catch {
    return false;
  }
}

function saveSoundEnabled(enabled: boolean): void {
  try {
    window.localStorage.setItem(SOUND_ENABLED_KEY, String(enabled));
  } catch {
    // A blocked storage API leaves sound opt-in for this session only.
  }
}

function socketErrorMessage(error: Error & { readonly data?: { readonly code?: string } }): string {
  const code = error.data?.code;
  if (code === "DUPLICATE_CONNECTION") return "这个身份已经在另一台设备上连接";
  if (code === "AUTH_REQUIRED") return "身份恢复凭证已失效，请重新输入昵称";
  if (code === "IDENTITY_NOT_PRESENT") return "身份已经不在当前牌桌，请重新进入";
  return "无法连接牌桌服务器，请稍后重试";
}

function uncertainCommandState(
  client: TableCommandClient | null,
): TableAppState["uncertainCommand"] {
  const unresolved = client?.uncertainCommand;
  return unresolved === null || unresolved === undefined
    ? null
    : { commandId: unresolved.commandId, type: unresolved.command.type };
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
  const [pendingCommand, setPendingCommand] = useState<M11Command["type"] | null>(null);
  const [uncertainCommand, setUncertainCommand] = useState<TableAppState["uncertainCommand"]>(null);
  const [reactions, setReactions] = useState<readonly TableReactionEvent[]>([]);
  const [reactionEggVisible, setReactionEggVisible] = useState(false);
  const [streetReveal, setStreetReveal] = useState<StreetRevealPresentation | null>(null);
  const [handResult, setHandResult] = useState<PublicTableHandRecord | null>(null);
  const [soundEnabled, setSoundEnabledState] = useState(savedSoundEnabled);
  const [notice, setNotice] = useState<string | null>(null);
  const projectionRef = useRef<SafeTableProjection | null>(null);
  const socketRef = useRef<TableSocket | null>(null);
  const commandClientRef = useRef<TableCommandClient | null>(null);
  const explicitLeaveRef = useRef(false);
  const bootSequenceRef = useRef(0);
  const restoreRef = useRef(restore);
  const enterRef = useRef(enter);
  const createSocketRef = useRef(createSocket);
  const commandAckTimeoutRef = useRef(options.commandAckTimeoutMs);
  const identityRef = useRef<IdentityResponse | null>(null);
  const projectionForSoundRef = useRef<SafeTableProjection | null>(null);
  const handResultRef = useRef<PublicTableHandRecord | null>(null);
  const dismissedHandResultKeyRef = useRef<string | null>(null);
  const skipNextPresentationProjectionRef = useRef(true);
  const soundEnabledRef = useRef(soundEnabled);
  const reactionLimiterRef = useRef(new ReactionRateLimiter());
  const reactionTimersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const soundPlayerRef = useRef(new TableSoundPlayer());
  const persistedSoundUnlockPendingRef = useRef(savedSoundEnabled());
  restoreRef.current = restore;
  enterRef.current = enter;
  createSocketRef.current = createSocket;
  commandAckTimeoutRef.current = options.commandAckTimeoutMs;
  soundEnabledRef.current = soundEnabled;

  useEffect(() => {
    if (!soundEnabled || !persistedSoundUnlockPendingRef.current || typeof window === "undefined") return;

    const unlockAfterActivation = (): void => {
      if (!persistedSoundUnlockPendingRef.current) return;
      persistedSoundUnlockPendingRef.current = false;
      soundPlayerRef.current.unlock();
      window.removeEventListener("pointerdown", unlockAfterActivation);
      window.removeEventListener("keydown", unlockAfterActivation);
    };

    window.addEventListener("pointerdown", unlockAfterActivation);
    window.addEventListener("keydown", unlockAfterActivation);
    return () => {
      window.removeEventListener("pointerdown", unlockAfterActivation);
      window.removeEventListener("keydown", unlockAfterActivation);
    };
  }, [soundEnabled]);

  const acceptAuthoritativeProjection = useCallback((next: SafeTableProjection): void => {
    commandClientRef.current?.observeProjection(next);
    setUncertainCommand(uncertainCommandState(commandClientRef.current));
    const previous = projectionRef.current;
    const accepted = acceptProjection(previous, next);
    if (accepted === previous) return;

    projectionRef.current = accepted;
    const skipPresentation = skipNextPresentationProjectionRef.current;
    skipNextPresentationProjectionRef.current = false;
    const newHandStarted =
      accepted.currentHand !== null && previous?.currentHand?.handId !== accepted.currentHand.handId;

    if (newHandStarted) {
      handResultRef.current = null;
      dismissedHandResultKeyRef.current = null;
      setHandResult(null);
      setStreetReveal(null);
    } else {
      const openHandResult = handResultRef.current;
      if (openHandResult !== null) {
        const openHandKey = handRecordKey(openHandResult);
        const refreshedHandResult = accepted.recentHands.find(
          (candidate) => handRecordKey(candidate) === openHandKey,
        );
        if (
          refreshedHandResult !== undefined &&
          dismissedHandResultKeyRef.current !== openHandKey
        ) {
          handResultRef.current = refreshedHandResult;
          setHandResult(refreshedHandResult);
        }
      }

      if (!skipPresentation && previous !== null) {
        const reveal = detectStreetReveal(previous, accepted);
        if (reveal !== null) setStreetReveal(reveal);

        const completedHand = detectNewlyCompletedHand(previous, accepted);
        if (
          completedHand !== null &&
          handRecordKey(completedHand) !== dismissedHandResultKeyRef.current
        ) {
          handResultRef.current = completedHand;
          setHandResult(completedHand);
        }
      }
    }

    setProjection(accepted);
  }, []);

  useEffect(() => {
    const previous = projectionForSoundRef.current;
    const viewerId = identityRef.current?.playerId;
    if (previous !== null && viewerId !== undefined && soundEnabledRef.current) {
      const previousHand = previous.currentHand;
      const nextHand = projection?.currentHand;
      if (
        nextHand?.currentActorId === viewerId &&
        previousHand?.currentActorId !== viewerId
      ) {
        soundPlayerRef.current.play("TURN");
      } else if (
        previousHand?.street !== nextHand?.street &&
        nextHand !== null &&
        nextHand !== undefined
      ) {
        soundPlayerRef.current.play("STREET");
      } else if (
        previousHand?.status !== "COMPLETE" &&
        nextHand?.status === "COMPLETE"
      ) {
        soundPlayerRef.current.play("COMPLETE");
      }
    }
    projectionForSoundRef.current = projection;
  }, [projection]);

  const connectSocket = useCallback(
    (nextIdentity: IdentityResponse): void => {
      socketRef.current?.disconnect();
      explicitLeaveRef.current = false;
      const socket = createSocketRef.current();
      socketRef.current = socket;
      identityRef.current = nextIdentity;
      projectionForSoundRef.current = null;
      skipNextPresentationProjectionRef.current = true;
      commandClientRef.current = new TableCommandClient(socket, {
        getProjection: () => projectionRef.current,
        acceptProjection: acceptAuthoritativeProjection,
        ...(commandAckTimeoutRef.current === undefined
          ? {}
          : { ackTimeoutMs: commandAckTimeoutRef.current }),
      });
      setUncertainCommand(null);
      setReactions([]);
      setReactionEggVisible(false);
      setIdentity(nextIdentity);
      setPhase("CONNECTING");
      socket.on(TransportEvent.TableState, acceptAuthoritativeProjection);
      socket.on(TransportEvent.TableReaction, (reaction) => {
        setReactions((previous) => [...previous, reaction].slice(-12));
        if (soundEnabledRef.current) soundPlayerRef.current.playReaction(reaction.emoji);
        const timer = setTimeout(() => {
          setReactions((previous) => previous.filter((candidate) => candidate.reactionId !== reaction.reactionId));
          reactionTimersRef.current.delete(reaction.reactionId);
        }, 2_400);
        reactionTimersRef.current.set(reaction.reactionId, timer);
      });
      socket.on("connect", () => {
        skipNextPresentationProjectionRef.current = true;
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
        identityRef.current = null;
        handResultRef.current = null;
        dismissedHandResultKeyRef.current = null;
        setProjection(null);
        setIdentity(null);
        setUncertainCommand(null);
        setReactions([]);
        setStreetReveal(null);
        setHandResult(null);
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

  const sendReaction = useCallback((emoji: ReactionEmoji): void => {
    const decision = reactionLimiterRef.current.attempt();
    if (!decision.accepted) {
      if (decision.showEgg) {
        setReactionEggVisible(true);
      }
      return;
    }
    socketRef.current?.emit(TransportEvent.TableReaction, { emoji });
  }, []);

  const setSoundEnabled = useCallback((enabled: boolean): void => {
    setSoundEnabledState(enabled);
    soundEnabledRef.current = enabled;
    saveSoundEnabled(enabled);
    persistedSoundUnlockPendingRef.current = false;
    if (enabled) soundPlayerRef.current.unlock();
  }, []);

  const closeReactionEgg = useCallback((): void => {
    setReactionEggVisible(false);
  }, []);

  const clearStreetReveal = useCallback((): void => {
    setStreetReveal(null);
  }, []);

  const closeHandResult = useCallback((): void => {
    const current = handResultRef.current;
    if (current !== null) dismissedHandResultKeyRef.current = handRecordKey(current);
    handResultRef.current = null;
    setHandResult(null);
  }, []);

  useEffect(() => () => {
    for (const timer of reactionTimersRef.current.values()) clearTimeout(timer);
    reactionTimersRef.current.clear();
    soundPlayerRef.current.dispose();
  }, []);

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

  const submitCommand = useCallback(async (command: M11Command): Promise<CommandResult | null> => {
    const commandClient = commandClientRef.current;
    if (commandClient === null) {
      setNotice("牌桌尚未连接");
      return null;
    }
    setPendingCommand(command.type);
    try {
      const result = await commandClient.submit(command);
      setUncertainCommand(null);
      if (result.status === "REJECTED") {
        setNotice(commandErrorMessage(result.reason, result.message));
      } else if (result.status === "DUPLICATE") {
        setNotice("这次操作已经由服务器处理");
      } else {
        setNotice(null);
      }
      if (result.status !== "REJECTED" && soundEnabledRef.current) {
        soundPlayerRef.current.play("ACK");
      }
      if (command.type === "LEAVE_TABLE" && result.status !== "REJECTED") {
        explicitLeaveRef.current = true;
        socketRef.current?.disconnect();
        setPhase("ENTRY");
        setNotice("你已离开牌桌；再次选择位置即可重新进入");
      }
      return result;
    } catch (error) {
      if (error instanceof CommandAcknowledgementTimeoutError) {
        setUncertainCommand(uncertainCommandState(commandClient));
        setNotice("操作确认超时，服务器可能已经处理；请以最新牌桌状态为准");
      } else if (error instanceof CommandReconciledByProjectionError) {
        setUncertainCommand(null);
        setNotice("牌桌状态已更新，上一条操作已结束");
      } else if (error instanceof UncertainCommandError) {
        setNotice("上一条操作尚未确认，请先重新确认");
      } else {
        setNotice("操作未能送达服务器，请检查连接");
      }
      return null;
    } finally {
      setPendingCommand(null);
    }
  }, []);

  const retryUncertainCommand = useCallback(async (): Promise<CommandResult | null> => {
    const commandClient = commandClientRef.current;
    if (commandClient === null) {
      setNotice("牌桌尚未连接");
      return null;
    }
    setPendingCommand(uncertainCommand?.type ?? null);
    try {
      const result = await commandClient.retryUncertain();
      setUncertainCommand(uncertainCommandState(commandClient));
      if (result.status === "REJECTED") {
        setNotice(commandErrorMessage(result.reason, result.message));
      } else if (result.status === "DUPLICATE") {
        setNotice("服务器已处理原操作，已恢复同步");
      } else {
        setNotice(null);
      }
      return result;
    } catch (error) {
      if (error instanceof UncertainCommandRetryLimitError) {
        setNotice(error.message);
      } else if (error instanceof CommandReconciledByProjectionError) {
        setUncertainCommand(null);
        setNotice("牌桌状态已更新，上一条操作已结束");
      } else {
        setNotice("重新确认未完成，请等待新的牌桌状态");
      }
      return null;
    } finally {
      setUncertainCommand(uncertainCommandState(commandClient));
      setPendingCommand(null);
    }
  }, [uncertainCommand]);

  return {
    phase,
    identity,
    projection,
    nickname,
    position,
    pendingCommand,
    uncertainCommand,
    reactions,
    reactionEggVisible,
    closeReactionEgg,
    streetReveal,
    clearStreetReveal,
    handResult,
    closeHandResult,
    soundEnabled,
    notice,
    setNickname: (nextNickname) => {
      setNickname(nextNickname);
      setCanReenterAfterKick(false);
    },
    setPosition,
    canReenterAfterKick,
    submitEntry,
    submitCommand,
    retryUncertainCommand,
    sendReaction,
    setSoundEnabled,
    retry: boot,
  };
}
