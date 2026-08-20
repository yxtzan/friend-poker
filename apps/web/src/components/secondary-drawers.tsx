import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import type {
  Card,
  PublicHandEvent,
  PublicSessionSummary,
  PublicTableHandRecord,
  SafeTableProjection,
} from "@friend-poker/shared";
import { PlayingCard } from "./card.js";

interface SideDrawerProps {
  readonly open: boolean;
  readonly title: string;
  readonly labelledBy: string;
  readonly onClose: () => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly children: ReactNode;
  readonly className?: string;
}

function SideDrawer({
  open,
  title,
  labelledBy,
  onClose,
  triggerRef,
  children,
  className = "",
}: SideDrawerProps) {
  const drawerRef = useRef<HTMLElement>(null);
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      drawerRef.current?.focus();
      return undefined;
    }
    if (wasOpenRef.current) {
      wasOpenRef.current = false;
      triggerRef.current?.focus();
    }
    return undefined;
  }, [open, triggerRef]);

  useEffect(() => {
    if (!open) return undefined;
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [onClose, open]);

  if (!open) return null;
  return (
    <aside
      ref={drawerRef}
      className={`secondary-drawer ${className}`}
      role="dialog"
      aria-modal="false"
      aria-labelledby={labelledBy}
      tabIndex={-1}
    >
      <div className="drawer-heading">
        <h2 id={labelledBy}>{title}</h2>
        <button type="button" className="drawer-close" aria-label={`关闭${title}`} onClick={onClose}>
          关闭
        </button>
      </div>
      {children}
    </aside>
  );
}

interface RankingEntry {
  readonly name: string;
  readonly english: string;
  readonly description: string;
  readonly cards: readonly Card[];
}

const RANKING_ENTRIES: readonly RankingEntry[] = [
  { name: "皇家同花顺", english: "Royal Flush", description: "A K Q J 10，同一花色", cards: [{ rank: 14, suit: "h" }, { rank: 13, suit: "h" }, { rank: 12, suit: "h" }, { rank: 11, suit: "h" }, { rank: 10, suit: "h" }] },
  { name: "同花顺", english: "Straight Flush", description: "五张连续点数，同一花色", cards: [{ rank: 9, suit: "s" }, { rank: 8, suit: "s" }, { rank: 7, suit: "s" }, { rank: 6, suit: "s" }, { rank: 5, suit: "s" }] },
  { name: "四条", english: "Four of a Kind", description: "四张相同点数的牌", cards: [{ rank: 9, suit: "c" }, { rank: 9, suit: "d" }, { rank: 9, suit: "h" }, { rank: 9, suit: "s" }, { rank: 2, suit: "c" }] },
  { name: "葫芦", english: "Full House", description: "三条加一对", cards: [{ rank: 13, suit: "c" }, { rank: 13, suit: "d" }, { rank: 13, suit: "h" }, { rank: 4, suit: "c" }, { rank: 4, suit: "d" }] },
  { name: "同花", english: "Flush", description: "五张同一花色的牌", cards: [{ rank: 14, suit: "d" }, { rank: 10, suit: "d" }, { rank: 8, suit: "d" }, { rank: 5, suit: "d" }, { rank: 2, suit: "d" }] },
  { name: "顺子", english: "Straight", description: "五张连续点数的牌", cards: [{ rank: 10, suit: "c" }, { rank: 9, suit: "d" }, { rank: 8, suit: "h" }, { rank: 7, suit: "s" }, { rank: 6, suit: "c" }] },
  { name: "三条", english: "Three of a Kind", description: "三张相同点数的牌", cards: [{ rank: 7, suit: "c" }, { rank: 7, suit: "d" }, { rank: 7, suit: "h" }, { rank: 13, suit: "s" }, { rank: 2, suit: "c" }] },
  { name: "两对", english: "Two Pair", description: "两组对子", cards: [{ rank: 12, suit: "c" }, { rank: 12, suit: "d" }, { rank: 5, suit: "h" }, { rank: 5, suit: "s" }, { rank: 14, suit: "c" }] },
  { name: "一对", english: "One Pair", description: "一组对子", cards: [{ rank: 10, suit: "c" }, { rank: 10, suit: "d" }, { rank: 14, suit: "h" }, { rank: 8, suit: "s" }, { rank: 3, suit: "c" }] },
  { name: "高牌", english: "High Card", description: "不成其他牌型时比较点数", cards: [{ rank: 14, suit: "c" }, { rank: 11, suit: "d" }, { rank: 8, suit: "h" }, { rank: 5, suit: "s" }, { rank: 2, suit: "c" }] },
];

export function HandRankingDrawer({
  open,
  onClose,
  triggerRef,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
}) {
  return (
    <SideDrawer
      open={open}
      title="牌型表"
      labelledBy="hand-ranking-title"
      onClose={onClose}
      triggerRef={triggerRef}
      className="ranking-drawer"
    >
      <p className="drawer-intro">从强到弱的快速参考。示例只是帮助记忆，不会读取你的牌。</p>
      <ol className="ranking-list">
        {RANKING_ENTRIES.map((entry, index) => (
          <li className="ranking-entry" key={entry.name}>
            <span className="ranking-number">{index + 1}</span>
            <div className="ranking-copy"><strong>{entry.name}</strong><span>{entry.english}</span><small>{entry.description}</small></div>
            <div className="ranking-cards" aria-label={`${entry.name}示例`}>
              {entry.cards.map((card, cardIndex) => <PlayingCard card={card} compact key={`${entry.name}-${cardIndex}`} />)}
            </div>
          </li>
        ))}
      </ol>
      <section className="beginner-notes" aria-labelledby="beginner-notes-title">
        <h3 id="beginner-notes-title">新手记忆</h3>
        <ul>
          <li>德州扑克最终从 7 张可用牌中选择最强的 5 张组合。</li>
          <li>同一种牌型先比主要点数，仍相同时再依次比较 Kicker。</li>
          <li>花色没有大小；A 可作最高牌，也可用于 A-2-3-4-5。</li>
          <li>A-2-3-4-5 按 5-high 顺子处理。</li>
        </ul>
      </section>
    </SideDrawer>
  );
}

function playerName(
  projection: SafeTableProjection,
  playerId: string,
  nickname?: string | null,
): string {
  if (nickname !== undefined && nickname !== null && nickname.length > 0) return nickname;
  const player = [...projection.seats, ...projection.spectators].find(
    (candidate) => candidate?.playerId === playerId,
  );
  return player?.nickname ?? "玩家";
}

function cardRow(cards: readonly Card[], label: string) {
  return (
    <div className="history-card-row" aria-label={label}>
      {cards.length === 0 ? <span className="muted-copy">无</span> : cards.map((card, index) => <PlayingCard card={card} compact key={`${label}-${index}`} />)}
    </div>
  );
}

function eventDescription(
  event: PublicHandEvent,
  projection: SafeTableProjection,
): string {
  if (event.type === "ACTION") {
    const action = event.requestedType === "ALL_IN" ? "全下" : event.requestedType;
    return `${playerName(projection, event.playerId)} · ${action} · 投入 ${event.amountCommitted}`;
  }
  if (event.type === "ADMINISTRATIVE_FOLD") return `${playerName(projection, event.targetPlayerId)} · 管理弃牌`;
  if (event.type === "BOARD_REVEALED") return `${event.street} · 公共牌推进`;
  if (event.type === "HOLE_CARDS_REVEALED") return `亮牌 · ${event.hands.map((hand) => playerName(projection, hand.playerId)).join("、")}`;
  if (event.type === "HAND_SETTLED") return `本手结算 · ${event.reason === "SHOWDOWN" ? "摊牌" : "无人跟注"}`;
  const exhaustive: never = event;
  return exhaustive;
}

function HandHistoryList({
  hands,
  projection,
}: {
  readonly hands: readonly PublicTableHandRecord[];
  readonly projection: SafeTableProjection;
}) {
  if (hands.length === 0) return <p className="drawer-empty">还没有完成的手牌记录。</p>;
  return (
    <ol className="history-list">
      {[...hands].reverse().map((hand) => {
        const record = hand.record;
        const settlement = record.settlement;
        const winnerIds = [...new Set(settlement?.pots.flatMap((pot) => pot.winnerPlayerIds) ?? [])];
        return (
          <li key={`${hand.sessionId}-${hand.handNumber}`} className="history-item">
            <details>
              <summary><strong>第 {hand.handNumber} 手</strong><span>{record.completionReason === "SHOWDOWN" ? "摊牌" : "无人跟注"}</span><b>底池 {settlement?.totalPotAmount ?? 0}</b></summary>
              <div className="history-detail">
                <div className="history-line"><span>牌局</span><strong>{record.handId}</strong></div>
                <div className="history-line"><span>公共牌</span>{cardRow(record.board, "本手公共牌")}</div>
                <div className="history-line"><span>赢家</span><strong>{winnerIds.length === 0 ? "—" : winnerIds.map((id) => playerName(projection, id)).join("、")}</strong></div>
                <div className="history-line"><span>结算</span><strong>{settlement === null ? "未结算" : `总派彩 ${settlement.totalPotPayout} · 退款 ${settlement.totalRefund}`}</strong></div>
                <div className="history-actions"><span>行动顺序</span><ol>{record.events.map((event) => <li key={`${record.handId}-${event.sequence}`}>{eventDescription(event, projection)}</li>)}</ol></div>
                {record.revealedHoleCards.length > 0 && <div className="history-reveals"><span>已公开底牌</span>{record.revealedHoleCards.map((handReveal) => <div key={handReveal.playerId}><strong>{playerName(projection, handReveal.playerId)}</strong>{cardRow(handReveal.cards, "已公开底牌")}</div>)}</div>}
              </div>
            </details>
          </li>
        );
      })}
    </ol>
  );
}

function SessionHistoryList({
  sessions,
  projection,
}: {
  readonly sessions: readonly PublicSessionSummary[];
  readonly projection: SafeTableProjection;
}) {
  if (sessions.length === 0) return <p className="drawer-empty">还没有结束的 Session 记录。</p>;
  return (
    <ol className="history-list session-history-list">
      {[...sessions].reverse().map((session) => (
        <li key={session.sessionId} className="history-item session-history-item">
          <div className="session-history-heading"><strong>{session.sessionId}</strong><span>{session.handCount} 手</span></div>
          <div className="session-player-list">
            {session.players.map((player) => {
              const inflow = player.initialGrants + player.replenishments + player.hostAdjustments;
              return <div className="session-player-row" key={player.playerId}><span>{playerName(projection, player.playerId, player.nickname)}</span><span>流入 {inflow}</span><strong>{player.finalChipBalance} · {player.netResult >= 0 ? "+" : ""}{player.netResult}</strong></div>;
            })}
          </div>
        </li>
      ))}
    </ol>
  );
}

export function HistoryDrawer({
  open,
  onClose,
  triggerRef,
  initialTab,
  projection,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly triggerRef: RefObject<HTMLButtonElement | null>;
  readonly initialTab: "HANDS" | "SESSIONS";
  readonly projection: SafeTableProjection;
}) {
  const [tab, setTab] = useState(initialTab);

  useEffect(() => {
    if (open) setTab(initialTab);
  }, [initialTab, open]);

  return (
    <SideDrawer
      open={open}
      title="牌局记录"
      labelledBy="history-drawer-title"
      onClose={onClose}
      triggerRef={triggerRef}
      className="history-drawer"
    >
      <div className="drawer-tabs" role="tablist" aria-label="记录类型">
        <button type="button" role="tab" aria-selected={tab === "HANDS"} className={tab === "HANDS" ? "is-selected" : ""} onClick={() => setTab("HANDS")}>最近手牌 {projection.recentHands.length}</button>
        <button type="button" role="tab" aria-selected={tab === "SESSIONS"} className={tab === "SESSIONS" ? "is-selected" : ""} onClick={() => setTab("SESSIONS")}>最近本场 {projection.recentSessions.length}</button>
      </div>
      {tab === "HANDS" ? <HandHistoryList hands={projection.recentHands} projection={projection} /> : <SessionHistoryList sessions={projection.recentSessions} projection={projection} />}
    </SideDrawer>
  );
}
