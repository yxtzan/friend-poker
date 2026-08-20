import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CommandResult, M11Command } from "@friend-poker/shared";
import { TableShell } from "./table-shell.js";
import { projectionFixture } from "../test/fixtures.js";

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
});
