import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import type { RandomSource } from "@friend-poker/poker-engine";

import { createPersistentPokerServer } from "../src/persistence/create-server.js";
import type { LifecycleScheduler } from "../src/index.js";
import type { TransportFixture } from "./transport-helpers.js";
import { TEST_ORIGIN } from "./transport-helpers.js";

const SERVER_ROOT = fileURLToPath(new URL("../", import.meta.url));
const INITIAL_MIGRATION = resolve(
  SERVER_ROOT,
  "prisma/migrations/20260820000000_milestone_9_persistence/migration.sql",
);

export function sqliteDatabaseUrl(databasePath: string): string {
  return `file:${databasePath.replaceAll("\\", "/")}`;
}

export function migrateTestDatabase(databaseUrl: string): void {
  if (!databaseUrl.startsWith("file:")) throw new Error("Expected a SQLite file URL");
  const database = new DatabaseSync(databaseUrl.slice("file:".length));
  try {
    database.exec(readFileSync(INITIAL_MIGRATION, "utf8"));
  } finally {
    database.close();
  }
}

function seededRandom(seed: number): RandomSource {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function hashText(value: string): number {
  let hash = 0x811c9dc5;
  for (const character of value) {
    hash ^= character.codePointAt(0)!;
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export interface PersistentFixtureFactory {
  readonly databasePath: string;
  readonly databaseUrl: string;
  readonly issuedCredentials: readonly string[];
  start(options?: PersistentFixtureStartOptions): Promise<TransportFixture>;
}

export interface PersistentFixtureStartOptions {
  readonly lifecycleScheduler?: LifecycleScheduler;
  readonly disconnectedTurnTimeoutMs?: number;
  readonly hostDisconnectGraceMs?: number;
  readonly allOfflineTimeoutMs?: number;
  readonly runoutStageDelayMs?: number;
}

export function persistentFixtureFactory(
  databasePath: string,
  options: { readonly credentials?: readonly string[] } = {},
): PersistentFixtureFactory {
  const databaseUrl = sqliteDatabaseUrl(databasePath);
  const issuedCredentials: string[] = [];
  let credentialSequence = 0;
  let playerSequence = 0;

  return Object.freeze({
    databasePath,
    databaseUrl,
    issuedCredentials,
    async start(startOptions: PersistentFixtureStartOptions = {}): Promise<TransportFixture> {
      const server = await createPersistentPokerServer({
        databaseUrl,
        allowedOrigins: [TEST_ORIGIN],
        secureCookies: false,
        credentialGenerator: () => {
          const configured = options.credentials?.[credentialSequence];
          credentialSequence += 1;
          const credential =
            configured ??
            `persistent-recovery-credential-${String(credentialSequence).padStart(16, "0")}`;
          issuedCredentials.push(credential);
          return credential;
        },
        playerIdGenerator: () => {
          playerSequence += 1;
          return `persistent-player-${playerSequence}`;
        },
        rngForHand: (handId) => seededRandom(hashText(handId)),
        ...(startOptions.lifecycleScheduler === undefined
          ? {}
          : { lifecycleScheduler: startOptions.lifecycleScheduler }),
        ...(startOptions.disconnectedTurnTimeoutMs === undefined
          ? {}
          : { disconnectedTurnTimeoutMs: startOptions.disconnectedTurnTimeoutMs }),
        ...(startOptions.hostDisconnectGraceMs === undefined
          ? {}
          : { hostDisconnectGraceMs: startOptions.hostDisconnectGraceMs }),
        ...(startOptions.allOfflineTimeoutMs === undefined
          ? {}
          : { allOfflineTimeoutMs: startOptions.allOfflineTimeoutMs }),
        ...(startOptions.runoutStageDelayMs === undefined
          ? {}
          : { runoutStageDelayMs: startOptions.runoutStageDelayMs }),
      });
      const listening = await server.listen();
      const sockets = new Set<TransportFixture["sockets"] extends Set<infer T> ? T : never>();
      return Object.freeze({
        server,
        url: listening.url,
        issuedCredentials,
        sockets,
        async close(): Promise<void> {
          for (const socket of sockets) socket.disconnect();
          await server.close();
        },
      });
    },
  });
}

export function databasePath(root: string): string {
  return join(root, "friend-poker.db");
}
