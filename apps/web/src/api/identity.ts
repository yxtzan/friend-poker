import type {
  EntryAvailability,
  EntryPosition,
  IdentityResponse,
  TableSeat,
  TransportErrorResponse,
} from "@friend-poker/shared";

export type { EntryPosition };
export type { EntryAvailability };

export function isEntryPositionAvailable(
  availability: EntryAvailability,
  position: EntryPosition,
): boolean {
  if (position.kind === "SPECTATOR") {
    return availability.spectatorCount < availability.spectatorCapacity;
  }
  return availability.seats.find((candidate) => candidate.seat === position.seat)?.occupied === false;
}

export interface IdentityEntryInput {
  readonly nickname?: string;
  readonly position?: EntryPosition;
  readonly reenterAfterKick?: boolean;
}

export class IdentityApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(status: number, body: TransportErrorResponse | null) {
    super(body?.message ?? "服务器暂时无法处理进入请求");
    this.name = "IdentityApiError";
    this.code = body?.error ?? "HTTP_ERROR";
    this.status = status;
  }
}

export class EntryAvailabilityApiError extends Error {
  public readonly code: string;
  public readonly status: number;

  public constructor(status: number, body: TransportErrorResponse | null) {
    super(body?.message ?? "服务器暂时无法读取座位状态");
    this.name = "EntryAvailabilityApiError";
    this.code = body?.error ?? "HTTP_ERROR";
    this.status = status;
  }
}

function isIdentityResponse(value: unknown): value is IdentityResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<IdentityResponse>;
  return (
    (candidate.status === "CREATED" ||
      candidate.status === "RESTORED" ||
      candidate.status === "REENTERED") &&
    typeof candidate.playerId === "string" &&
    typeof candidate.nickname === "string"
  );
}

function isTransportErrorResponse(value: unknown): value is TransportErrorResponse {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<TransportErrorResponse>;
  return typeof candidate.error === "string" && typeof candidate.message === "string";
}

function isEntryAvailability(value: unknown): value is EntryAvailability {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EntryAvailability>;
  if (
    !Array.isArray(candidate.seats) ||
    candidate.seats.length !== 6 ||
    !Number.isInteger(candidate.spectatorCount) ||
    (candidate.spectatorCount as number) < 0 ||
    !Number.isInteger(candidate.spectatorCapacity) ||
    (candidate.spectatorCapacity as number) < 1
  ) {
    return false;
  }
  const seats = candidate.seats as readonly Partial<{ seat: TableSeat; occupied: boolean }>[];
  return seats.every(
    (seat) =>
      Number.isInteger(seat.seat) &&
      (seat.seat as number) >= 0 &&
      (seat.seat as number) <= 5 &&
      typeof seat.occupied === "boolean",
  );
}

export async function enterIdentity(input: IdentityEntryInput): Promise<IdentityResponse> {
  let response: Response;
  try {
    response = await fetch("/identity/enter", {
      method: "POST",
      credentials: "include",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch (error) {
    throw new IdentityApiError(
      0,
      Object.freeze({
        error: "SERVER_UNAVAILABLE",
        message: error instanceof Error ? "无法连接服务器" : "服务器暂时无法访问",
      }),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isIdentityResponse(body)) {
    throw new IdentityApiError(
      response.status,
      isTransportErrorResponse(body) ? body : null,
    );
  }
  return body;
}

export async function fetchEntryAvailability(): Promise<EntryAvailability> {
  let response: Response;
  try {
    response = await fetch("/identity/entry-status", {
      method: "GET",
      cache: "no-store",
      credentials: "same-origin",
    });
  } catch (error) {
    throw new EntryAvailabilityApiError(
      0,
      Object.freeze({
        error: "SERVER_UNAVAILABLE",
        message: error instanceof Error ? "无法连接服务器" : "服务器暂时无法访问",
      }),
    );
  }

  const body: unknown = await response.json().catch(() => null);
  if (!response.ok || !isEntryAvailability(body)) {
    throw new EntryAvailabilityApiError(
      response.status,
      isTransportErrorResponse(body) ? body : null,
    );
  }
  return body;
}

/** A missing/expired credential is a normal boot outcome, not a fatal error. */
export async function attemptIdentityRecovery(): Promise<IdentityResponse | null> {
  try {
    return await enterIdentity({});
  } catch (error) {
    if (
      error instanceof IdentityApiError &&
      (error.code === "NICKNAME_REQUIRED" || error.code === "POSITION_REQUIRED")
    ) {
      return null;
    }
    throw error;
  }
}

export function validateNicknameForEntry(value: string): string | null {
  const nickname = value.trim();
  if (nickname.length === 0) return "请输入昵称";
  if (Array.from(nickname).length > 12) return "昵称最多 12 个字符";
  if (!/^[\p{Script=Han}A-Za-z0-9]+$/u.test(nickname)) {
    return "昵称只能使用中文、英文和数字";
  }
  return null;
}
