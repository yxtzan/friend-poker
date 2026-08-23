import { afterEach, describe, expect, it } from "vitest";

import {
  NICKNAME_MAX_CODE_POINTS,
  validateNickname,
} from "../src/index.js";
import type { TransportFixture } from "./transport-helpers.js";
import {
  executeSocketCommand,
  connectWithCookie,
  createConnectedClient,
  createTransportFixture,
  enterIdentity,
  expectConnectionError,
  nextCommand,
  TEST_ORIGIN,
} from "./transport-helpers.js";
import { RuntimeCommandType } from "../src/index.js";

let fixture: TransportFixture | undefined;

afterEach(async () => {
  await fixture?.close();
  fixture = undefined;
});

describe("HTTP bootstrap, cookie, and origin policy", () => {
  it("serves only the permanent-table bootstrap and health endpoints", async () => {
    fixture = await createTransportFixture();
    const root = await fetch(`${fixture.url}/`);
    const health = await fetch(`${fixture.url}/health`);
    const rooms = await fetch(`${fixture.url}/rooms`);

    expect(await root.json()).toEqual({ service: "friend-poker", table: "permanent" });
    expect(await health.json()).toEqual({ status: "ok" });
    expect(rooms.status).toBe(404);
  });

  it("sets a browser-oriented HttpOnly credential cookie without returning it in JSON", async () => {
    fixture = await createTransportFixture();
    const entered = await enterIdentity(fixture, "Alice1", { kind: "SEAT", seat: 0 });
    const serializedBody = JSON.stringify(entered.body);

    expect(entered.status).toBe(201);
    expect(entered.setCookie).toMatch(/HttpOnly/iu);
    expect(entered.setCookie).toMatch(/SameSite=Strict/iu);
    expect(entered.setCookie).toMatch(/Path=\//u);
    expect(entered.setCookie).not.toMatch(/; Secure/iu);
    for (const credential of fixture.issuedCredentials) {
      expect(serializedBody).not.toContain(credential);
    }
  });

  it("serves only public seat occupancy and spectator capacity without identity", async () => {
    fixture = await createTransportFixture();
    const initial = await fetch(`${fixture.url}/identity/entry-status`, {
      headers: { Origin: TEST_ORIGIN },
    });
    const initialBody = (await initial.json()) as Record<string, unknown>;

    expect(initial.status).toBe(200);
    expect(initial.headers.get("cache-control")).toContain("no-store");
    expect(initialBody).toEqual({
      seats: [
        { seat: 0, occupied: false },
        { seat: 1, occupied: false },
        { seat: 2, occupied: false },
        { seat: 3, occupied: false },
        { seat: 4, occupied: false },
        { seat: 5, occupied: false },
      ],
      spectatorCount: 0,
      spectatorCapacity: 2,
    });

    const seated = await enterIdentity(fixture, "Hidden1", { kind: "SEAT", seat: 2 });
    await enterIdentity(fixture, "SpectatorOne", { kind: "SPECTATOR" });
    await enterIdentity(fixture, "SpectatorTwo", { kind: "SPECTATOR" });
    const refreshed = await fetch(`${fixture.url}/identity/entry-status`);
    const refreshedBody = (await refreshed.json()) as Record<string, unknown>;
    const serialized = JSON.stringify(refreshedBody);

    expect(seated.status).toBe(201);
    expect(refreshed.status).toBe(200);
    expect(refreshedBody).toMatchObject({ spectatorCount: 2, spectatorCapacity: 2 });
    expect((refreshedBody.seats as { seat: number; occupied: boolean }[])[2]).toEqual({
      seat: 2,
      occupied: true,
    });
    expect(serialized).not.toContain("Hidden1");
    expect(serialized).not.toContain("playerId");
    expect(Object.keys(refreshedBody).sort()).toEqual([
      "seats",
      "spectatorCapacity",
      "spectatorCount",
    ]);
  });

  it("adds Secure in production configuration and rejects an unlisted HTTP origin", async () => {
    fixture = await createTransportFixture({ secureCookies: true });
    const entered = await enterIdentity(fixture, "Secure1", { kind: "SPECTATOR" });
    const rejected = await fetch(`${fixture.url}/health`, {
      headers: { Origin: "https://evil.example" },
    });

    expect(entered.setCookie).toMatch(/; Secure/iu);
    expect(rejected.status).toBe(403);
    expect(rejected.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("echoes only an explicitly allowed credentialed origin", async () => {
    fixture = await createTransportFixture();
    const response = await fetch(`${fixture.url}/health`, { headers: { Origin: TEST_ORIGIN } });
    expect(response.headers.get("access-control-allow-origin")).toBe(TEST_ORIGIN);
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(response.headers.get("access-control-allow-methods")).toContain("POST");
    expect(response.headers.get("access-control-allow-headers")).toBe("Content-Type");
  });

  it("returns a sanitized JSON error for malformed HTTP JSON", async () => {
    fixture = await createTransportFixture();
    const response = await fetch(`${fixture.url}/identity/enter`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: TEST_ORIGIN },
      body: "{",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: "INVALID_HTTP_REQUEST",
      message: "Request could not be processed",
    });
  });

  it("rejects a Socket.IO handshake from an unlisted origin", async () => {
    fixture = await createTransportFixture();
    const entered = await enterIdentity(fixture, "OriginTest", { kind: "SPECTATOR" });
    const { io } = await import("socket.io-client");
    const socket = io(fixture.url, {
      autoConnect: false,
      transports: ["websocket"],
      extraHeaders: {
        Cookie: entered.cookie!,
        Origin: "https://evil.example",
      },
    });
    fixture.sockets.add(socket);
    const error = await new Promise<Error>((resolve) => {
      socket.once("connect_error", resolve);
      socket.connect();
    });
    expect(error).toBeInstanceOf(Error);
    expect(socket.connected).toBe(false);
  });
});

describe("nickname rules and recovery identity", () => {
  it.each(["小明", "Alice", "123456", "牌友A12"])("accepts supported nickname %s", (nickname) => {
    expect(validateNickname(nickname)).toEqual({ ok: true, nickname });
  });

  it("trims surrounding spaces and counts Unicode code points", () => {
    expect(validateNickname("  小明A1  ")).toEqual({ ok: true, nickname: "小明A1" });
    expect(validateNickname("牌".repeat(NICKNAME_MAX_CODE_POINTS))).toMatchObject({ ok: true });
    expect(validateNickname("牌".repeat(NICKNAME_MAX_CODE_POINTS + 1))).toMatchObject({
      ok: false,
      error: "NICKNAME_TOO_LONG",
    });
  });

  it.each(["", "   ", "Alice Smith", "Alice_1", "🙂"])(
    "rejects empty or unsupported nickname %j",
    (nickname) => {
      expect(validateNickname(nickname)).toMatchObject({ ok: false });
    },
  );

  it("rejects duplicate nickname without a credential and restores without renaming", async () => {
    fixture = await createTransportFixture();
    const first = await enterIdentity(fixture, "SameName", { kind: "SEAT", seat: 0 });
    const duplicate = await enterIdentity(fixture, "SameName", { kind: "SEAT", seat: 1 });
    const restored = await enterIdentity(
      fixture,
      "ChangedName",
      { kind: "SEAT", seat: 0 },
      { cookie: first.cookie! },
    );

    expect(duplicate).toMatchObject({
      status: 409,
      body: { error: "NICKNAME_UNAVAILABLE", message: "Nickname is unavailable" },
    });
    expect(restored).toMatchObject({
      status: 200,
      body: { status: "RESTORED", nickname: "SameName" },
    });
    expect((restored.body as { playerId: string }).playerId).toBe(
      (first.body as { playerId: string }).playerId,
    );
  });

  it("requires a valid credential before any Socket.IO identity binding", async () => {
    fixture = await createTransportFixture();
    expect(await expectConnectionError(fixture, "friend_poker_identity=invalid-token")).toBe(
      "AUTH_REQUIRED",
    );
  });

  it("allows only one healthy socket and permits reconnect after disconnect", async () => {
    fixture = await createTransportFixture();
    const client = await createConnectedClient(fixture, "Solo", { kind: "SEAT", seat: 0 });

    expect(await expectConnectionError(fixture, client.cookie)).toBe("DUPLICATE_CONNECTION");
    const firstStillControls = await executeSocketCommand(
      client.socket,
      nextCommand(client.latestProjection, "first-still-controls", {
        type: RuntimeCommandType.Sit,
        seat: 0,
      }),
    );
    expect(firstStillControls.status).toBe("NO_OP");
    client.socket.disconnect();
    const reconnected = await connectWithCookie(fixture, client.cookie);
    expect(reconnected.socket.connected).toBe(true);
    expect(reconnected.initialProjection.seats[0]?.playerId).toBe(client.identity.playerId);
  });

  it("keeps spectator identity while allowing a normal runtime seat command", async () => {
    fixture = await createTransportFixture();
    const spectator = await createConnectedClient(fixture, "SeatLater", {
      kind: "SPECTATOR",
    });
    const seated = await executeSocketCommand(
      spectator.socket,
      nextCommand(spectator.latestProjection, "spectator-sits", {
        type: RuntimeCommandType.Sit,
        seat: 3,
      }),
    );
    expect(seated).toMatchObject({
      status: "APPLIED",
      projection: {
        seats: expect.arrayContaining([
          expect.objectContaining({ playerId: spectator.identity.playerId, seat: 3 }),
        ]),
      },
    });
  });
});
