import type {
  CurrentHandParticipantProjection,
  PublicPlayerProjection,
  TableSeat,
} from "@friend-poker/shared";

interface SeatProps {
  readonly seat: TableSeat;
  readonly player: PublicPlayerProjection | null;
  readonly participant: CurrentHandParticipantProjection | null;
  readonly isHost: boolean;
  readonly isViewer: boolean;
  readonly isCurrentActor: boolean;
  readonly canSit: boolean;
  readonly pending: boolean;
  readonly onSit: (seat: TableSeat) => void;
}

export function Seat({
  seat,
  player,
  participant,
  isHost,
  isViewer,
  isCurrentActor,
  canSit,
  pending,
  onSit,
}: SeatProps) {
  if (player === null) {
    return (
      <div className="seat empty-seat" data-testid={`seat-${seat}`}>
        <span className="empty-seat-label">空座</span>
        {canSit && (
          <button className="seat-action" type="button" onClick={() => onSit(seat)} disabled={pending}>
            {pending ? "处理中…" : "坐下"}
          </button>
        )}
      </div>
    );
  }

  const displayName = player.nickname ?? "未命名玩家";
  const chipLabel = participant === null ? player.chipBalance : participant.stack;
  const stateLabel = participant?.folded
    ? "已弃牌"
    : participant?.allIn
      ? "全下"
      : player.online
        ? "在线"
        : "掉线";

  return (
    <div
      className={`seat occupied-seat${isViewer ? " viewer-seat" : ""}${isCurrentActor ? " current-actor" : ""}${!player.online ? " offline-seat" : ""}`}
      data-testid={`seat-${seat}`}
      aria-label={`${displayName}，${stateLabel}`}
    >
      <div className="seat-topline">
        <span className="player-name">{displayName}</span>
        <span className={`online-state${player.online ? " online" : ""}`}>
          <span className="status-dot" aria-hidden="true" />
          {stateLabel}
        </span>
      </div>
      <div className="chip-count">{chipLabel} <span>筹码</span></div>
      <div className="seat-tags" aria-label="位置和状态">
        {isHost && <span className="seat-tag host-tag">房主</span>}
        {participant?.folded && <span className="seat-tag muted-tag">Fold</span>}
        {participant?.allIn && <span className="seat-tag all-in-tag">All-in</span>}
        {isCurrentActor && <span className="seat-tag turn-tag">行动中</span>}
      </div>
      {participant !== null && (
        <div className="seat-contribution">
          本街下注 {participant.streetContribution}
        </div>
      )}
      {player.pendingLeaveAfterHand && <div className="seat-pending">本手结束后离座</div>}
    </div>
  );
}
