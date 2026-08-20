import type {
  EntryPosition,
  IdentityResponse,
  TransportErrorResponse,
} from "@friend-poker/shared";

export type { EntryPosition };

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
