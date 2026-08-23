import { useState } from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { EntryAvailability, EntryPosition } from "@friend-poker/shared";
import { EntryScreen } from "./entry-screen.js";
import type { TableAppState } from "../state/use-table-app.js";

function appFixture(overrides: Partial<TableAppState> = {}): TableAppState {
  return {
    phase: "ENTRY",
    identity: null,
    projection: null,
    nickname: "小明",
    position: { kind: "SPECTATOR" },
    entryAvailability: null,
    canReenterAfterKick: false,
    pendingCommand: null,
    uncertainCommand: null,
    notice: null,
    reactions: [],
    reactionEggVisible: false,
    closeReactionEgg: vi.fn(),
    streetReveal: null,
    clearStreetReveal: vi.fn(),
    handResult: null,
    closeHandResult: vi.fn(),
    soundEnabled: false,
    setNickname: vi.fn(),
    setPosition: vi.fn(),
    submitEntry: vi.fn(async () => undefined),
    submitCommand: vi.fn(async () => null),
    sendReaction: vi.fn(),
    setSoundEnabled: vi.fn(),
    retryUncertainCommand: vi.fn(async () => null),
    retry: vi.fn(),
    ...overrides,
  };
}

describe("EntryScreen", () => {
  it("shows nickname, six seats, spectator choice, and loading state", () => {
    const app = appFixture({ phase: "BOOTING" });
    render(<EntryScreen app={app} />);

    expect(screen.getByLabelText("你的名字")).toHaveValue("小明");
    expect(screen.getByLabelText("你的名字")).not.toHaveAttribute("maxLength");
    expect(screen.getAllByRole("button", { name: /座位/ })).toHaveLength(6);
    expect(screen.getByRole("button", { name: "旁观" })).toBeDisabled();
    expect(screen.getByText("正在恢复身份…")).toBeInTheDocument();
  });

  it("preserves the input and selected position while submitting", () => {
    const setNickname = vi.fn();
    const setPosition = vi.fn();
    const submitEntry = vi.fn(async () => undefined);

    function StatefulEntryScreen() {
      const [nickname, updateNickname] = useState("小明");
      const [position, updatePosition] = useState<EntryPosition>({ kind: "SPECTATOR" });
      return (
        <EntryScreen
          app={appFixture({
            nickname,
            position,
            setNickname: (value) => {
              setNickname(value);
              updateNickname(value);
            },
            setPosition: (value) => {
              setPosition(value);
              updatePosition(value);
            },
            submitEntry,
          })}
        />
      );
    }

    render(<StatefulEntryScreen />);

    fireEvent.change(screen.getByLabelText("你的名字"), { target: { value: "新朋友" } });
    fireEvent.click(screen.getByRole("button", { name: /座位 3/ }));
    const form = screen.getByRole("button", { name: /以「座位 3」进入/ }).closest("form");
    if (form === null) throw new Error("entry form not found");
    fireEvent.submit(form);

    expect(setNickname).toHaveBeenCalledWith("新朋友");
    expect(setPosition).toHaveBeenCalledWith({ kind: "SEAT", seat: 2 });
    expect(submitEntry).toHaveBeenCalledTimes(1);
  });

  it("marks occupied seats unavailable without exposing the occupant", () => {
    const availability: EntryAvailability = {
      seats: [
        { seat: 0, occupied: true },
        { seat: 1, occupied: false },
        { seat: 2, occupied: false },
        { seat: 3, occupied: false },
        { seat: 4, occupied: false },
        { seat: 5, occupied: false },
      ],
      spectatorCount: 1,
      spectatorCapacity: 2,
    };
    render(<EntryScreen app={appFixture({ entryAvailability: availability })} />);

    const occupiedSeat = screen.getByRole("button", { name: "座位 1 已有人" });
    expect(occupiedSeat).toBeDisabled();
    expect(occupiedSeat).toHaveAttribute("aria-disabled", "true");
    expect(screen.getByText("已有人")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "旁观 1 / 2" })).toBeEnabled();
    expect(screen.queryByText("小明")).not.toBeInTheDocument();
  });

  it("disables full spectator capacity and prevents a newly occupied selection from submitting", () => {
    const availability: EntryAvailability = {
      seats: [
        { seat: 0, occupied: true },
        { seat: 1, occupied: false },
        { seat: 2, occupied: false },
        { seat: 3, occupied: false },
        { seat: 4, occupied: false },
        { seat: 5, occupied: false },
      ],
      spectatorCount: 2,
      spectatorCapacity: 2,
    };
    const submitEntry = vi.fn(async () => undefined);
    render(
      <EntryScreen
        app={appFixture({
          entryAvailability: availability,
          position: { kind: "SEAT", seat: 0 },
          submitEntry,
        })}
      />,
    );

    expect(screen.getByRole("button", { name: "旁观 已满" })).toBeDisabled();
    expect(screen.getByText("当前选择已不可用，请换一个位置。")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /进入/ })).toBeDisabled();
    expect(submitEntry).not.toHaveBeenCalled();
  });
});
