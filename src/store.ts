export interface RecoveryEntry {
  sessionID: string;
  providerID: string;
  modelID: string;
  directory: string;
  heldAt: string;
  origin?: RecoveryOrigin;
}

export type RecoveryOrigin = "retry-failure" | "deferred" | "pending-title" | "pending-compaction";

export interface RecoveryDocument {
  schemaVersion: 1;
  entries: RecoveryEntry[];
}

/**
 * An explicit, session-scoped protection override. Absence means "follow the
 * client global"; `on` forces protection for this chat while the client
 * global is off, and `off` allows verified peak pricing for this chat while
 * the client global is on. The override is an explicit authorization for one
 * interactive session; it never turns an unverified (UNKNOWN) model into an
 * allowed request.
 */
export interface SessionProtectionOverride {
  protection: "on" | "off";
  updatedAt: string;
}

export interface SessionOverridesDocument {
  schemaVersion: 1;
  /** Keyed by OpenCode session ID. */
  sessions: Record<string, SessionProtectionOverride>;
}

/**
 * The two OpenCode clients this plugin can protect independently. A client is
 * an interactive origin, not a transport: the same OpenCode server can serve
 * both.
 */
export type OffpeakClient = "cli" | "desktop";

/** Case-insensitive storage form; the RPC and user interface render ON/OFF. */
export type ClientProtection = "on" | "off";

export interface ClientDefaults {
  cli: ClientProtection;
  desktop: ClientProtection;
}

/**
 * The clients that have opened a session, and the one that most recently did.
 * A chat follows the most recent client's global by default, so the switch in
 * the client the user is actually using takes effect. An explicit per-chat
 * override always wins over this default.
 */
export interface SessionClientOwnership {
  clients: OffpeakClient[];
  /** Last client that opened the session. */
  owner: OffpeakClient;
  updatedAt: string;
}

export interface ClientsDocument {
  schemaVersion: 1;
  defaults: ClientDefaults;
  /** Keyed by OpenCode session ID; absence means no client has registered it. */
  sessions: Record<string, SessionClientOwnership>;
}

export interface JsonStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const RECOVERY_STORAGE_KEY = "opencode-offpeak/recovery-v1";
export const SESSION_OVERRIDES_STORAGE_KEY = "opencode-offpeak/session-overrides-v1";
export const CLIENT_SETTINGS_STORAGE_KEY = "opencode-offpeak/clients-v1";

export function emptyRecovery(): RecoveryDocument {
  return { schemaVersion: 1, entries: [] };
}

export function emptySessionOverrides(): SessionOverridesDocument {
  return { schemaVersion: 1, sessions: {} };
}

/**
 * Both client defaults start ON. An installation that predates client
 * settings therefore keeps exactly the protection it already had: every
 * unregistered session, and every session whose client cannot be identified,
 * remains protected.
 */
export function emptyClients(): ClientsDocument {
  return {
    schemaVersion: 1,
    defaults: { cli: "on", desktop: "on" },
    sessions: {},
  };
}

export class RecoveryRepository {
  constructor(private readonly storage: JsonStorage) {}

  async load(): Promise<RecoveryDocument> {
    const value = await this.storage.get(RECOVERY_STORAGE_KEY);
    if (value === undefined) return emptyRecovery();
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.entries)) {
      throw new Error("Stored offpeak recovery state is invalid; refusing to overwrite it.");
    }
    const entries = value.entries.map((entry, index) => validateRecoveryEntry(entry, index));
    return { schemaVersion: 1, entries };
  }

  async save(document: RecoveryDocument): Promise<void> {
    await this.storage.set(RECOVERY_STORAGE_KEY, document as unknown as JsonValue);
  }
}

export class SessionOverridesRepository {
  constructor(private readonly storage: JsonStorage) {}

  async load(): Promise<SessionOverridesDocument> {
    const value = await this.storage.get(SESSION_OVERRIDES_STORAGE_KEY);
    if (value === undefined) return emptySessionOverrides();
    if (!isRecord(value) || value.schemaVersion !== 1 || !isRecord(value.sessions)) {
      throw new Error("Stored offpeak session overrides are invalid; refusing to overwrite them.");
    }
    const sessions: Record<string, SessionProtectionOverride> = {};
    for (const [sessionID, override] of Object.entries(value.sessions)) {
      sessions[sessionID] = validateSessionOverride(sessionID, override);
    }
    return { schemaVersion: 1, sessions };
  }

  async save(document: SessionOverridesDocument): Promise<void> {
    await this.storage.set(SESSION_OVERRIDES_STORAGE_KEY, document as unknown as JsonValue);
  }
}

export class ClientsRepository {
  constructor(private readonly storage: JsonStorage) {}

  async load(): Promise<ClientsDocument> {
    const value = await this.storage.get(CLIENT_SETTINGS_STORAGE_KEY);
    if (value === undefined) return emptyClients();
    if (
      !isRecord(value) ||
      value.schemaVersion !== 1 ||
      !isRecord(value.defaults) ||
      !isRecord(value.sessions)
    ) {
      throw new Error("Stored offpeak client settings are invalid; refusing to overwrite them.");
    }
    const defaults = validateClientDefaults(value.defaults);
    const sessions: Record<string, SessionClientOwnership> = {};
    for (const [sessionID, ownership] of Object.entries(value.sessions)) {
      sessions[sessionID] = validateClientOwnership(sessionID, ownership);
    }
    return { schemaVersion: 1, defaults, sessions };
  }

  async save(document: ClientsDocument): Promise<void> {
    await this.storage.set(CLIENT_SETTINGS_STORAGE_KEY, document as unknown as JsonValue);
  }
}

export class Mutex {
  #tail: Promise<void> = Promise.resolve();

  async run<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const previous = this.#tail;
    this.#tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

export interface TimerClock {
  setTimeout(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

const systemTimerClock: TimerClock = {
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
};

export class AsyncSignal {
  #version = 0;
  #waiters = new Set<() => void>();
  readonly #clock: TimerClock;

  constructor(clock: TimerClock = systemTimerClock) {
    this.#clock = clock;
  }

  version(): number {
    return this.#version;
  }

  notify(): void {
    this.#version += 1;
    for (const resolve of this.#waiters) resolve();
    this.#waiters.clear();
  }

  async wait(timeoutMs?: number): Promise<void> {
    return this.waitSince(this.#version, timeoutMs);
  }

  async waitSince(version: number, timeoutMs?: number): Promise<void> {
    await new Promise<void>((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const finish = () => {
        if (timer) this.#clock.clearTimeout(timer);
        this.#waiters.delete(finish);
        resolve();
      };
      this.#waiters.add(finish);
      if (timeoutMs !== undefined) timer = this.#clock.setTimeout(finish, Math.max(0, timeoutMs));
      if (this.#version !== version) finish();
    });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validateRecoveryEntry(value: unknown, index: number): RecoveryEntry {
  if (!isRecord(value)) throw new Error(`Stored recovery entry ${index} is not an object.`);
  if (
    typeof value.sessionID !== "string" ||
    typeof value.providerID !== "string" ||
    typeof value.modelID !== "string" ||
    typeof value.directory !== "string" ||
    typeof value.heldAt !== "string"
  ) {
    throw new Error(`Stored recovery entry ${index} has invalid fields.`);
  }
  if (
    value.origin !== undefined &&
    value.origin !== "retry-failure" &&
    value.origin !== "deferred" &&
    value.origin !== "pending-title" &&
    value.origin !== "pending-compaction"
  ) {
    throw new Error(`Stored recovery entry ${index} has an invalid origin.`);
  }
  return value as unknown as RecoveryEntry;
}

function validateClientDefaults(value: Record<string, unknown>): ClientDefaults {
  if (value.cli !== "on" && value.cli !== "off") {
    throw new Error("Stored offpeak client defaults have an invalid CLI value.");
  }
  if (value.desktop !== "on" && value.desktop !== "off") {
    throw new Error("Stored offpeak client defaults have an invalid Desktop value.");
  }
  return { cli: value.cli, desktop: value.desktop };
}

function validateClientOwnership(sessionID: string, value: unknown): SessionClientOwnership {
  if (!sessionID.trim()) throw new Error("Stored client ownership has an empty session ID.");
  if (!isRecord(value) || !Array.isArray(value.clients)) {
    throw new Error(`Stored client ownership for ${sessionID} is not valid.`);
  }
  const clients: OffpeakClient[] = [];
  for (const client of value.clients) {
    if (client !== "cli" && client !== "desktop") {
      throw new Error(`Stored client ownership for ${sessionID} has an invalid client.`);
    }
    if (!clients.includes(client)) clients.push(client);
  }
  if (clients.length === 0) {
    throw new Error(`Stored client ownership for ${sessionID} has no client.`);
  }
  if (typeof value.updatedAt !== "string") {
    throw new Error(`Stored client ownership for ${sessionID} has an invalid update time.`);
  }
  const storedOwner = value.owner;
  if (storedOwner !== undefined && storedOwner !== "cli" && storedOwner !== "desktop") {
    throw new Error(`Stored client ownership for ${sessionID} has an invalid owner.`);
  }
  // v0.4.x documents stored the registration order and an `ambiguous` flag but
  // no explicit owner. The last registrant is the closest correct migration.
  const owner = storedOwner ?? clients[clients.length - 1];
  if (owner === undefined) {
    throw new Error(`Stored client ownership for ${sessionID} has no owner.`);
  }
  return { clients, owner, updatedAt: value.updatedAt };
}

function validateSessionOverride(sessionID: string, value: unknown): SessionProtectionOverride {
  if (!sessionID.trim()) throw new Error("Stored session override has an empty session ID.");
  if (!isRecord(value))
    throw new Error(`Stored session override for ${sessionID} is not an object.`);
  if (value.protection !== "on" && value.protection !== "off") {
    throw new Error(`Stored session override for ${sessionID} has an invalid protection value.`);
  }
  if (typeof value.updatedAt !== "string") {
    throw new Error(`Stored session override for ${sessionID} has an invalid update time.`);
  }
  return { protection: value.protection, updatedAt: value.updatedAt };
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
