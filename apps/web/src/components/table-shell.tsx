import {
  HandLifecycleStatus,
  Street,
  TableLifecycleStatus,
  type M10Command,
  type SafeTableProjection,
  type TableSeat,
} from "@friend-poker/shared";
import { PlayingCard } from "./card.js";
import { Seat } from "./seat.js";
import type { AppPhase } from "../state/use-table-app.js";

interface TableShellProps {
  readonly projection: SafeTableProjection;
  readonly viewerId: string;
  readonly phase: AppPhase;
  readonly pendingCommand: M10Command["type"] | null;
  readonly notice: string | null;
  readonly onCommand: (command: M10Command) => void;
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

export function TableShell({
  projection,
  viewerId,
  phase,
  pendingCommand,
  notice,
  onCommand,
}: TableShellProps) {
  const hand = projection.currentHand;
  const viewerSeat = projection.seats.find((player) => player?.playerId === viewerId)?.seat ?? null;
  const viewerIsSpectator = viewerSeat === null;
  const viewerCanSit = viewerIsSpectator && projection.status !== TableLifecycleStatus.SessionEnded;
  const viewerIsPresent = viewerSeat !== null || projection.spectators.some((player) => player.playerId === viewerId);
  const host = projection.seats
    .concat(projection.spectators)
    .find((player) => player?.playerId === projection.hostPlayerId);

  return (
    <main className="table-page">
      <header className="topbar">
        <div>
          <div className="eyebrow">FRIEND POKER · PRIVATE TABLE</div>
          <h1>朋友局</h1>
        </div>
        <div className="topbar-status" role="status">
          <span className={`connection-dot phase-${phase.toLowerCase()}`} aria-hidden="true" />
          <span>{phaseLabel(phase)}</span>
          <span className="version-label">v{projection.version}</span>
        </div>
      </header>

      {notice !== null && (
        <p className="notice table-notice" role="status">
          {notice}
        </p>
      )}

      <section className="status-strip" aria-label="牌桌状态">
        <span className="status-item status-primary">{tableStatusLabel(projection.status)}</span>
        <span className="status-item">
          盲注 {projection.session?.blinds.smallBlind ?? "—"} / {projection.session?.blinds.bigBlind ?? "—"}
        </span>
        <span className="status-item">房主：{host?.nickname ?? "暂无"}</span>
        {hand !== null && (
          <span className="status-item">
            {streetLabel(hand.street)} · {handStatusLabel(hand.status)}
          </span>
        )}
      </section>

      <section className="poker-table-wrap" aria-label="六人牌桌">
        <div className="poker-table">
          <div className="table-center">
            <div className="table-caption">公共牌</div>
            <div className="board" aria-label="公共牌">
              {[0, 1, 2, 3, 4].map((index) => (
                <span className="board-slot" key={index}>
                  <PlayingCard
                    card={hand?.board[index] ?? null}
                    empty={hand?.board[index] === undefined}
                    compact={hand?.board[index] === undefined}
                  />
                </span>
              ))}
            </div>
            <div className="pot-display">
              <span>当前底池</span>
              <strong>{hand?.potSize ?? 0}</strong>
            </div>
            {hand !== null && (
              <div className="turn-display" aria-live="polite">
                {hand.currentActorId === null
                  ? handStatusLabel(hand.status)
                  : `轮到 ${displayNameForId(projection, hand.currentActorId)}`}
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
                  canSit={viewerCanSit}
                  pending={pendingCommand === "SIT"}
                  onSit={(selectedSeat) => onCommand({ type: "SIT", seat: selectedSeat })}
                />
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

      <section className="table-lower-grid">
        <div className="hole-card-panel">
          <div className="panel-heading">你的手牌</div>
          {projection.ownHoleCards === null ? (
            <p className="muted-copy">当前没有可展示的私人底牌</p>
          ) : (
            <div className="hole-cards" aria-label="你的底牌">
              <PlayingCard card={projection.ownHoleCards[0]} />
              <PlayingCard card={projection.ownHoleCards[1]} />
            </div>
          )}
        </div>

        <div className="spectator-panel">
          <div className="panel-heading">旁观席 <span>{projection.spectators.length} / 2</span></div>
          <div className="spectator-list">
            {projection.spectators.length === 0 ? (
              <span className="muted-copy">还没有旁观者</span>
            ) : (
              projection.spectators.map((spectator) => (
                <span className="spectator-chip" key={spectator.playerId}>
                  <span className={`status-dot${spectator.online ? " online" : ""}`} aria-hidden="true" />
                  {spectator.nickname ?? "未命名玩家"}
                </span>
              ))
            )}
          </div>
        </div>

        <div className="presence-panel">
          <div className="panel-heading">我的位置</div>
          <p className="presence-copy">{viewerSeat === null ? "旁观中" : `座位 ${viewerSeat + 1}`}</p>
          <div className="presence-actions">
            {viewerCanSit && (
              <span className="muted-copy">点击桌上任一空座位坐下</span>
            )}
            {viewerSeat !== null && (
              <button
                className="secondary-button"
                type="button"
                disabled={pendingCommand !== null}
                onClick={() => onCommand({ type: "STAND_TO_SPECTATE" })}
              >
                {pendingCommand === "STAND_TO_SPECTATE" ? "处理中…" : "离座旁观"}
              </button>
            )}
            {viewerIsPresent && (
              <button
                className="quiet-button"
                type="button"
                disabled={pendingCommand !== null}
                onClick={() => onCommand({ type: "LEAVE_TABLE" })}
              >
                {pendingCommand === "LEAVE_TABLE" ? "处理中…" : "离开牌桌"}
              </button>
            )}
          </div>
        </div>
      </section>
    </main>
  );
}

function displayNameForId(projection: SafeTableProjection, playerId: string): string {
  const player = projection.seats
    .concat(projection.spectators)
    .find((candidate) => candidate?.playerId === playerId);
  return player?.nickname ?? "玩家";
}
