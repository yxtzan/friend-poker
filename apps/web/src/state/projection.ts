import type { SafeTableProjection } from "@friend-poker/shared";

/** Authoritative projections replace local state; older packets are ignored. */
export function acceptProjection(
  previous: SafeTableProjection | null,
  next: SafeTableProjection,
): SafeTableProjection {
  return previous === null || next.version >= previous.version ? next : previous;
}

export function commandErrorMessage(reason: string, message: string): string {
  if (reason === "STALE_VERSION") return "牌桌状态已更新，请按最新状态继续操作";
  if (reason === "DOMAIN_RULE_REJECTION") return message || "当前状态不允许此操作";
  if (reason === "UNAUTHORIZED_IDENTITY") return "当前身份无权执行此操作";
  return message || "操作未被服务器接受";
}

export function identityErrorMessage(code: string, message: string): string {
  const known: Record<string, string> = {
    NICKNAME_UNAVAILABLE: "这个昵称已经在本场使用",
    ENTRY_REJECTED: "所选位置当前不可用，请换一个位置",
    POSITION_REQUIRED: "请选择座位或旁观",
    SERVER_UNAVAILABLE: "服务器暂时不可用，请稍后重试",
    DUPLICATE_CONNECTION: "这个身份已经在另一台设备上连接",
    AUTH_REQUIRED: "身份恢复凭证无效，请重新输入昵称",
    IDENTITY_NOT_PRESENT: "身份已经不在当前牌桌，请重新进入",
  };
  return known[code] ?? (message || "进入牌桌失败，请稍后重试");
}
