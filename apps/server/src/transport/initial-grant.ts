import { createHash } from "node:crypto";

import type { PlayerId } from "@friend-poker/poker-engine";

const CLIENT_SIT_INITIAL_GRANT_NAMESPACE = "friend-poker:transport:sit-initial-grant:v1";
const DEFAULT_CLIENT_SIT_INITIAL_GRANT_LIMIT = 4_096;

function clientCommandKey(playerId: PlayerId, commandId: string): string {
  return JSON.stringify([playerId, commandId]);
}

export function clientSitInitialGrantLedgerEntryId(
  playerId: PlayerId,
  commandId: string,
): string {
  const digest = createHash("sha256")
    .update(JSON.stringify([CLIENT_SIT_INITIAL_GRANT_NAMESPACE, playerId, commandId]))
    .digest("hex");
  return `transport-sit-initial-grant-${digest}`;
}

export class ClientSitInitialGrantRegistry {
  readonly #limit: number;
  readonly #inclusionByCommand = new Map<string, boolean>();

  public constructor(limit = DEFAULT_CLIENT_SIT_INITIAL_GRANT_LIMIT) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new RangeError("Client SIT initial-grant limit must be a positive integer");
    }
    this.#limit = limit;
  }

  public resolve(
    playerId: PlayerId,
    commandId: string,
    includeForFirstReception: boolean,
  ): boolean {
    const key = clientCommandKey(playerId, commandId);
    const existing = this.#inclusionByCommand.get(key);
    if (existing !== undefined) return existing;

    this.#inclusionByCommand.set(key, includeForFirstReception);
    while (this.#inclusionByCommand.size > this.#limit) {
      const oldest = this.#inclusionByCommand.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#inclusionByCommand.delete(oldest);
    }
    return includeForFirstReception;
  }

  public seed(
    records: readonly {
      readonly playerId: PlayerId;
      readonly commandId: string;
      readonly includeInitialGrant: boolean;
    }[],
  ): void {
    for (const record of records) {
      const key = clientCommandKey(record.playerId, record.commandId);
      if (this.#inclusionByCommand.has(key)) {
        throw new Error("Duplicate durable SIT enrichment record");
      }
      this.#inclusionByCommand.set(key, record.includeInitialGrant);
    }
    while (this.#inclusionByCommand.size > this.#limit) {
      const oldest = this.#inclusionByCommand.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.#inclusionByCommand.delete(oldest);
    }
  }
}
