import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { PlayerId } from "@friend-poker/poker-engine";

export const DEFAULT_IDENTITY_COOKIE_NAME = "friend_poker_identity";
const IDENTITY_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export type IdentityState = "ACTIVE" | "KICKED";

export interface IdentityRecord {
  readonly playerId: PlayerId;
  readonly nickname: string;
  readonly state: IdentityState;
}

export interface DurableIdentityRecord extends IdentityRecord {
  readonly credentialDigest: string | null;
  readonly generation: number;
}

interface MutableIdentityRecord {
  readonly playerId: PlayerId;
  readonly nickname: string;
  credentialDigest: string | null;
  readonly generation: number;
  state: IdentityState;
}

export interface IdentityStoreOptions {
  readonly credentialGenerator?: () => string;
  readonly playerIdGenerator?: () => PlayerId;
  readonly initialGeneration?: number;
  readonly initialRecords?: readonly DurableIdentityRecord[];
}

function defaultCredentialGenerator(): string {
  return randomBytes(32).toString("base64url");
}

function defaultPlayerIdGenerator(): PlayerId {
  return `player_${randomUUID()}`;
}

export function recoveryCredentialDigest(credential: string): string {
  return createHash("sha256").update(credential).digest("hex");
}

function publicRecord(record: MutableIdentityRecord): IdentityRecord {
  return Object.freeze({
    playerId: record.playerId,
    nickname: record.nickname,
    state: record.state,
  });
}

export class IdentityStore {
  readonly #credentialGenerator: () => string;
  readonly #playerIdGenerator: () => PlayerId;
  readonly #byPlayerId = new Map<PlayerId, MutableIdentityRecord>();
  readonly #playerIdByCredentialDigest = new Map<string, PlayerId>();
  readonly #playerIdByNickname = new Map<string, PlayerId>();
  readonly #issuedCredentialDigests = new Set<string>();
  #generation: number;

  public constructor(options: IdentityStoreOptions = {}) {
    this.#credentialGenerator = options.credentialGenerator ?? defaultCredentialGenerator;
    this.#playerIdGenerator = options.playerIdGenerator ?? defaultPlayerIdGenerator;
    this.#generation = options.initialGeneration ?? 1;
    if (!Number.isInteger(this.#generation) || this.#generation < 1) {
      throw new RangeError("Identity generation must be a positive integer");
    }
    for (const initial of options.initialRecords ?? []) {
      if (initial.generation !== this.#generation) {
        throw new Error("Durable identity belongs to a different generation");
      }
      if (this.#byPlayerId.has(initial.playerId) || this.#playerIdByNickname.has(initial.nickname)) {
        throw new Error("Durable identity records contain duplicate identity keys");
      }
      if (initial.state === "KICKED" && initial.credentialDigest !== null) {
        throw new Error("A kicked durable identity cannot retain a credential digest");
      }
      const record: MutableIdentityRecord = { ...initial };
      this.#byPlayerId.set(record.playerId, record);
      this.#playerIdByNickname.set(record.nickname, record.playerId);
      if (record.credentialDigest !== null) {
        if (this.#playerIdByCredentialDigest.has(record.credentialDigest)) {
          throw new Error("Durable identity records contain duplicate credential digests");
        }
        this.#playerIdByCredentialDigest.set(record.credentialDigest, record.playerId);
        this.#issuedCredentialDigests.add(record.credentialDigest);
      }
    }
  }

  public get generation(): number {
    return this.#generation;
  }

  public durableRecords(): readonly DurableIdentityRecord[] {
    return [...this.#byPlayerId.values()].map((record) => Object.freeze({
      ...publicRecord(record),
      credentialDigest: record.credentialDigest,
      generation: record.generation,
    }));
  }

  public findByCredential(credential: string | null): IdentityRecord | null {
    if (credential === null) return null;
    const playerId = this.#playerIdByCredentialDigest.get(recoveryCredentialDigest(credential));
    if (playerId === undefined) return null;
    const record = this.#byPlayerId.get(playerId);
    return record === undefined || record.state !== "ACTIVE" ? null : publicRecord(record);
  }

  public findByNickname(nickname: string): IdentityRecord | null {
    const playerId = this.#playerIdByNickname.get(nickname);
    if (playerId === undefined) return null;
    const record = this.#byPlayerId.get(playerId);
    return record === undefined ? null : publicRecord(record);
  }

  public create(nickname: string): { readonly record: IdentityRecord; readonly credential: string } {
    if (this.#playerIdByNickname.has(nickname)) throw new Error("Nickname is already registered");
    const playerId = this.#generateUniquePlayerId();
    const credential = this.#generateUniqueCredential();
    const credentialDigest = recoveryCredentialDigest(credential);
    const record: MutableIdentityRecord = {
      playerId,
      nickname,
      credentialDigest,
      generation: this.#generation,
      state: "ACTIVE",
    };
    this.#byPlayerId.set(playerId, record);
    this.#playerIdByNickname.set(nickname, playerId);
    this.#playerIdByCredentialDigest.set(credentialDigest, playerId);
    return Object.freeze({ record: publicRecord(record), credential });
  }

  public reissueAfterKick(playerId: PlayerId): {
    readonly record: IdentityRecord;
    readonly credential: string;
  } {
    const record = this.#byPlayerId.get(playerId);
    if (record === undefined || record.state !== "KICKED") {
      throw new Error("Identity is not eligible for kicked-player re-entry");
    }
    const credential = this.#generateUniqueCredential();
    const credentialDigest = recoveryCredentialDigest(credential);
    record.credentialDigest = credentialDigest;
    record.state = "ACTIVE";
    this.#playerIdByCredentialDigest.set(credentialDigest, playerId);
    return Object.freeze({ record: publicRecord(record), credential });
  }

  public revokeAfterKick(playerId: PlayerId): void {
    const record = this.#byPlayerId.get(playerId);
    if (record === undefined) return;
    if (record.credentialDigest !== null) {
      this.#playerIdByCredentialDigest.delete(record.credentialDigest);
    }
    record.credentialDigest = null;
    record.state = "KICKED";
  }

  public discardNewIdentity(playerId: PlayerId): void {
    const record = this.#byPlayerId.get(playerId);
    if (record === undefined) return;
    if (record.credentialDigest !== null) {
      this.#playerIdByCredentialDigest.delete(record.credentialDigest);
    }
    this.#playerIdByNickname.delete(record.nickname);
    this.#byPlayerId.delete(playerId);
  }

  /** Invalidates every current-Session credential while retaining issued-token history. */
  public invalidateSession(): void {
    this.#byPlayerId.clear();
    this.#playerIdByCredentialDigest.clear();
    this.#playerIdByNickname.clear();
    this.#generation += 1;
  }

  #generateUniqueCredential(): string {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const credential = this.#credentialGenerator();
      const digest = recoveryCredentialDigest(credential);
      if (credential.length >= 32 && !this.#issuedCredentialDigests.has(digest)) {
        this.#issuedCredentialDigests.add(digest);
        return credential;
      }
    }
    throw new Error("Could not generate a unique recovery credential");
  }

  #generateUniquePlayerId(): PlayerId {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const playerId = this.#playerIdGenerator();
      if (playerId.length > 0 && !this.#byPlayerId.has(playerId)) return playerId;
    }
    throw new Error("Could not generate a unique player identity");
  }
}

export function readCookie(
  cookieHeader: string | undefined,
  cookieName = DEFAULT_IDENTITY_COOKIE_NAME,
): string | null {
  if (cookieHeader === undefined) return null;
  for (const segment of cookieHeader.split(";")) {
    const separator = segment.indexOf("=");
    if (separator < 0) continue;
    const name = segment.slice(0, separator).trim();
    if (name !== cookieName) continue;
    try {
      return decodeURIComponent(segment.slice(separator + 1).trim());
    } catch {
      return null;
    }
  }
  return null;
}

export function serializeIdentityCookie(
  credential: string,
  options: { readonly cookieName?: string; readonly secure: boolean },
): string {
  const parts = [
    `${options.cookieName ?? DEFAULT_IDENTITY_COOKIE_NAME}=${encodeURIComponent(credential)}`,
    "Path=/",
    `Max-Age=${IDENTITY_COOKIE_MAX_AGE_SECONDS}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}
