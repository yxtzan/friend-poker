import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult, M11Command, PublicActionRecord, PublicTableHandRecord } from "@friend-poker/shared";
import { TableShell } from "./table-shell.js";
import { projectionFixture } from "../test/fixtures.js";
import { STREET_REVEAL_DURATION_MS } from "../state/presentations.js";

function resultFixture(): PublicTableHandRecord {
  const board = [
    { rank: 2, suit: "c" },
    { rank: 7, suit: "d" },
    { rank: 11, suit: "h" },
    { rank: 4, suit: "s" },
    { rank: 14, suit: "c" },
  ] as const;
  return {
    sessionId: "session-1",
    handNumber: 8,
    record: {
      handId: "hand-8",
      participants: [
        { playerId: "alice", nickname: "Alice", seat: 0, startingStack: 100 },
        { playerId: "bob", nickname: "Bob", seat: 2, startingStack: 100 },
      ],
      buttonSeat: 0,
      smallBlindSeat: 0,
      bigBlindSeat: 2,
      smallBlind: 1,
      bigBlind: 2,
      actions: [],
      board: [...board],
      flop: [...board.slice(0, 3)],
      turn: board[3],
      river: board[4],
      events: [],
      completionReason: "SHOWDOWN",
      settlement: {
        refunds: [
          { playerId: "alice", amount: 0 },
          { playerId: "bob", amount: 0 },
        ],
        pots: [
          {
            potIndex: 0,
            kind: "MAIN",
            contributionFrom: 0,
            contributionTo: 30,
            amount: 30,
            contributorPlayerIds: ["alice", "bob"],
            eligiblePlayerIds: ["alice", "bob"],
            winnerPlayerIds: ["alice", "bob"],
            payouts: [
              { playerId: "alice", amount: 15, oddChips: 0 },
              { playerId: "bob", amount: 15, oddChips: 0 },
            ],
          },
          {
            potIndex: 1,
            kind: "SIDE",
            contributionFrom: 30,
            contributionTo: 40,
            amount: 10,
            contributorPlayerIds: ["alice"],
            eligiblePlayerIds: ["alice"],
            winnerPlayerIds: ["alice"],
            payouts: [{ playerId: "alice", amount: 10, oddChips: 0 }],
          },
        ],
        evaluatedHands: [
          {
            playerId: "alice",
            handRank: {
              category: 2,
              tiebreakers: [14, 11, 7],
              bestFive: [...board],
            },
          },
          {
            playerId: "bob",
            handRank: {
              category: 1,
              tiebreakers: [9],
              bestFive: [...board],
            },
          },
        ],
        totalPayouts: [
          { playerId: "alice", amount: 25 },
          { playerId: "bob", amount: 15 },
        ],
        finalStacks: [],
        totalContribution: 40,
        totalRefund: 0,
        totalPotAmount: 40,
        totalPotPayout: 40,
        totalStartingStacks: 200,
        totalFinalStacks: 200,
      },
      revealedHoleCards: [
        { playerId: "alice", cards: [{ rank: 14, suit: "s" }, { rank: 11, suit: "c" }], reason: "SHOWDOWN" },
        { playerId: "bob", cards: [{ rank: 9, suit: "s" }, { rank: 9, suit: "d" }], reason: "SHOWDOWN" },
      ],
    },
  };
}

describe("TableShell", () => {
  it("renders all six stable seats, public state, host, and current actor", () => {
    render(
      <TableShell
        projection={projectionFixture()}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.getAllByTestId(/^seat-/)).toHaveLength(6);
    expect(screen.getByText("Alice")).toBeInTheDocument();
    expect(screen.getByText("Bob")).toBeInTheDocument();
    expect(screen.getByText("房主")).toBeInTheDocument();
    expect(screen.getByText("行动中")).toBeInTheDocument();
    expect(screen.getByText("掉线")).toBeInTheDocument();
    expect(screen.getByText("翻牌 · 下注中")).toBeInTheDocument();
    expect(screen.getByText("当前底池")).toBeInTheDocument();
    expect(screen.getByText("34")).toBeInTheDocument();
    const board = screen.getByLabelText("公共牌");
    expect(within(board).getByLabelText("A♠")).toBeInTheDocument();
    expect(within(board).getByLabelText("K♥")).toBeInTheDocument();
    expect(within(board).getByLabelText("2♣")).toBeInTheDocument();
  });

  it("keeps the authoritative previous action beside the separate current-turn display", () => {
    const lastRaise: PublicActionRecord = {
      type: "ACTION",
      playerId: "bob",
      sequence: 2,
      street: "PREFLOP",
      requestedType: "RAISE",
      semantic: "RAISE",
      amountCommitted: 10,
      toContribution: 12,
      isAllIn: false,
      isFullBetOrRaise: true,
    };
    const view = render(
      <TableShell
        projection={projectionFixture({
          currentHand: { ...projectionFixture().currentHand!, actions: [lastRaise] },
        })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("上一动作")).toHaveTextContent("翻牌前 · Bob · 加注至 12");
    expect(screen.getByText("轮到 Alice")).toBeInTheDocument();

    view.rerender(
      <TableShell
        projection={projectionFixture({
          currentHand: { ...projectionFixture().currentHand!, street: "TURN", board: [...projectionFixture().currentHand!.board, { rank: 4, suit: "s" }], actions: [lastRaise] },
        })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );
    expect(screen.getByLabelText("上一动作")).toHaveTextContent("翻牌前 · Bob · 加注至 12");

    view.rerender(
      <TableShell
        projection={projectionFixture({
          currentHand: { ...projectionFixture().currentHand!, handId: "hand-2", actions: [] },
        })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("上一动作")).not.toBeInTheDocument();
  });

  it("renders the final completed-hand action between hands and clears it for the next hand", () => {
    const completed = resultFixture();
    const finalFold: PublicActionRecord = {
      type: "ACTION",
      playerId: "bob",
      sequence: 6,
      street: "RIVER",
      requestedType: "FOLD",
      semantic: "FOLD",
      amountCommitted: 0,
      toContribution: 0,
      isAllIn: false,
      isFullBetOrRaise: false,
    };
    const betweenHands = projectionFixture({
      status: "BETWEEN_HANDS",
      session: { ...projectionFixture().session!, completedHandCount: completed.handNumber },
      currentHand: null,
      seats: [null, null, null, null, null, null],
      spectators: [],
      recentHands: [{ ...completed, record: { ...completed.record, actions: [finalFold] } }],
    });
    const view = render(
      <TableShell
        projection={betweenHands}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.getByLabelText("上一动作")).toHaveTextContent("河牌 · Bob · 弃牌");

    view.rerender(
      <TableShell
        projection={projectionFixture({
          currentHand: { ...projectionFixture().currentHand!, handId: "hand-9", actions: [] },
          recentHands: betweenHands.recentHands,
        })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );
    expect(screen.queryByLabelText("上一动作")).not.toBeInTheDocument();
  });

  it("puts each manual host progression command in the single Action Dock", () => {
    const onCommand = vi.fn();
    const cases = [
      { status: "NO_SESSION" as const, label: "开始本场", command: "START_SESSION" as const },
      { status: "SESSION_WAITING_FOR_FIRST_HAND" as const, label: "开始第一手", command: "START_FIRST_HAND" as const },
      { status: "BETWEEN_HANDS" as const, label: "开始下一手", command: "START_NEXT_HAND" as const },
    ];

    for (const { status, label, command } of cases) {
      const view = render(
        <TableShell
          projection={projectionFixture({ status, currentHand: null })}
          viewerId="alice"
          phase="CONNECTED"
          pendingCommand={null}
          notice={null}
          onCommand={onCommand}
        />,
      );
      const actionDock = screen.getByLabelText("行动区");
      expect(within(actionDock).getByRole("button", { name: label })).toBeInTheDocument();
      expect(screen.getAllByRole("button", { name: label })).toHaveLength(1);
      fireEvent.click(within(actionDock).getByRole("button", { name: label }));
      expect(onCommand).toHaveBeenLastCalledWith({ type: command });
      view.unmount();
    }
  });

  it("lets the host start a new Session after the previous Session ended", () => {
    const onCommand = vi.fn();
    render(
      <TableShell
        projection={projectionFixture({ status: "SESSION_ENDED", currentHand: null })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={onCommand}
      />,
    );

    const actionDock = screen.getByLabelText("行动区");
    expect(within(actionDock).getAllByRole("button", { name: "开始本场" })).toHaveLength(1);
    fireEvent.click(within(actionDock).getByRole("button", { name: "开始本场" }));
    expect(onCommand).toHaveBeenLastCalledWith({ type: "START_SESSION" });
  });

  it("uses playerId, not nickname or seat, for host progression and waiting copy", () => {
    const hostView = render(
      <TableShell
        projection={projectionFixture({ status: "NO_SESSION", currentHand: null })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );
    expect(within(screen.getByLabelText("行动区")).getByRole("button", { name: "开始本场" })).toBeInTheDocument();
    hostView.unmount();

    const transferred = projectionFixture({
      status: "NO_SESSION",
      currentHand: null,
      hostPlayerId: "bob",
      seats: [
        projectionFixture().seats[0] ?? null,
        null,
        { ...projectionFixture().seats[2]!, nickname: "Alice" },
        null,
        null,
        null,
      ],
    });
    const transferredView = render(
      <TableShell
        projection={transferred}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );
    const actionDock = screen.getByLabelText("行动区");
    expect(within(actionDock).getByText("等待房主开始本场")).toBeInTheDocument();
    expect(within(actionDock).queryByRole("button", { name: "开始本场" })).not.toBeInTheDocument();
    expect(screen.queryByText("等待房主开牌")).not.toBeInTheDocument();
    transferredView.unmount();

    const spectatorHost = projectionFixture({
      status: "NO_SESSION",
      currentHand: null,
      seats: [null, null, null, null, null, null],
      hostPlayerId: "alice",
      spectators: [{ ...projectionFixture().spectators[0]!, playerId: "alice", nickname: "Alice" }],
    });
    const spectatorView = render(
      <TableShell
        projection={spectatorHost}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );
    expect(within(screen.getByLabelText("行动区")).getByRole("button", { name: "开始本场" })).toBeInTheDocument();
    spectatorView.unmount();
  });

  it("keeps optional uncontested reveal beside host progression and clears it on the next hand", () => {
    const onCommand = vi.fn();
    const hostProjection = projectionFixture({
      status: "BETWEEN_HANDS",
      currentHand: null,
      viewerCanRevealUncontested: true,
    });
    const hostView = render(
      <TableShell
        projection={hostProjection}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={onCommand}
      />,
    );

    const hostActionDock = screen.getByLabelText("行动区");
    expect(within(hostActionDock).getByRole("button", { name: "开始下一手" })).toBeInTheDocument();
    expect(within(hostActionDock).getByRole("button", { name: "亮牌" })).toBeInTheDocument();
    fireEvent.click(within(hostActionDock).getByRole("button", { name: "开始下一手" }));
    expect(onCommand).toHaveBeenLastCalledWith({ type: "START_NEXT_HAND" });
    fireEvent.click(within(hostActionDock).getByRole("button", { name: "亮牌" }));
    expect(onCommand).toHaveBeenLastCalledWith({ type: "REVEAL_UNCONTESTED" });

    hostView.rerender(
      <TableShell
        projection={projectionFixture({ status: "HAND_IN_PROGRESS", viewerCanRevealUncontested: false })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={onCommand}
      />,
    );
    expect(screen.queryByRole("button", { name: "亮牌" })).not.toBeInTheDocument();
    hostView.unmount();

    const nonHostProjection = projectionFixture({
      status: "BETWEEN_HANDS",
      currentHand: null,
      hostPlayerId: "bob",
      viewerCanRevealUncontested: true,
    });
    render(
      <TableShell
        projection={nonHostProjection}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={onCommand}
      />,
    );
    const nonHostActionDock = screen.getByLabelText("行动区");
    expect(within(nonHostActionDock).getByRole("button", { name: "亮牌" })).toBeInTheDocument();
    expect(within(nonHostActionDock).getByText("等待房主开始下一手")).toBeInTheDocument();
    expect(within(nonHostActionDock).queryByRole("button", { name: "开始下一手" })).not.toBeInTheDocument();
  });

  it("shows status-specific waiting copy to non-hosts for every manual progression stage", () => {
    const cases = [
      { status: "NO_SESSION" as const, waiting: "等待房主开始本场", start: "开始本场" },
      { status: "SESSION_ENDED" as const, waiting: "等待房主开始本场", start: "开始本场" },
      { status: "SESSION_WAITING_FOR_FIRST_HAND" as const, waiting: "等待房主开始第一手", start: "开始第一手" },
      { status: "BETWEEN_HANDS" as const, waiting: "等待房主开始下一手", start: "开始下一手" },
    ];

    for (const { status, waiting, start } of cases) {
      const view = render(
        <TableShell
          projection={projectionFixture({ status, currentHand: null, hostPlayerId: "bob" })}
          viewerId="alice"
          phase="CONNECTED"
          pendingCommand={null}
          notice={null}
          onCommand={vi.fn()}
        />,
      );
      const actionDock = screen.getByLabelText("行动区");
      expect(within(actionDock).getByText(waiting)).toBeInTheDocument();
      expect(within(actionDock).queryByRole("button", { name: start })).not.toBeInTheDocument();
      view.unmount();
    }
  });

  it("only renders the supplied viewer cards and never invents another player's cards", () => {
    render(
      <TableShell
        projection={projectionFixture()}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );

    const ownCards = screen.getByLabelText("你的底牌");
    expect(within(ownCards).getByLabelText("A♥")).toBeInTheDocument();
    expect(within(ownCards).getByLabelText("A♦")).toBeInTheDocument();
    expect(screen.queryByLabelText("Q♣")).not.toBeInTheDocument();
    expect(screen.getByText("你的牌")).toBeInTheDocument();
    expect(screen.queryByText("我的位置")).not.toBeInTheDocument();
  });

  it("renders undealt community cards as empty board slots, not hidden cards", () => {
    const projection = projectionFixture();
    const currentHand = projection.currentHand;
    if (currentHand === null) throw new Error("current hand fixture is required");

    render(
      <TableShell
        projection={{
          ...projection,
          currentHand: { ...currentHand, street: "PREFLOP", board: [] },
        }}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.queryByLabelText("隐藏底牌")).not.toBeInTheDocument();
    expect(screen.getAllByLabelText("尚未发出的公共牌")).toHaveLength(5);
  });

  it("sends SIT only after an empty seat is clicked", () => {
    const onCommand = vi.fn();
    render(
      <TableShell
        projection={projectionFixture({ ownHoleCards: null })}
        viewerId="watcher"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={onCommand}
      />,
    );

    const emptySeat = within(screen.getByTestId("seat-1"));
    expect(emptySeat.getByText("空座")).toBeInTheDocument();
    const sitButton = emptySeat.getByRole("button", { name: "坐下" });
    fireEvent.click(sitButton);
    expect(onCommand).toHaveBeenCalledWith({ type: "SIT", seat: 1 });
    expect(screen.getByText("当前没有可展示的私人底牌")).toBeInTheDocument();
  });

  it("renders only the viewer's projected legal actions and amount boundaries", () => {
    render(
      <TableShell
        projection={projectionFixture({
          viewerLegalActions: {
            playerId: "alice",
            canFold: true,
            canCheck: false,
            canCall: true,
            callAmount: 4,
            callIsAllIn: false,
            canBet: false,
            minimumBet: null,
            maximumBet: null,
            canRaise: true,
            minimumRaiseTo: 12,
            maximumRaiseTo: 94,
            raiseRightsOpen: true,
            canAllIn: true,
            allInTo: 96,
          },
        })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        uncertainCommand={null}
        notice={null}
        onRetryUncertain={vi.fn()}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /弃牌/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /跟注 4/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /加注 Raise/ })).toBeInTheDocument();
    expect(screen.getByText(/最低 12 · 最高 94/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^过牌/ })).not.toBeInTheDocument();
  });

  it("renders the projected Check, Bet, and All-in actions without inventing legality", () => {
    render(
      <TableShell
        projection={projectionFixture({
          viewerLegalActions: {
            playerId: "alice",
            canFold: true,
            canCheck: true,
            canCall: false,
            callAmount: 0,
            callIsAllIn: false,
            canBet: true,
            minimumBet: 2,
            maximumBet: 94,
            canRaise: false,
            minimumRaiseTo: null,
            maximumRaiseTo: null,
            raiseRightsOpen: true,
            canAllIn: true,
            allInTo: 94,
          },
        })}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /过牌 Check/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /下注 Bet/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /全下 94/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /跟注/ })).not.toBeInTheDocument();
  });

  it("keeps Session stage controls manual and shows the authoritative end preview", async () => {
    const projection = projectionFixture({ status: "BETWEEN_HANDS", currentHand: null });
    const previewProjection = { ...projection, version: projection.version + 1 };
    const onCommand = vi.fn(async (command: M11Command): Promise<CommandResult | null> => {
      if (command.type !== "PREPARE_END_SESSION") return null;
      return {
        status: "APPLIED",
        commandId: "prepare-end",
        version: previewProjection.version,
        data: {
          kind: "SESSION_END_PREVIEW",
          preview: {
            sessionId: "session-1",
            completedHandCount: 3,
            participantPlayerIds: ["alice", "bob"],
            finalChipBalances: { alice: 94, bob: 72 },
          },
        },
        projection: previewProjection,
      };
    });

    render(
      <TableShell
        projection={projection}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={onCommand}
      />,
    );

    expect(screen.getByRole("button", { name: /^开始下一手$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /^房主管理 打开$/ }));
    expect(screen.getByLabelText("小盲")).toHaveValue(1);
    expect(screen.getByLabelText("大盲")).toHaveValue(2);
    expect(screen.getByRole("button", { name: /^准备结束本场$/ })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: /^准备结束本场$/ }));
    await waitFor(() => expect(screen.getByRole("dialog", { name: "结束本场确认" })).toBeInTheDocument());
    expect(screen.getByText("已完成 3 手")).toBeInTheDocument();
    expect(screen.getByText("Alice：94")).toBeInTheDocument();
    expect(onCommand).toHaveBeenCalledWith({ type: "PREPARE_END_SESSION" });
  });

  it("renders one persistent game-style reaction popup with close and Escape behavior", () => {
    const onReactionEggClose = vi.fn();
    const baseProps = {
      projection: projectionFixture(),
      viewerId: "alice",
      phase: "CONNECTED" as const,
      pendingCommand: null,
      notice: null,
      onCommand: vi.fn(),
      onReactionEggClose,
    };
    const view = render(<TableShell {...baseProps} reactionEggVisible={false} />);
    const reactionButton = screen.getByRole("button", { name: "发送表情😂" });
    reactionButton.focus();

    view.rerender(<TableShell {...baseProps} reactionEggVisible />);

    expect(screen.getAllByRole("dialog", { name: "你急了" })).toHaveLength(1);
    expect(screen.getByText("你急了")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "关闭“你急了”提示" })).toBeInTheDocument();
    expect(document.activeElement).toBe(screen.getByRole("heading", { name: "你急了" }));

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onReactionEggClose).toHaveBeenCalledTimes(1);

    view.rerender(<TableShell {...baseProps} reactionEggVisible={false} />);
    expect(document.activeElement).toBe(reactionButton);

    view.rerender(<TableShell {...baseProps} reactionEggVisible />);
    fireEvent.click(screen.getByRole("button", { name: "关闭“你急了”提示" }));
    expect(onReactionEggClose).toHaveBeenCalledTimes(2);
  });

  it("renders a non-blocking street reveal with only the newly dealt cards", () => {
    vi.useFakeTimers();
    const onComplete = vi.fn();
    try {
      render(
        <TableShell
          projection={projectionFixture()}
          viewerId="alice"
          phase="CONNECTED"
          pendingCommand={null}
          notice={null}
          onCommand={vi.fn()}
          streetReveal={{
            key: "hand-1:TURN:4s",
            handId: "hand-1",
            street: "TURN",
            cards: [{ rank: 4, suit: "s" }],
          }}
          onStreetRevealComplete={onComplete}
        />,
      );

      const reveal = screen.getByTestId("street-reveal");
      expect(reveal).toHaveAccessibleName("转牌公共牌揭示");
      expect(within(reveal).getByLabelText("4♠")).toBeInTheDocument();
      expect(within(reveal).queryByLabelText("A♠")).not.toBeInTheDocument();
      vi.advanceTimersByTime(STREET_REVEAL_DURATION_MS);
      expect(onComplete).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("remounts each street reveal when staged runout updates arrive before 820ms", () => {
    const baseProps = {
      projection: projectionFixture(),
      viewerId: "alice",
      phase: "CONNECTED" as const,
      pendingCommand: null,
      notice: null,
      onCommand: vi.fn(),
    };
    const view = render(
      <TableShell
        {...baseProps}
        streetReveal={{
          key: "hand-1:FLOP:2c,7d,Jh",
          handId: "hand-1",
          street: "FLOP",
          cards: [
            { rank: 2, suit: "c" },
            { rank: 7, suit: "d" },
            { rank: 11, suit: "h" },
          ],
        }}
      />,
    );
    const flop = screen.getByTestId("street-reveal");

    view.rerender(
      <TableShell
        {...baseProps}
        streetReveal={{
          key: "hand-1:TURN:4s",
          handId: "hand-1",
          street: "TURN",
          cards: [{ rank: 4, suit: "s" }],
        }}
      />,
    );
    const turn = screen.getByTestId("street-reveal");
    expect(turn).not.toBe(flop);
    expect(within(turn).getByLabelText("4♠")).toBeInTheDocument();

    view.rerender(
      <TableShell
        {...baseProps}
        streetReveal={{
          key: "hand-1:RIVER:Ac",
          handId: "hand-1",
          street: "RIVER",
          cards: [{ rank: 14, suit: "c" }],
        }}
      />,
    );
    const river = screen.getByTestId("street-reveal");
    expect(river).not.toBe(turn);
    expect(within(river).getByLabelText("A♣")).toBeInTheDocument();
  });

  it("keeps the authoritative multi-pot result visible and exposes only revealed cards", () => {
    const onClose = vi.fn();
    render(
      <TableShell
        projection={projectionFixture()}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
        handResult={resultFixture()}
        onHandResultClose={onClose}
      />,
    );

    const result = screen.getByTestId("hand-result");
    expect(within(result).getByText("多人分池结算")).toBeInTheDocument();
    expect(within(result).getByText("边池 1")).toBeInTheDocument();
    expect(within(result).getByText("Alice +25")).toBeInTheDocument();
    expect(within(result).getByText("Bob +15")).toBeInTheDocument();
    expect(within(result).queryByLabelText("未跟注筹码退回")).not.toBeInTheDocument();
    expect(within(result).getByText("两对")).toBeInTheDocument();
    expect(within(result).getByLabelText("Alice 的公开底牌")).toBeInTheDocument();
    expect(within(result).queryByLabelText("Q♣")).not.toBeInTheDocument();

    fireEvent.click(within(result).getByRole("button", { name: "关闭本手结果" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("renders authoritative refunds separately from pot winnings", () => {
    const result = resultFixture();
    const settlement = result.record.settlement;
    if (settlement === null) throw new Error("result fixture settlement is required");
    const resultWithRefund = {
      ...result,
      record: {
        ...result.record,
        settlement: {
          ...settlement,
          refunds: [
            { playerId: "bob", amount: 50 },
            { playerId: "alice", amount: 0 },
          ],
        },
      },
    };

    render(
      <TableShell
        projection={projectionFixture()}
        viewerId="alice"
        phase="CONNECTED"
        pendingCommand={null}
        notice={null}
        onCommand={vi.fn()}
        handResult={resultWithRefund}
      />,
    );

    const refunds = screen.getByLabelText("未跟注筹码退回");
    expect(within(refunds).getByText("Bob")).toBeInTheDocument();
    expect(within(refunds).getByText("+50")).toBeInTheDocument();
    expect(within(refunds).queryByText("+0")).not.toBeInTheDocument();
    expect(within(refunds).getAllByRole("listitem")).toHaveLength(1);
    expect(screen.getByText("Alice +25")).toBeInTheDocument();
    expect(screen.getByText("Bob +15")).toBeInTheDocument();
  });
});
