import { createTableState } from "@friend-poker/poker-engine";
import type { TableState } from "@friend-poker/poker-engine";
import { PrismaClient } from "../generated/prisma/client.js";
import type { Prisma } from "../generated/prisma/client.js";
import type {
  RuntimeCommandData,
  RuntimeProcessedCommandRecord,
} from "../runtime/types.js";
import type { DurableIdentityRecord } from "../transport/identity.js";
import {
  DURABLE_SNAPSHOT_SCHEMA_VERSION,
  restoreDurableCheckpoint,
  serializeDurableCheckpoint,
} from "./snapshot.js";

const APPLICATION_STATE_ID = 1;
export const DURABLE_COMMAND_RETENTION_LIMIT = 4_096;

export interface PersistenceRecovery {
  readonly tableState: TableState;
  readonly runtimeVersion: number;
  readonly identityGeneration: number;
  readonly identities: readonly DurableIdentityRecord[];
  readonly processedCommands: readonly RuntimeProcessedCommandRecord[];
  readonly sitInitialGrantCommands: readonly {
    readonly playerId: string;
    readonly commandId: string;
    readonly includeInitialGrant: boolean;
  }[];
}

export interface DurableCommit {
  readonly tableState: TableState;
  readonly runtimeVersion: number;
  readonly identityGeneration: number;
  readonly identities: readonly DurableIdentityRecord[];
  readonly processedCommand?: RuntimeProcessedCommandRecord;
  readonly sitInitialGrant?: boolean;
  readonly pruneAllProcessedCommands?: boolean;
}

export interface VersionHighWaterCommit {
  readonly runtimeVersion: number;
  readonly identityGeneration?: number;
  readonly identities?: readonly DurableIdentityRecord[];
  readonly processedCommand?: RuntimeProcessedCommandRecord;
}

function parseCommandData(serialized: string): RuntimeCommandData {
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error("Durable processed-command data is not valid JSON");
  }
  if (typeof value !== "object" || value === null || !("kind" in value)) {
    throw new Error("Durable processed-command data is malformed");
  }
  if (value.kind === "NONE") return Object.freeze({ kind: "NONE" });
  if (
    value.kind !== "SESSION_END_PREVIEW" ||
    !("preview" in value) ||
    typeof value.preview !== "object" ||
    value.preview === null
  ) {
    throw new Error("Durable processed-command data has an unsupported kind");
  }
  const preview = value.preview as Record<string, unknown>;
  if (
    typeof preview.sessionId !== "string" ||
    !Number.isInteger(preview.completedHandCount) ||
    !Array.isArray(preview.participantPlayerIds) ||
    !preview.participantPlayerIds.every((entry) => typeof entry === "string") ||
    typeof preview.finalChipBalances !== "object" ||
    preview.finalChipBalances === null ||
    !Object.values(preview.finalChipBalances).every(
      (entry) => Number.isInteger(entry) && (entry as number) >= 0,
    )
  ) {
    throw new Error("Durable Session-end preview is malformed");
  }
  return structuredClone(value) as RuntimeCommandData;
}

function parseIdentity(input: {
  readonly playerId: string;
  readonly nickname: string;
  readonly state: string;
  readonly credentialDigest: string | null;
  readonly generation: number;
}): DurableIdentityRecord {
  if (
    input.playerId.length === 0 ||
    input.nickname.length === 0 ||
    (input.state !== "ACTIVE" && input.state !== "KICKED") ||
    !Number.isInteger(input.generation) ||
    input.generation < 1 ||
    (input.credentialDigest !== null && !/^[a-f0-9]{64}$/u.test(input.credentialDigest)) ||
    (input.state === "ACTIVE" && input.credentialDigest === null) ||
    (input.state === "KICKED" && input.credentialDigest !== null)
  ) {
    throw new Error("Durable identity record is malformed");
  }
  return Object.freeze({ ...input, state: input.state });
}

function playerIdFromPrincipalKey(principalKey: string): string | null {
  return principalKey.startsWith("PLAYER:") ? principalKey.slice("PLAYER:".length) : null;
}

export class PrismaPersistenceRepository {
  readonly #prisma: PrismaClient;

  public constructor(databaseUrl: string) {
    if (!databaseUrl.startsWith("file:")) {
      throw new Error("Milestone 9 supports only SQLite file: DATABASE_URL values");
    }
    this.#prisma = new PrismaClient({ datasourceUrl: databaseUrl });
  }

  public async connect(): Promise<void> {
    await this.#prisma.$connect();
  }

  public async close(): Promise<void> {
    await this.#prisma.$disconnect();
  }

  public async loadOrBootstrap(): Promise<PersistenceRecovery> {
    const existing = await this.#prisma.applicationState.findUnique({
      where: { id: APPLICATION_STATE_ID },
    });
    if (existing === null) {
      const tableState = createTableState();
      await this.#prisma.applicationState.create({
        data: {
          id: APPLICATION_STATE_ID,
          snapshotSchema: DURABLE_SNAPSHOT_SCHEMA_VERSION,
          runtimeVersion: 0,
          identityGeneration: 1,
          snapshotJson: serializeDurableCheckpoint(tableState),
        },
      });
      return Object.freeze({
        tableState,
        runtimeVersion: 0,
        identityGeneration: 1,
        identities: [],
        processedCommands: [],
        sitInitialGrantCommands: [],
      });
    }
    if (existing.snapshotSchema !== DURABLE_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(`Unsupported durable snapshot schema ${existing.snapshotSchema}`);
    }
    if (
      !Number.isInteger(existing.runtimeVersion) ||
      existing.runtimeVersion < 0 ||
      !Number.isInteger(existing.identityGeneration) ||
      existing.identityGeneration < 1
    ) {
      throw new Error("Durable application-state metadata is malformed");
    }
    const [identityRows, commandRows] = await Promise.all([
      this.#prisma.identity.findMany({
        where: { generation: existing.identityGeneration },
        orderBy: { playerId: "asc" },
      }),
      this.#prisma.processedCommand.findMany({
        orderBy: [{ originalVersion: "asc" }, { commandId: "asc" }],
      }),
    ]);
    const identities = identityRows.map(parseIdentity);
    const processedCommands = commandRows.map((row) => {
      if (
        row.commandId.length === 0 ||
        row.principalKey.length === 0 ||
        row.fingerprint.length === 0 ||
        !Number.isInteger(row.originalVersion) ||
        row.originalVersion < 0 ||
        (row.originalStatus !== "APPLIED" && row.originalStatus !== "NO_OP")
      ) {
        throw new Error("Durable processed-command record is malformed");
      }
      return Object.freeze({
        commandId: row.commandId,
        principalKey: row.principalKey,
        fingerprint: row.fingerprint,
        originalVersion: row.originalVersion,
        originalStatus: row.originalStatus,
        data: parseCommandData(row.dataJson),
      }) satisfies RuntimeProcessedCommandRecord;
    });
    const sitInitialGrantCommands = commandRows.flatMap((row) => {
      if (row.sitInitialGrant === null) return [];
      const playerId = playerIdFromPrincipalKey(row.principalKey);
      if (playerId === null || playerId.length === 0) {
        throw new Error("Durable SIT enrichment has no player principal");
      }
      return [{
        playerId,
        commandId: row.commandId,
        includeInitialGrant: row.sitInitialGrant,
      }];
    });
    return Object.freeze({
      tableState: restoreDurableCheckpoint(existing.snapshotJson),
      runtimeVersion: existing.runtimeVersion,
      identityGeneration: existing.identityGeneration,
      identities,
      processedCommands,
      sitInitialGrantCommands,
    });
  }

  public async commit(input: DurableCommit): Promise<void> {
    const snapshotJson = serializeDurableCheckpoint(input.tableState);
    await this.#prisma.$transaction(async (transaction) => {
      await transaction.applicationState.update({
        where: { id: APPLICATION_STATE_ID },
        data: {
          snapshotSchema: DURABLE_SNAPSHOT_SCHEMA_VERSION,
          runtimeVersion: input.runtimeVersion,
          identityGeneration: input.identityGeneration,
          snapshotJson,
        },
      });
      await transaction.identity.deleteMany();
      if (input.identities.length > 0) {
        await transaction.identity.createMany({ data: [...input.identities] });
      }
      if (input.pruneAllProcessedCommands === true) {
        await transaction.processedCommand.deleteMany();
      } else if (input.processedCommand !== undefined) {
        await transaction.processedCommand.create({
          data: {
            commandId: input.processedCommand.commandId,
            principalKey: input.processedCommand.principalKey,
            fingerprint: input.processedCommand.fingerprint,
            originalVersion: input.processedCommand.originalVersion,
            originalStatus: input.processedCommand.originalStatus,
            dataJson: JSON.stringify(input.processedCommand.data),
            ...(input.sitInitialGrant === undefined
              ? {}
              : { sitInitialGrant: input.sitInitialGrant }),
          },
        });
        await this.#pruneProcessedCommands(transaction);
      }
    });
  }

  public async commitVersionHighWater(input: VersionHighWaterCommit): Promise<void> {
    const includesIdentities =
      input.identityGeneration !== undefined && input.identities !== undefined;
    if ((input.identityGeneration === undefined) !== (input.identities === undefined)) {
      throw new Error("Identity generation and records must be committed together");
    }
    await this.#prisma.$transaction(async (transaction) => {
      await transaction.applicationState.update({
        where: { id: APPLICATION_STATE_ID },
        data: {
          runtimeVersion: input.runtimeVersion,
          ...(includesIdentities
            ? { identityGeneration: input.identityGeneration }
            : {}),
        },
      });
      if (includesIdentities) {
        await transaction.identity.deleteMany();
        if (input.identities.length > 0) {
          await transaction.identity.createMany({ data: [...input.identities] });
        }
      }
      if (input.processedCommand !== undefined) {
        await transaction.processedCommand.create({
          data: {
            commandId: input.processedCommand.commandId,
            principalKey: input.processedCommand.principalKey,
            fingerprint: input.processedCommand.fingerprint,
            originalVersion: input.processedCommand.originalVersion,
            originalStatus: input.processedCommand.originalStatus,
            dataJson: JSON.stringify(input.processedCommand.data),
          },
        });
        await this.#pruneProcessedCommands(transaction);
      }
    });
  }

  async #pruneProcessedCommands(transaction: Prisma.TransactionClient): Promise<void> {
    const expired = await transaction.processedCommand.findMany({
      orderBy: [{ originalVersion: "desc" }, { commandId: "desc" }],
      skip: DURABLE_COMMAND_RETENTION_LIMIT,
      select: { commandId: true },
    });
    if (expired.length > 0) {
      await transaction.processedCommand.deleteMany({
        where: { commandId: { in: expired.map(({ commandId }) => commandId) } },
      });
    }
  }
}
