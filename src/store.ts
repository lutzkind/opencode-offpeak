export type TaskState =
  | "QUEUED"
  | "RUNNING"
  | "WAITING_OFFPEAK"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export interface TaskModel {
  providerID: string;
  modelID: string;
}

export interface OffpeakTask {
  id: string;
  prompt: string;
  cwd: string;
  sessionID?: string;
  model: TaskModel;
  policyID: string;
  state: TaskState;
  createdAt: string;
  startedAt?: string;
  lastTransition: string;
  completedAt?: string;
  cancelledAt?: string;
  retryCount: number;
  lastAttemptAt?: string;
  lastError?: string;
  overrideUntil?: string;
  resumeRequested?: boolean;
}

export interface QueueDocument {
  schemaVersion: 1;
  tasks: OffpeakTask[];
}

/**
 * Minimal recovery metadata for a session whose provider request must continue
 * at the next allowed window. The session itself is untouched; only the
 * identity needed to continue it is kept.
 *
 * `origin` distinguishes a request that failed retryably during a peak crossing
 * ("retry-failure") from a primary interactive request that was deferred before
 * its provider attempt ("deferred"). Both continue automatically; a user
 * interrupt clears a deferral but not a retry-failure.
 */
export interface RecoveryEntry {
  sessionID: string;
  providerID: string;
  modelID: string;
  directory: string;
  heldAt: string;
  origin?: "retry-failure" | "deferred";
}

export interface RecoveryDocument {
  schemaVersion: 1;
  entries: RecoveryEntry[];
}

export interface JsonStorage {
  get(key: string): Promise<unknown>;
  set(key: string, value: unknown): Promise<void>;
}

export const QUEUE_STORAGE_KEY = "opencode-offpeak/queue-v1";
export const RECOVERY_STORAGE_KEY = "opencode-offpeak/recovery-v1";

export function emptyQueue(): QueueDocument {
  return { schemaVersion: 1, tasks: [] };
}

export function emptyRecovery(): RecoveryDocument {
  return { schemaVersion: 1, entries: [] };
}

export class QueueRepository {
  constructor(private readonly storage: JsonStorage) {}

  async load(): Promise<QueueDocument> {
    const value = await this.storage.get(QUEUE_STORAGE_KEY);
    if (value === undefined) return emptyQueue();
    if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.tasks)) {
      throw new Error("Stored offpeak queue is invalid; refusing to overwrite it.");
    }
    const tasks = value.tasks.map((task, index) => validateTask(task, index));
    return { schemaVersion: 1, tasks };
  }

  async save(queue: QueueDocument): Promise<void> {
    await this.storage.set(QUEUE_STORAGE_KEY, queue as unknown as JsonValue);
  }
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

function validateTask(value: unknown, index: number): OffpeakTask {
  if (!isRecord(value)) throw new Error(`Stored queue task ${index} is not an object.`);
  const states: TaskState[] = [
    "QUEUED",
    "RUNNING",
    "WAITING_OFFPEAK",
    "COMPLETED",
    "FAILED",
    "CANCELLED",
  ];
  if (
    typeof value.id !== "string" ||
    typeof value.prompt !== "string" ||
    typeof value.cwd !== "string" ||
    typeof value.policyID !== "string" ||
    typeof value.state !== "string" ||
    !states.includes(value.state as TaskState) ||
    typeof value.createdAt !== "string" ||
    typeof value.lastTransition !== "string" ||
    typeof value.retryCount !== "number" ||
    !isRecord(value.model) ||
    typeof value.model.providerID !== "string" ||
    typeof value.model.modelID !== "string"
  ) {
    throw new Error(`Stored queue task ${index} has invalid fields.`);
  }
  if (value.sessionID !== undefined && typeof value.sessionID !== "string") {
    throw new Error(`Stored queue task ${index} has an invalid session ID.`);
  }
  return value as unknown as OffpeakTask;
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
    value.origin !== "deferred"
  ) {
    throw new Error(`Stored recovery entry ${index} has an invalid origin.`);
  }
  return value as unknown as RecoveryEntry;
}

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
