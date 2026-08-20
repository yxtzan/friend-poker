import type {
  PublicPlayerAmount,
  PublicRevealedHoleCards,
  PublicTableHandRecord,
  SafeTableProjection,
} from "@friend-poker/shared";
import { handCategoryLabel } from "../state/presentations.js";
import { PlayingCard } from "./card.js";

function formatChips(amount: number): string {
  return amount.toLocaleString("zh-CN");
}

function playerName(
  projection: SafeTableProjection,
  record: PublicTableHandRecord["record"],
  playerId: string,
): string {
  const recordedParticipant = record.participants.find((player) => player.playerId === playerId);
  if (recordedParticipant?.nickname) return recordedParticipant.nickname;
  const currentPlayer = projection.seats
    .concat(projection.spectators)
    .find((player) => player?.playerId === playerId);
  return currentPlayer?.nickname ?? "玩家";
}

function amountFor(payouts: readonly PublicPlayerAmount[], playerId: string): number {
  return payouts.find((payout) => payout.playerId === playerId)?.amount ?? 0;
}

function winningPayouts(payouts: readonly PublicPlayerAmount[]): readonly PublicPlayerAmount[] {
  return payouts.filter((payout) => payout.amount > 0);
}

function payoutLabel(
  projection: SafeTableProjection,
  record: PublicTableHandRecord["record"],
  payouts: readonly PublicPlayerAmount[],
): string {
  if (payouts.length === 0) return "本手已完成结算";
  if (payouts.length === 1) {
    const payout = payouts[0];
    if (payout === undefined) return "本手已完成结算";
    return `${playerName(projection, record, payout.playerId)} 赢得 ${formatChips(payout.amount)}`;
  }
  return "多人分池结算";
}

function RevealedHand({
  projection,
  record,
  revealed,
}: {
  readonly projection: SafeTableProjection;
  readonly record: PublicTableHandRecord["record"];
  readonly revealed: PublicRevealedHoleCards;
}) {
  const evaluated = record.settlement?.evaluatedHands.find((hand) => hand.playerId === revealed.playerId);
  return (
    <article className="hand-result-showdown-player">
      <div className="hand-result-player-heading">
        <strong>{playerName(projection, record, revealed.playerId)}</strong>
        <span>{revealed.reason === "SHOWDOWN" ? "摊牌" : "主动亮牌"}</span>
      </div>
      <div className="hand-result-card-row" aria-label={`${playerName(projection, record, revealed.playerId)} 的公开底牌`}>
        {revealed.cards.map((card) => <PlayingCard card={card} compact key={`${card.rank}${card.suit}`} />)}
      </div>
      {evaluated !== undefined && (
        <div className="hand-result-hand-rank">
          <span>{handCategoryLabel(evaluated.handRank.category, evaluated.handRank.tiebreakers)}</span>
          <div className="hand-result-best-five" aria-label="最佳五张牌">
            {evaluated.handRank.bestFive.map((card) => <PlayingCard card={card} compact key={`${card.rank}${card.suit}`} />)}
          </div>
        </div>
      )}
    </article>
  );
}

export function HandResultPanel({
  projection,
  hand,
  onClose,
}: {
  readonly projection: SafeTableProjection;
  readonly hand: PublicTableHandRecord;
  readonly onClose: () => void;
}) {
  const record = hand.record;
  const settlement = record.settlement;
  if (settlement === null) return null;
  const reasonLabel = record.completionReason === "SHOWDOWN" ? "摊牌结算" : "无人跟注结算";
  const positivePayouts = winningPayouts(settlement.totalPayouts);
  const positiveRefunds = settlement.refunds.filter((refund) => refund.amount > 0);

  return (
    <section className="hand-result" aria-labelledby="hand-result-title" data-testid="hand-result">
      <div className="hand-result-heading">
        <div>
          <span className="hand-result-kicker">第 {hand.handNumber} 手 · {reasonLabel}</span>
          <h2 id="hand-result-title">{payoutLabel(projection, record, positivePayouts)}</h2>
        </div>
        <button type="button" className="hand-result-close quiet-button" onClick={onClose} aria-label="关闭本手结果">×</button>
      </div>

      <div className="hand-result-summary">
        <span>公共牌</span>
        <div className="hand-result-card-row" aria-label="本手公共牌">
          {record.board.map((card) => <PlayingCard card={card} compact key={`${card.rank}${card.suit}`} />)}
        </div>
        {record.completionReason === "UNCONTESTED" && <span>其他玩家均已弃牌</span>}
      </div>

      <div className="hand-result-pots" aria-label="底池结算">
        {settlement.pots.map((pot) => (
          <article className="hand-result-pot" key={`${pot.potIndex}-${pot.kind}`}>
            <div className="hand-result-pot-heading">
              <span>{pot.kind === "MAIN" ? "主池" : `边池 ${pot.potIndex}`}</span>
              <strong>{formatChips(pot.amount)}</strong>
            </div>
            <ul>
              {pot.payouts.map((payout) => (
                <li key={payout.playerId}>
                  <span>{playerName(projection, record, payout.playerId)} {payout.oddChips > 0 ? `（含 ${payout.oddChips} 奇数筹码）` : ""}</span>
                  <strong>+{formatChips(payout.amount)}</strong>
                </li>
              ))}
            </ul>
          </article>
        ))}
      </div>

      {positiveRefunds.length > 0 && (
        <div className="hand-result-refunds" aria-label="未跟注筹码退回">
          <h3>未跟注筹码退回</h3>
          <ul>
            {positiveRefunds.map((refund) => (
              <li key={refund.playerId}>
                <span>{playerName(projection, record, refund.playerId)}</span>
                <strong>+{formatChips(refund.amount)}</strong>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="hand-result-total-payouts" aria-label="玩家总收入">
        {positivePayouts.map((payout) => (
          <span key={payout.playerId}>{playerName(projection, record, payout.playerId)} +{formatChips(amountFor(positivePayouts, payout.playerId))}</span>
        ))}
      </div>

      {record.revealedHoleCards.length > 0 && (
        <div className="hand-result-showdown" aria-label="公开底牌与牌型">
          <h3>{record.completionReason === "SHOWDOWN" ? "摊牌牌型" : "公开底牌"}</h3>
          <div className="hand-result-showdown-grid">
            {record.revealedHoleCards.map((revealed) => (
              <RevealedHand
                key={revealed.playerId}
                projection={projection}
                record={record}
                revealed={revealed}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
