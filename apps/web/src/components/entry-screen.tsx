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
      <section className="entry-card" aria-labelledby="entry-title">
        <div className="eyebrow">FRIEND POKER · PRIVATE TABLE</div>
        <h1 id="entry-title">今晚，来一手？</h1>
        <p className="entry-intro">输入昵称，选择一个座位或先旁观。筹码只用于朋友间的虚拟牌局。</p>
        <div className="connection-pill" role="status">
          <span className="status-dot" aria-hidden="true" />
          {connectionLabel(app.phase)}
        </div>

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
            昵称
          </label>
          <input
            id="nickname"
            className="nickname-input"
            value={app.nickname}
            onChange={(event) => app.setNickname(event.target.value)}
            placeholder="例如：小明"
            maxLength={12}
            autoComplete="nickname"
            disabled={isBusy}
          />

          <fieldset className="position-picker">
            <legend>进入方式</legend>
            <div className="position-grid">
              {([0, 1, 2, 3, 4, 5] as TableSeat[]).map((seat) => {
                const position: EntryPosition = { kind: "SEAT", seat };
                const selected = selectedPosition.kind === "SEAT" && selectedPosition.seat === seat;
                return (
                  <button
                    key={seat}
                    type="button"
                    className={`position-option${selected ? " selected" : ""}`}
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
        <p className="entry-footnote">身份凭证由浏览器安全保存，页面不会读取或显示它。</p>
      </section>
    </main>
  );
}
