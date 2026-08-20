import type { TableSeat } from "@friend-poker/shared";
import type { AppPhase, TableAppState } from "../state/use-table-app.js";
import type { EntryPosition } from "../api/identity.js";

interface EntryScreenProps {
  readonly app: TableAppState;
}

function positionLabel(position: EntryPosition): string {
  return position.kind === "SPECTATOR" ? "旁观" : `座位 ${position.seat + 1}`;
}

function connectionLabel(phase: AppPhase): string {
  if (phase === "BOOTING") return "正在恢复身份…";
  if (phase === "CONNECTING") return "正在连接牌桌…";
  if (phase === "REVOKED") return "身份已撤销";
  if (phase === "SESSION_ENDED") return "本场已结束";
  if (phase === "ERROR") return "连接未完成";
  return "准备进入牌桌";
}

export function EntryScreen({ app }: EntryScreenProps) {
  const isBusy = app.phase === "BOOTING" || app.phase === "CONNECTING";
  const selectedPosition = app.position;
  return (
    <main className="entry-shell">
      <section className="entry-room" aria-labelledby="entry-title">
        <header className="entry-header">
          <div className="brand-lockup">
            <span className="brand-mark" aria-hidden="true">FP</span>
            <div>
              <div className="brand-name">Friend Poker</div>
              <div className="room-label">朋友局 · 一张桌</div>
            </div>
          </div>
          <div className="entry-connection" role="status">
            <span className={`status-dot${app.phase === "CONNECTED" ? " online" : ""}`} aria-hidden="true" />
            {connectionLabel(app.phase)}
          </div>
        </header>

        <div className="entry-layout">
          <div className="entry-form-column">
            <div className="entry-kicker">进入牌桌</div>
            <h1 id="entry-title">先坐下，再开牌</h1>
            <p className="entry-intro">输入一个朋友认识的名字，选择位置。</p>

            {app.notice !== null && (
              <p className="notice notice-error" role="alert">
                {app.notice}
              </p>
            )}

            <form
              onSubmit={(event) => {
                event.preventDefault();
                void app.submitEntry();
              }}
            >
              <label className="field-label" htmlFor="nickname">
                你的名字
              </label>
              <input
                id="nickname"
                className="nickname-input"
                value={app.nickname}
                onChange={(event) => app.setNickname(event.target.value)}
                placeholder="例如：小明"
                autoComplete="nickname"
                disabled={isBusy}
              />

              <fieldset className="position-picker">
                <legend>选择位置</legend>
                <div className="position-map">
                  <div className="position-felt" aria-hidden="true" />
                  {([0, 1, 2, 3, 4, 5] as TableSeat[]).map((seat) => {
                    const position: EntryPosition = { kind: "SEAT", seat };
                    const selected = selectedPosition.kind === "SEAT" && selectedPosition.seat === seat;
                    return (
                      <button
                        key={seat}
                        type="button"
                        className={`position-option position-seat-${seat}${selected ? " selected" : ""}`}
                        aria-pressed={selected}
                        disabled={isBusy}
                        onClick={() => app.setPosition(position)}
                      >
                        <span className="seat-number">{seat + 1}</span>
                        <span>座位 {seat + 1}</span>
                      </button>
                    );
                  })}
                  <button
                    type="button"
                    className={`position-option spectator-option${selectedPosition.kind === "SPECTATOR" ? " selected" : ""}`}
                    aria-pressed={selectedPosition.kind === "SPECTATOR"}
                    disabled={isBusy}
                    onClick={() => app.setPosition({ kind: "SPECTATOR" })}
                  >
                    <span className="seat-number" aria-hidden="true">◌</span>
                    <span>旁观</span>
                  </button>
                </div>
              </fieldset>

              <button className="primary-button entry-submit" type="submit" disabled={isBusy}>
                {isBusy
                  ? "请稍候…"
                  : app.canReenterAfterKick
                    ? `以「${positionLabel(selectedPosition)}」重新加入`
                    : `以「${positionLabel(selectedPosition)}」进入`}
              </button>
            </form>
            <p className="entry-footnote">虚拟筹码 · 身份凭证由浏览器安全保存</p>
          </div>

          <aside className="entry-side-note" aria-label="牌桌提示">
            <div className="side-note-mark" aria-hidden="true">♠</div>
            <p>今晚的牌局</p>
            <strong>等朋友到齐，房主开牌。</strong>
            <span>最多 6 位玩家，另有 2 个旁观席。</span>
          </aside>
        </div>
      </section>
    </main>
  );
}
