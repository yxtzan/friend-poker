import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { PublicTableHandRecord } from "@friend-poker/shared";
import type { RefObject } from "react";
import { HistoryDrawer, HandRankingDrawer } from "./secondary-drawers.js";
import { projectionFixture } from "../test/fixtures.js";

function triggerRef(): RefObject<HTMLButtonElement | null> {
  return { current: null };
}

describe("secondary table drawers", () => {
  it("provides the complete static hand-ranking reference and keyboard close", () => {
    const onClose = vi.fn();
    render(<HandRankingDrawer open onClose={onClose} triggerRef={triggerRef()} />);

    expect(screen.getByRole("dialog", { name: "牌型表" })).toBeInTheDocument();
    expect(screen.getByText("皇家同花顺")).toBeInTheDocument();
    expect(screen.getByText("A-2-3-4-5 按 5-high 顺子处理。")).toBeInTheDocument();
    expect(screen.getAllByLabelText(/示例$/)).toHaveLength(10);

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders safe hand and session history without private unrevealed cards", () => {
    const hand: PublicTableHandRecord = {
      sessionId: "session-archive",
      handNumber: 4,
      record: {
        handId: "hand-archive",
        participants: [
          { playerId: "alice", nickname: "Alice", seat: 0, startingStack: 100 },
        ],
        buttonSeat: 0,
        smallBlindSeat: 0,
        bigBlindSeat: 2,
        smallBlind: 1,
        bigBlind: 2,
        actions: [],
        board: [{ rank: 14, suit: "s" }],
        flop: [{ rank: 14, suit: "s" }],
        turn: null,
        river: null,
        events: [
          {
            type: "ACTION",
            playerId: "alice",
            sequence: 1,
            street: "PREFLOP",
            requestedType: "CHECK",
            semantic: "CHECK",
            amountCommitted: 0,
            toContribution: 1,
            isAllIn: false,
            isFullBetOrRaise: false,
          },
        ],
        completionReason: "UNCONTESTED",
        settlement: null,
        revealedHoleCards: [],
      },
    };
    const projection = projectionFixture({
      recentHands: [hand],
      recentSessions: [
        {
          sessionId: "session-archive",
          participantPlayerIds: ["alice"],
          players: [
            {
              playerId: "alice",
              nickname: "Alice",
              initialGrants: 100,
              replenishments: 10,
              hostAdjustments: 0,
              finalChipBalance: 108,
              netResult: -2,
            },
          ],
          handCount: 4,
        },
      ],
    });

    render(
      <HistoryDrawer
        open
        onClose={vi.fn()}
        triggerRef={triggerRef()}
        initialTab="HANDS"
        projection={projection}
      />,
    );

    expect(screen.getByText("第 4 手")).toBeInTheDocument();
    fireEvent.click(screen.getByText("第 4 手"));
    expect(screen.getByText("hand-archive")).toBeInTheDocument();
    expect(screen.getByText("Alice · CHECK · 投入 0")).toBeInTheDocument();
    expect(screen.queryByText("已公开底牌")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /最近本场/ }));
    expect(screen.getByText("session-archive")).toBeInTheDocument();
    expect(screen.getByText("流入 110")).toBeInTheDocument();
  });
});
