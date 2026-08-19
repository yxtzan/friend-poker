import { randomBytes } from "node:crypto";

import type { RandomSource } from "@friend-poker/poker-engine";
import { SingleTableRuntime } from "../runtime/runtime.js";
import { IdentityStore } from "../transport/identity.js";
import type { IdentityStoreOptions } from "../transport/identity.js";
import { createPokerServer } from "../transport/server.js";
import type { PokerServer, PokerServerOptions } from "../transport/server.js";
import { PrismaPersistenceRepository } from "./repository.js";
import { prepareCheckpointForProcessStart } from "./snapshot.js";

export interface PersistentPokerServerOptions extends Omit<
  PokerServerOptions,
  | "runtime"
  | "identityStore"
  | "persistenceRepository"
  | "initialSitInitialGrantCommands"
  | keyof IdentityStoreOptions
>, Pick<IdentityStoreOptions, "credentialGenerator" | "playerIdGenerator"> {
  readonly databaseUrl: string;
  readonly rngForHand?: (handId: string) => RandomSource;
}

export async function createPersistentPokerServer(
  options: PersistentPokerServerOptions,
): Promise<PokerServer> {
  const persistence = new PrismaPersistenceRepository(options.databaseUrl);
  try {
    await persistence.connect();
    const recovery = await persistence.loadOrBootstrap();
    const recoveredState = prepareCheckpointForProcessStart(
      recovery.tableState,
      recovery.identities,
    );
    const identities = new IdentityStore({
      ...(options.credentialGenerator === undefined
        ? {}
        : { credentialGenerator: options.credentialGenerator }),
      ...(options.playerIdGenerator === undefined
        ? {}
        : { playerIdGenerator: options.playerIdGenerator }),
      initialGeneration: recovery.identityGeneration,
      initialRecords: recovery.identities,
    });
    const runtime = new SingleTableRuntime({
      rngForHand:
        options.rngForHand ??
        (() => () => randomBytes(4).readUInt32BE(0) / 4_294_967_296),
      initialState: recoveredState,
      initialVersion: recovery.runtimeVersion + 1,
      initialProcessedCommands: recovery.processedCommands,
    });
    await persistence.commit({
      tableState: runtime.exportDurableCheckpointState(),
      runtimeVersion: runtime.version,
      identityGeneration: identities.generation,
      identities: identities.durableRecords(),
    });
    return createPokerServer({
      ...(options.allowedOrigins === undefined
        ? {}
        : { allowedOrigins: options.allowedOrigins }),
      ...(options.secureCookies === undefined
        ? {}
        : { secureCookies: options.secureCookies }),
      ...(options.cookieName === undefined ? {} : { cookieName: options.cookieName }),
      ...(options.lifecycleScheduler === undefined
        ? {}
        : { lifecycleScheduler: options.lifecycleScheduler }),
      ...(options.disconnectedTurnTimeoutMs === undefined
        ? {}
        : { disconnectedTurnTimeoutMs: options.disconnectedTurnTimeoutMs }),
      ...(options.hostDisconnectGraceMs === undefined
        ? {}
        : { hostDisconnectGraceMs: options.hostDisconnectGraceMs }),
      ...(options.allOfflineTimeoutMs === undefined
        ? {}
        : { allOfflineTimeoutMs: options.allOfflineTimeoutMs }),
      ...(options.runoutStageDelayMs === undefined
        ? {}
        : { runoutStageDelayMs: options.runoutStageDelayMs }),
      runtime,
      identityStore: identities,
      persistenceRepository: persistence,
      initialSitInitialGrantCommands: recovery.sitInitialGrantCommands,
    });
  } catch (error) {
    await persistence.close().catch(() => undefined);
    throw error;
  }
}
