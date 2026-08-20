import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createPokerServer } from "../src/index.js";
import type { PokerServer } from "../src/index.js";

let server: PokerServer | undefined;
let temporaryDirectory: string | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
  if (temporaryDirectory !== undefined) {
    await rm(temporaryDirectory, { recursive: true, force: true });
    temporaryDirectory = undefined;
  }
});

async function createBuiltWebServer(): Promise<string> {
  temporaryDirectory = await mkdtemp(join(tmpdir(), "friend-poker-web-"));
  await mkdir(join(temporaryDirectory, "assets"));
  await writeFile(
    join(temporaryDirectory, "index.html"),
    "<!doctype html><html><body><div id=\"app\">Friend Poker build</div></body></html>",
  );
  await writeFile(join(temporaryDirectory, "assets", "app.js"), "console.log('friend-poker');");
  server = createPokerServer({
    allowedOrigins: ["http://test.friend-poker.local"],
    webDistPath: temporaryDirectory,
    requireWebBuild: true,
  });
  const listening = await server.listen();
  return listening.url;
}

describe("production same-origin Web serving", () => {
  it("serves the built index, assets, SPA routes, and health endpoint", async () => {
    const url = await createBuiltWebServer();

    const root = await fetch(`${url}/`);
    const asset = await fetch(`${url}/assets/app.js`);
    const clientRoute = await fetch(`${url}/session/summary`);
    const health = await fetch(`${url}/health`);

    expect(root.status).toBe(200);
    expect(root.headers.get("content-type")).toMatch(/text\/html/iu);
    expect(await root.text()).toContain("Friend Poker build");
    expect(asset.status).toBe(200);
    expect(await asset.text()).toContain("friend-poker");
    expect(clientRoute.status).toBe(200);
    expect(await clientRoute.text()).toContain("Friend Poker build");
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ status: "ok" });
  });

  it("does not let identity or Socket.IO routes fall through to the Web index", async () => {
    const url = await createBuiltWebServer();

    const identity = await fetch(`${url}/identity/enter`);
    const socketHandshake = await fetch(`${url}/socket.io/?EIO=4&transport=polling`);

    expect(identity.status).toBe(404);
    expect(await identity.text()).not.toContain("Friend Poker build");
    expect(socketHandshake.headers.get("content-type")).not.toMatch(/text\/html/iu);
    expect(await socketHandshake.text()).not.toContain("Friend Poker build");
  });

  it("fails clearly when a required production Web build is missing", async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "friend-poker-web-missing-"));

    expect(() =>
      createPokerServer({
        webDistPath: join(temporaryDirectory!, "dist"),
        requireWebBuild: true,
      }),
    ).toThrow(/Production Web build is missing.*npm run build/iu);
  });
});
