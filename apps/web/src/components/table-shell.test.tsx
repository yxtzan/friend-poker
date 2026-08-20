import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
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
});
