import { useEffect, useMemo, useState } from "react";
import {
  HandLifecycleStatus,
  M11CommandType,
  Street,
  TableLifecycleStatus,
  type CommandResult,
  type M11Command,
  type PublicSessionEndPreview,
  type SafeTableProjection,
  type TableSeat,
} from "@friend-poker/shared";
import { PlayingCard } from "./card.js";
import { Seat } from "./seat.js";
import type { AppPhase, TableAppState } from "../state/use-table-app.js";
import {
  calculatePotQuickTarget,
  type PotQuickSize,
} from "../state/bet-sizing.js";

interface TableShellProps {
  readonly projection: SafeTableProjection;
  readonly viewerId: string;
  readonly phase: AppPhase;
  readonly pendingCommand: M11Command["type"] | null;
  readonly uncertainCommand?: TableAppState["uncertainCommand"];
  readonly notice: string | null;
  readonly onCommand: (command: M11Command) => Promise<CommandResult | null> | undefined;
  readonly onRetryUncertain?: () => void;
}

const SEATS: readonly TableSeat[] = [0, 1, 2, 3, 4, 5];

function tableStatusLabel(status: SafeTableProjection["status"]): string {
  const labels: Record<SafeTableProjection["status"], string> = {
    [TableLifecycleStatus.NoSession]: "等待本场开始",
    [TableLifecycleStatus.WaitingForFirstHand]: "等待第一手牌",
    [TableLifecycleStatus.HandInProgress]: "牌局进行中",
    [TableLifecycleStatus.BetweenHands]: "两手之间",
    [TableLifecycleStatus.SessionEnded]: "本场已结束",
  };
  return labels[status] ?? status;
}

function streetLabel(street: string): string {
  const labels: Record<string, string> = {
    [Street.Preflop]: "翻牌前",
    [Street.Flop]: "翻牌",
    [Street.Turn]: "转牌",
    [Street.River]: "河牌",
  };
  return labels[street] ?? street;
}

function handStatusLabel(status: string): string {
  if (status === HandLifecycleStatus.Betting) return "下注中";
  if (status === HandLifecycleStatus.RunoutRequired) return "自动发牌中";
  if (status === HandLifecycleStatus.Complete) return "本手结束";
  return status;
}

function phaseLabel(phase: AppPhase): string {
  if (phase === "CONNECTED") return "已连接";
  if (phase === "RECONNECTING") return "正在重连";
  if (phase === "DISCONNECTED") return "已断开";
  return phase;
}

function displayNameForId(projection: SafeTableProjection, playerId: string): string {
  const player = projection.seats
    .concat(projection.spectators)
    .find((candidate) => candidate?.playerId === playerId);
  return player?.nickname ?? "玩家";
}

function allPublicPlayers(projection: SafeTableProjection) {
  return [
    ...projection.seats.filter((player) => player !== null),
    ...projection.spectators,
  ];
}

function canConfirm(message: string): boolean {
  return typeof window === "undefined" || typeof window.confirm !== "function"
    ? true
    : window.confirm(message);
}

function readSessionPreview(result: CommandResult | null): PublicSessionEndPreview | null {
  if (result === null || result.status === "REJECTED") return null;
  if (result.data.kind !== "SESSION_END_PREVIEW") return null;
  const candidate = result.data.preview;
  if (
    typeof candidate !== "object" ||
    candidate === null ||
    typeof (candidate as Record<string, unknown>).sessionId !== "string" ||
    !Number.isInteger((candidate as Record<string, unknown>).completedHandCount) ||
    !Array.isArray((candidate as Record<string, unknown>).participantPlayerIds) ||
    typeof (candidate as Record<string, unknown>).finalChipBalances !== "object" ||
    (candidate as Record<string, unknown>).finalChipBalances === null
  ) {
    return null;
  }
  return candidate as PublicSessionEndPreview;
}

export function TableShell({
  projection,
  viewerId,
  phase,
  pendingCommand,
  uncertainCommand,
  notice,
  onCommand,
  onRetryUncertain = () => undefined,
}: TableShellProps) {
  const hand = projection.currentHand;
  const viewerSeat = projection.seats.find((player) => player?.playerId === viewerId)?.seat ?? null;
  const viewerIsSpectator = viewerSeat === null;
  const viewerCanSit = viewerIsSpectator && projection.status !== TableLifecycleStatus.SessionEnded;
  const viewerIsPresent = viewerSeat !== null || projection.spectators.some((player) => player.playerId === viewerId);
  const host = allPublicPlayers(projection).find((player) => player.playerId === projection.hostPlayerId);
  const viewerIsHost = projection.hostPlayerId === viewerId;
  const viewerHasSessionGrant = projection.session?.ledger.some(
    (entry) => entry.playerId === viewerId && entry.type === "INITIAL_GRANT",
  ) ?? false;
  const activeUncertainCommand = uncertainCommand ?? null;
  const actionBlocked = pendingCommand !== null || activeUncertainCommand !== null;

  return (
    <main className="table-page">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">FP</span>
          <div>
            <div className="brand-name">Friend Poker</div>
            <h1>朋友局</h1>
          </div>
        </div>
        <div className="topbar-status" role="status">
          <span className={`connection-dot phase-${phase.toLowerCase()}`} aria-hidden="true" />
          <span>{phaseLabel(phase)}</span>
          <span className="version-label">同步 v{projection.version}</span>
        </div>
      </header>

      {notice !== null && <p className="notice table-notice" role="status">{notice}</p>}

      {activeUncertainCommand !== null && (
        <div className="uncertain-command" role="alert">
          <span>上一条「{commandLabel(activeUncertainCommand.type)}」尚未确认。</span>
          <button type="button" className="secondary-button" disabled={pendingCommand !== null} onClick={onRetryUncertain}>
            {pendingCommand === activeUncertainCommand.type ? "重新确认中…" : "重新确认"}
          </button>
        </div>
      )}

      <section className="table-meta" aria-label="牌桌状态">
        <span className="table-meta-item table-meta-primary">{tableStatusLabel(projection.status)}</span>
        <span className="table-meta-item">
          盲注 {projection.session?.blinds.smallBlind ?? "—"} / {projection.session?.blinds.bigBlind ?? "—"}
        </span>
        <span className="table-meta-item">房主 · {host?.nickname ?? "暂无"}</span>
        {hand !== null && <span className="table-meta-item">{streetLabel(hand.street)} · {handStatusLabel(hand.status)}</span>}
      </section>

      <section className="poker-table-wrap" aria-label="六人牌桌">
        <div className="poker-table">
          <div className="table-center">
            <div className="table-caption">公共牌</div>
            <div className="board" aria-label="公共牌">
              {[0, 1, 2, 3, 4].map((index) => (
                <span className="board-slot" key={index}>
                  <PlayingCard card={hand?.board[index] ?? null} empty={hand?.board[index] === undefined} compact={hand?.board[index] === undefined} />
                </span>
              ))}
            </div>
            <div className="pot-display"><span>当前底池</span><strong>{hand?.potSize ?? 0}</strong></div>
            {hand !== null && (
              <div className="turn-display" aria-live="polite">
                {hand.currentActorId === null ? handStatusLabel(hand.status) : `轮到 ${displayNameForId(projection, hand.currentActorId)}`}
              </div>
            )}
          </div>

          {SEATS.map((seat) => {
            const player = projection.seats[seat] ?? null;
            const participant = hand?.participants.find((candidate) => candidate.playerId === player?.playerId) ?? null;
            return (
              <div className={`seat-anchor seat-anchor-${seat}`} key={seat}>
                <Seat
                  seat={seat}
                  player={player}
                  participant={participant}
                  isHost={player?.playerId === projection.hostPlayerId}
                  isViewer={player?.playerId === viewerId}
                  isCurrentActor={player?.playerId === hand?.currentActorId}
                  canSit={viewerCanSit && !actionBlocked}
                  pending={pendingCommand === "SIT" || activeUncertainCommand?.type === "SIT"}
                  onSit={(selectedSeat) => onCommand({ type: M11CommandType.Sit, seat: selectedSeat })}
                />
                {viewerSeat === seat && projection.ownHoleCards !== null && (
                  <div className="viewer-hole-cards" aria-label="你的底牌">
                    <span className="viewer-hole-label">你的牌</span>
                    <div className="hole-cards">
                      <PlayingCard card={projection.ownHoleCards[0]} compact />
                      <PlayingCard card={projection.ownHoleCards[1]} compact />
                    </div>
                  </div>
                )}
                <div className="position-badges" aria-label="牌桌位置">
                  {hand?.buttonSeat === seat && <span className="position-badge dealer-badge">D</span>}
                  {hand?.smallBlindSeat === seat && <span className="position-badge blind-badge">SB</span>}
                  {hand?.bigBlindSeat === seat && <span className="position-badge blind-badge">BB</span>}
                </div>
              </div>
            );
          })}
        </div>
      </section>

      <ActionDock
        projection={projection}
        viewerId={viewerId}
        disabled={actionBlocked}
        pendingCommand={pendingCommand}
        onCommand={onCommand}
      />

      <section className="table-utility" aria-label="牌桌辅助信息">
        <div className="utility-group spectator-group">
          <span className="utility-label">旁观席</span>
          <span className="utility-count">{projection.spectators.length} / 2</span>
          <div className="spectator-list">
            {projection.spectators.length === 0 ? <span className="muted-copy">暂无</span> : projection.spectators.map((spectator) => (
              <span className="spectator-chip" key={spectator.playerId}><span className={`status-dot${spectator.online ? " online" : ""}`} aria-hidden="true" />{spectator.nickname ?? "未命名玩家"}</span>
            ))}
          </div>
        </div>

        <div className="utility-group presence-group">
          <span className="utility-label">你</span>
          <span className="presence-copy">{viewerSeat === null ? "旁观中" : `座位 ${viewerSeat + 1}`}</span>
          {projection.ownHoleCards === null && <span className="muted-copy">当前没有可展示的私人底牌</span>}
          {viewerCanSit && <span className="muted-copy">点击桌上空座位坐下</span>}
          <div className="presence-actions">
            {viewerSeat !== null && <button className="secondary-button" type="button" disabled={actionBlocked} onClick={() => onCommand({ type: M11CommandType.StandToSpectate })}>{pendingCommand === "STAND_TO_SPECTATE" ? "处理中…" : "离座旁观"}</button>}
            {viewerIsPresent && <button className="quiet-button" type="button" disabled={actionBlocked} onClick={() => onCommand({ type: M11CommandType.LeaveTable })}>{pendingCommand === "LEAVE_TABLE" ? "处理中…" : "离开牌桌"}</button>}
            {projection.session !== null && projection.status !== TableLifecycleStatus.HandInProgress && viewerIsPresent && viewerHasSessionGrant && (
              <button className="secondary-button" type="button" disabled={actionBlocked} onClick={() => onCommand({ type: M11CommandType.Replenish })}>{pendingCommand === "REPLENISH" ? "补充中…" : "补充 +100"}</button>
            )}
          </div>
        </div>
      </section>

      <section className="session-actions" aria-label="本场流程">
        {viewerIsHost && projection.status === TableLifecycleStatus.NoSession && (
          <button className="primary-button session-primary-action" type="button" disabled={actionBlocked} onClick={() => onCommand({ type: M11CommandType.StartSession })}>{pendingCommand === "START_SESSION" ? "开场中…" : "开始本场"}</button>
        )}
        {viewerIsHost && projection.status === TableLifecycleStatus.WaitingForFirstHand && (
          <button className="primary-button session-primary-action" type="button" disabled={actionBlocked} onClick={() => onCommand({ type: M11CommandType.StartFirstHand })}>{pendingCommand === "START_FIRST_HAND" ? "发牌中…" : "开始第一手"}</button>
        )}
        {viewerIsHost && projection.status === TableLifecycleStatus.BetweenHands && (
          <button className="primary-button session-primary-action" type="button" disabled={actionBlocked} onClick={() => onCommand({ type: M11CommandType.StartNextHand })}>{pendingCommand === "START_NEXT_HAND" ? "发牌中…" : "开始下一手"}</button>
        )}
        {!viewerIsHost && projection.status !== TableLifecycleStatus.HandInProgress && projection.session !== null && <span className="muted-copy">等待房主决定下一步</span>}
        {hand !== null && hand.status === HandLifecycleStatus.Complete && <span className="muted-copy">本手结算完成</span>}
      </section>

      {viewerIsHost && (
        <HostControls
          projection={projection}
          viewerId={viewerId}
          disabled={actionBlocked}
          pendingCommand={pendingCommand}
          onCommand={onCommand}
        />
      )}
    </main>
  );
}

function commandLabel(type: M11Command["type"]): string {
  const labels: Partial<Record<M11Command["type"], string>> = {
    FOLD: "弃牌",
    CHECK: "过牌",
    CALL: "跟注",
    BET: "下注",
    RAISE: "加注",
    ALL_IN: "全下",
    REPLENISH: "补充筹码",
    START_SESSION: "开始本场",
    START_FIRST_HAND: "开始第一手",
    START_NEXT_HAND: "开始下一手",
  };
  return labels[type] ?? type;
}

function ActionDock({
  projection,
  viewerId,
  disabled,
  pendingCommand,
  onCommand,
}: {
  readonly projection: SafeTableProjection;
  readonly viewerId: string;
  readonly disabled: boolean;
  readonly pendingCommand: M11Command["type"] | null;
  readonly onCommand: (command: M11Command) => Promise<CommandResult | null> | undefined;
}) {
  const legal = projection.viewerLegalActions;
  const hand = projection.currentHand;
  const isTurn = legal !== null && legal.playerId === viewerId;
  const amountMode = legal?.canBet ? "BET" : legal?.canRaise ? "RAISE" : null;
  const [amount, setAmount] = useState("");

  useEffect(() => {
    const minimum = legal?.canBet ? legal.minimumBet : legal?.canRaise ? legal.minimumRaiseTo : null;
    setAmount(minimum === null || minimum === undefined ? "" : String(minimum));
  }, [legal?.canBet, legal?.canRaise, legal?.minimumBet, legal?.minimumRaiseTo]);

  const quickTargets = useMemo(() => {
    if (legal === null || hand === null || amountMode === null) return [];
    return (["HALF_POT", "TWO_THIRDS_POT", "POT"] as PotQuickSize[]).map((size) => ({
      size,
      target: calculatePotQuickTarget({ actions: legal, potSize: hand.potSize, currentBet: hand.currentBet, size }),
    }));
  }, [amountMode, hand, legal]);

  if (!isTurn || legal === null) {
    if (projection.viewerCanRevealUncontested) {
      return (
        <section className="action-dock action-dock-waiting" aria-label="行动区">
          <span className="action-dock-label">本手获胜</span>
          <button type="button" className="secondary-button" disabled={disabled} onClick={() => onCommand({ type: M11CommandType.RevealUncontested })}>亮牌</button>
          <span className="action-dock-status">两张底牌会进入本手记录</span>
        </section>
      );
    }
    return (
      <section className="action-dock action-dock-waiting" aria-label="行动区">
        <span className="action-dock-label">行动</span>
        <span className="action-dock-status">
          {hand?.currentActorId === null ? "等待牌局推进" : hand?.currentActorId === undefined ? "等待房主开牌" : `等待 ${displayNameForId(projection, hand.currentActorId)} 行动`}
        </span>
      </section>
    );
  }

  const submitAmount = (): void => {
    const parsed = Number(amount);
    if (!Number.isInteger(parsed)) return;
    if (amountMode === "BET") onCommand({ type: M11CommandType.Bet, amount: parsed });
    if (amountMode === "RAISE") onCommand({ type: M11CommandType.Raise, raiseTo: parsed });
  };

  return (
    <section className="action-dock" aria-label="行动区">
      <div className="action-dock-heading"><span className="action-dock-label">轮到你</span><span className="action-dock-hint">服务器已确认可用动作</span></div>
      <div className="action-buttons">
        {legal.canFold && <button type="button" className="action-button action-fold" disabled={disabled} onClick={() => onCommand({ type: M11CommandType.Fold })}>弃牌 <span>Fold</span></button>}
        {legal.canCheck && <button type="button" className="action-button action-check" disabled={disabled} onClick={() => onCommand({ type: M11CommandType.Check })}>过牌 <span>Check</span></button>}
        {legal.canCall && <button type="button" className="action-button action-call" disabled={disabled} onClick={() => onCommand({ type: M11CommandType.Call })}>跟注 {legal.callAmount}{legal.callIsAllIn ? " · All-in" : ""} <span>Call</span></button>}
        {amountMode !== null && (
          <div className="amount-action">
            <div className="amount-action-title">{amountMode === "BET" ? "下注至" : "加注至"} <strong>{amount}</strong></div>
            <div className="quick-buttons" aria-label="底池快捷下注">
              {quickTargets.map(({ size, target }) => target === null ? null : <button key={size} type="button" className="quick-button" disabled={disabled} onClick={() => setAmount(String(target))}>{size === "HALF_POT" ? "½ Pot" : size === "TWO_THIRDS_POT" ? "⅔ Pot" : "1× Pot"}</button>)}
            </div>
            <div className="amount-row">
              <input aria-label={amountMode === "BET" ? "下注金额" : "加注至金额"} type="number" min={legal.canBet ? legal.minimumBet ?? undefined : legal.minimumRaiseTo ?? undefined} max={legal.canBet ? legal.maximumBet ?? undefined : legal.maximumRaiseTo ?? undefined} step="1" value={amount} onChange={(event) => setAmount(event.target.value)} />
              <button type="button" className="action-button action-raise" disabled={disabled || amount.length === 0} onClick={submitAmount}>{amountMode === "BET" ? "下注 Bet" : "加注 Raise"}</button>
            </div>
            <span className="amount-range">最低 {legal.canBet ? legal.minimumBet : legal.minimumRaiseTo} · 最高 {legal.canBet ? legal.maximumBet : legal.maximumRaiseTo}</span>
          </div>
        )}
        {legal.canAllIn && <button type="button" className="action-button action-all-in" disabled={disabled} onClick={() => onCommand({ type: M11CommandType.AllIn })}>全下 {legal.allInTo} <span>All-in</span></button>}
      </div>
      {pendingCommand !== null && <span className="action-dock-pending">正在等待服务器确认…</span>}
    </section>
  );
}

function HostControls({
  projection,
  viewerId,
  disabled,
  pendingCommand,
  onCommand,
}: {
  readonly projection: SafeTableProjection;
  readonly viewerId: string;
  readonly disabled: boolean;
  readonly pendingCommand: M11Command["type"] | null;
  readonly onCommand: (command: M11Command) => Promise<CommandResult | null> | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [smallBlind, setSmallBlind] = useState(String(projection.session?.blinds.smallBlind ?? 1));
  const [bigBlind, setBigBlind] = useState(String(projection.session?.blinds.bigBlind ?? 2));
  const [adjustTarget, setAdjustTarget] = useState("");
  const [adjustAmount, setAdjustAmount] = useState("");
  const [transferTarget, setTransferTarget] = useState("");
  const [endPreview, setEndPreview] = useState<PublicSessionEndPreview | null>(null);
  const players = allPublicPlayers(projection);
  const candidates = players.filter((player) => player.playerId !== viewerId);
  const currentActor = projection.currentHand?.currentActorId;

  useEffect(() => {
    setSmallBlind(String(projection.session?.blinds.smallBlind ?? 1));
    setBigBlind(String(projection.session?.blinds.bigBlind ?? 2));
  }, [projection.session?.blinds.bigBlind, projection.session?.blinds.smallBlind]);

  const sendPrepareEnd = async (): Promise<void> => {
    const result = await onCommand({ type: M11CommandType.PrepareEndSession });
    const preview = readSessionPreview(result ?? null);
    if (preview !== null) setEndPreview(preview);
  };

  return (
    <section className={`host-controls${open ? " is-open" : ""}`} aria-label="房主管理">
      <button type="button" className="host-controls-toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span>房主管理</span><span>{open ? "收起" : "打开"}</span>
      </button>
      {open && (
        <div className="host-controls-body">
          {projection.session !== null && projection.status !== TableLifecycleStatus.HandInProgress && (
            <div className="host-control-row">
              <div><strong>盲注</strong><span className="host-help">两手之间修改</span></div>
              <div className="inline-form"><label>SB<input aria-label="小盲" type="number" min="1" step="1" value={smallBlind} onChange={(event) => setSmallBlind(event.target.value)} /></label><label>BB<input aria-label="大盲" type="number" min="1" step="1" value={bigBlind} onChange={(event) => setBigBlind(event.target.value)} /></label><button type="button" className="secondary-button" disabled={disabled || pendingCommand === "CHANGE_BLINDS"} onClick={() => onCommand({ type: M11CommandType.ChangeBlinds, smallBlind: Number(smallBlind), bigBlind: Number(bigBlind) })}>保存</button></div>
            </div>
          )}
          {projection.session !== null && projection.status !== TableLifecycleStatus.HandInProgress && (
            <div className="host-control-row">
              <div><strong>筹码调整</strong><span className="host-help">记录到本场账本</span></div>
              <div className="inline-form"><select aria-label="调整目标玩家" value={adjustTarget} onChange={(event) => setAdjustTarget(event.target.value)}><option value="">选择玩家</option>{players.map((player) => <option key={player.playerId} value={player.playerId}>{player.nickname ?? player.playerId}</option>)}</select><input aria-label="调整筹码数量" type="number" step="1" value={adjustAmount} placeholder="+/-" onChange={(event) => setAdjustAmount(event.target.value)} /><button type="button" className="secondary-button" disabled={disabled || adjustTarget.length === 0 || !Number.isInteger(Number(adjustAmount)) || Number(adjustAmount) === 0} onClick={() => { if (canConfirm("确认记录这笔筹码调整吗？")) void onCommand({ type: M11CommandType.HostAdjustChips, targetPlayerId: adjustTarget, amount: Number(adjustAmount) }); }}>记录</button></div>
            </div>
          )}
          <div className="host-control-row">
            <div><strong>房主转让</strong><span className="host-help">立即生效</span></div>
            <div className="inline-form"><select aria-label="新房主" value={transferTarget} onChange={(event) => setTransferTarget(event.target.value)}><option value="">选择玩家</option>{candidates.map((player) => <option key={player.playerId} value={player.playerId}>{player.nickname ?? player.playerId}</option>)}</select><button type="button" className="secondary-button" disabled={disabled || transferTarget.length === 0} onClick={() => { if (canConfirm("确认转让房主吗？")) void onCommand({ type: M11CommandType.TransferHost, targetPlayerId: transferTarget }); }}>转让</button></div>
          </div>
          <div className="host-control-row host-danger-row">
            <div><strong>牌桌管理</strong><span className="host-help">危险操作需要确认</span></div>
            <div className="host-player-actions">{candidates.map((player) => <button key={player.playerId} type="button" className="quiet-button danger-button" disabled={disabled} onClick={() => { if (canConfirm(`确认移出 ${player.nickname ?? "这位玩家"} 吗？`)) void onCommand({ type: M11CommandType.Kick, targetPlayerId: player.playerId }); }}>移出 {player.nickname ?? "玩家"}</button>)}{currentActor !== undefined && currentActor !== null && <button type="button" className="quiet-button danger-button" disabled={disabled} onClick={() => { if (canConfirm(`确认强制 ${displayNameForId(projection, currentActor)} 弃牌吗？`)) void onCommand({ type: M11CommandType.HostForceFold, targetPlayerId: currentActor }); }}>强制弃牌</button>}</div>
          </div>
          {projection.session !== null && projection.status !== TableLifecycleStatus.HandInProgress && endPreview === null && <div className="host-control-row host-end-row"><div><strong>结束本场</strong><span className="host-help">先生成权威结算预览</span></div><button type="button" className="quiet-button danger-button" disabled={disabled} onClick={() => void sendPrepareEnd()}>准备结束本场</button></div>}
          {endPreview !== null && <div className="end-preview" role="dialog" aria-label="结束本场确认"><strong>确认结束本场？</strong><span>已完成 {endPreview.completedHandCount} 手</span><ul>{endPreview.participantPlayerIds.map((playerId) => <li key={playerId}>{displayNameForId(projection, playerId)}：{endPreview.finalChipBalances[playerId] ?? 0}</li>)}</ul><div className="inline-form"><button type="button" className="quiet-button" onClick={() => setEndPreview(null)}>返回</button><button type="button" className="danger-solid-button" disabled={disabled} onClick={() => void onCommand({ type: M11CommandType.EndSession, confirmation: endPreview })}>确认结束本场</button></div></div>}
        </div>
      )}
    </section>
  );
}
