import { type FSWatcher, mkdirSync, watch } from "node:fs";
import path from "node:path";
import type { ConfigRepository, OffpeakConfig } from "./config.js";
import { evaluatePricing, type PolicyDecision } from "./policy.js";
import {
  AsyncSignal,
  Mutex,
  type OffpeakTask,
  type QueueRepository,
  type RecoveryEntry,
  type RecoveryOrigin,
  type RecoveryRepository,
  type TaskModel,
  type TaskState,
} from "./store.js";

export interface SessionSnapshot {
  outcome?: "succeeded" | "failed" | "interrupted";
  /** Session title as stored, when the session still exists. */
  title?: string;
  /** Set for child (subagent) sessions; they never receive automatic titles. */
  parentID?: string;
  /** Session creation time in epoch milliseconds. */
  created?: number;
}

export interface SessionDriver {
  create(input: { cwd: string; model: TaskModel; taskID: string }): Promise<string>;
  prompt(sessionID: string, text: string): Promise<void>;
  wait(sessionID: string): Promise<void>;
  get(sessionID: string): Promise<SessionSnapshot>;
  interrupt(sessionID: string): Promise<void>;
}

export interface EngineClock {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): NodeJS.Timeout;
  clearTimeout(timer: NodeJS.Timeout): void;
}

const systemClock: EngineClock = {
  now: () => Date.now(),
  setTimeout: (callback, milliseconds) => setTimeout(callback, milliseconds),
  clearTimeout: (timer) => clearTimeout(timer),
};

export interface EngineStatus {
  enabled: boolean;
  mode: OffpeakConfig["mode"];
  automaticExecution: "ACTIVE" | "PAUSED";
  automaticResume: "ACTIVE" | "PAUSED";
  override: { active: boolean; taskID?: string; expiresAt?: string };
  providerID?: string;
  modelID?: string;
  policyID?: string;
  pricingState: PolicyDecision["state"];
  requestsAllowed: boolean;
  nextTransition?: number;
  displayTimeZone: string;
  queued: number;
  running?: { id: string; sessionID?: string; state: TaskState };
  waiting: number;
  /** Interactive requests currently held at the pricing boundary (auto mode). */
  interactiveWaiting: number;
  /** Interactive sessions waiting for an off-peak recovery continuation. */
  recoveryWaiting: number;
  /** Subset of recoveryWaiting: sessions whose automatic title is still pending. */
  titleRecoveryWaiting: number;
  failed: number;
  tasks: OffpeakTask[];
  configPath: string;
  configError?: string;
}

export interface GuardInput {
  sessionID: string;
  providerID: string;
  modelID: string;
  transport: "http" | "websocket" | "model";
  /**
   * OpenCode session request kind ("primary", "compaction", "title", "generate")
   * when the guard runs from the pre-model `model.request` hook. Transport
   * guards do not carry a kind.
   */
  kind?: string;
}

/**
 * Provider error types OpenCode may retry. Used to recognise a retryable
 * failure sequence even when OpenCode has already exhausted its retry budget
 * and reports a terminal decision.
 */
const RETRYABLE_ERROR_TYPES = new Set([
  "provider.transport",
  "provider.internal",
  "provider.rate-limit",
]);

/** Safe continuation prompt used when a peak-blocked session resumes at the next allowed window. */
const RECOVERY_CONTINUATION =
  "Continue the task in this session from the current project state. Avoid repeating work that is already complete.";

/**
 * Mirrors OpenCode's own `SessionTitle.isExactRootFallback` for a root session:
 * a session needs an automatic title when it has none, or when its stored title
 * is exactly the creation-time fallback (`New session - <created ISO>`). Any
 * other title was generated already or set by the user, and must never be
 * overwritten. Child sessions are excluded because OpenCode never titles them
 * automatically.
 */
export function needsAutoTitle(session: SessionSnapshot): boolean {
  if (session.parentID) return false;
  if (session.title === undefined) return true;
  if (session.created === undefined) return false;
  return session.title === `New session - ${new Date(session.created).toISOString()}`;
}

/** How long to wait before re-checking a session that has not settled yet. */
const RECOVERY_SETTLE_DELAY_MS = 2_000;
/** Give up (without sending anything) if a session never settles. */
const RECOVERY_SETTLE_CAP_MS = 5 * 60_000;

/**
 * Recovery origins that continue the primary turn. `undefined` covers entries
 * persisted by older plugin versions.
 */
const PRIMARY_RECOVERY_ORIGINS = [undefined, "retry-failure", "deferred"] as const;
/** The semantic "this session still needs its automatic title" marker. */
const TITLE_RECOVERY_ORIGIN = "pending-title" as const;

export interface RetryFailureInput {
  sessionID: string;
  providerID: string;
  modelID: string;
  errorType: string;
  /** Whether OpenCode currently intends to retry this failure. */
  willRetry: boolean;
}

export class PricingBlockedError extends Error {
  readonly code = "OFFPEAK_PRICING_BLOCKED";

  constructor(message: string) {
    super(message);
    this.name = "PricingBlockedError";
  }
}

export interface EngineOptions {
  repository: QueueRepository;
  config: ConfigRepository;
  sessions: SessionDriver;
  /** Optional persisted recovery metadata for interactive sessions. */
  recoveries?: RecoveryRepository;
  /** Plugin instance location; recovery entries are scoped to it. */
  location?: string;
  clock?: EngineClock;
  id?: () => string;
  onError?: (error: unknown) => void;
}

export class OffpeakEngine {
  readonly #repo: QueueRepository;
  readonly #config: ConfigRepository;
  readonly #sessions: SessionDriver;
  readonly #clock: EngineClock;
  readonly #id: () => string;
  readonly #onError: (error: unknown) => void;
  readonly #lock = new Mutex();
  readonly #signal: AsyncSignal;
  readonly #runners = new Set<string>();
  readonly #interactiveWaiters = new Set<number>();
  /**
   * Per-session monotonic abort epochs. When OpenCode interrupts a session's
   * execution (user cancel, inactivity sweep, supersede), a hold loop whose
   * epoch moved on fails closed instead of lingering as a stale waiter.
   */
  readonly #holdAborts = new Map<string, number>();
  readonly #recoveriesRepo: RecoveryRepository | undefined;
  readonly #location: string;
  /**
   * Recovery entries keyed by `${origin}:${sessionID}`. A session can hold a
   * primary continuation and a pending-title marker at the same time; they
   * are removed and delivered independently.
   */
  readonly #recoveries = new Map<string, RecoveryEntry>();
  readonly #recoveryChecks = new Map<string, number>();
  readonly #titleChecks = new Map<string, number>();
  #nextInteractiveWaiter = 0;
  #timer: NodeJS.Timeout | undefined;
  #recoveryTimer: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  #disposed = false;
  #pumping: Promise<void> | undefined;
  #pumpRequested = false;

  constructor(options: EngineOptions) {
    this.#repo = options.repository;
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#recoveriesRepo = options.recoveries;
    this.#location = options.location ?? "";
    this.#clock = options.clock ?? systemClock;
    this.#signal = new AsyncSignal(this.#clock);
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.#onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
    try {
      await this.#loadRecoveries();
    } catch (error) {
      this.#onError(error);
    }
    try {
      await this.#reconcileAfterLoad();
    } catch (error) {
      this.#onError(error);
    }
    try {
      mkdirSync(path.dirname(this.#config.path), { recursive: true, mode: 0o700 });
      this.#watcher = watch(path.dirname(this.#config.path), (_event, filename) => {
        if (filename && !filename.toString().startsWith(path.basename(this.#config.path))) return;
        this.#signal.notify();
        this.#requestPump();
      });
    } catch {
      // File watching is an optimization; commands and request hooks always read fresh config.
    }
    this.#requestPump();
  }

  async dispose(): Promise<void> {
    this.#disposed = true;
    this.#watcher?.close();
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    if (this.#recoveryTimer) this.#clock.clearTimeout(this.#recoveryTimer);
    this.#signal.notify();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    await this.#lock.run(async () => {
      const current = await this.#config.read();
      if (!current.config) throw new Error(`Cannot update offpeak setting: ${current.error}`);
      await this.#config.write({ ...current.config, enabled });
    });
    this.#signal.notify();
    if (enabled) this.#requestPump();
  }

  async queue(input: { prompt: string; cwd: string; model: TaskModel }): Promise<OffpeakTask> {
    const prompt = input.prompt.trim();
    const cwd = input.cwd.trim();
    if (!prompt) throw new Error("Task prompt cannot be empty.");
    if (!cwd) throw new Error("Project working directory is required.");
    const settings = await this.#config.read();
    if (!settings.config) throw new Error(`Cannot queue a task: ${settings.error}`);
    const decision = evaluatePricing(
      settings.config.policies,
      input.model.providerID,
      input.model.modelID,
      this.#clock.now(),
    );
    if (!decision.policy) {
      throw new Error(
        decision.reason ?? "No pricing policy matches the selected provider and model.",
      );
    }
    if (decision.state === "UNKNOWN")
      throw new Error(decision.reason ?? "Pricing policy could not be evaluated.");
    const now = new Date(this.#clock.now()).toISOString();
    const task: OffpeakTask = {
      id: this.#id(),
      prompt,
      cwd,
      model: { ...input.model },
      policyID: decision.policy.id,
      state: "QUEUED",
      createdAt: now,
      lastTransition: now,
      retryCount: 0,
    };
    await this.#lock.run(async () => {
      const queue = await this.#repo.load();
      queue.tasks.push(task);
      await this.#repo.save(queue);
    });
    this.#signal.notify();
    this.#requestPump();
    return task;
  }

  async list(): Promise<OffpeakTask[]> {
    return this.#lock.run(async () => structuredClone((await this.#repo.load()).tasks));
  }

  async cancel(taskID: string): Promise<void> {
    const task = await this.#updateTask(taskID, (current) => {
      if (current.state === "COMPLETED" || current.state === "CANCELLED") {
        throw new Error(`Task ${taskID} is already ${current.state.toLowerCase()}.`);
      }
      current.state = "CANCELLED";
      current.cancelledAt = new Date(this.#clock.now()).toISOString();
      delete current.completedAt;
      delete current.lastError;
    });
    this.#signal.notify();
    if (task.sessionID) await this.#sessions.interrupt(task.sessionID).catch(this.#onError);
    this.#requestPump();
  }

  async remove(taskID: string): Promise<void> {
    await this.#lock.run(async () => {
      const queue = await this.#repo.load();
      const task = queue.tasks.find((candidate) => candidate.id === taskID);
      if (!task) throw new Error(`Task ${taskID} was not found.`);
      if (!["COMPLETED", "FAILED", "CANCELLED"].includes(task.state)) {
        throw new Error(`Task ${taskID} is ${task.state}; cancel it before removing it.`);
      }
      queue.tasks = queue.tasks.filter((candidate) => candidate.id !== taskID);
      await this.#repo.save(queue);
    });
  }

  async retry(taskID: string): Promise<void> {
    await this.#updateTask(taskID, (task) => {
      if (task.state !== "FAILED")
        throw new Error(`Only failed tasks can be retried (currently ${task.state}).`);
      task.retryCount += 1;
      task.lastAttemptAt = new Date(this.#clock.now()).toISOString();
      delete task.lastError;
      task.state = "QUEUED";
      task.resumeRequested = true;
    });
    this.#signal.notify();
    this.#requestPump();
  }

  async resume(taskID: string): Promise<void> {
    await this.#updateTask(taskID, (task) => {
      if (task.state !== "WAITING_OFFPEAK") {
        throw new Error(`Only waiting tasks can be resumed (currently ${task.state}).`);
      }
      task.resumeRequested = true;
    });
    this.#signal.notify();
    this.#requestPump();
  }

  async runNow(taskID: string, durationMs = 15 * 60_000): Promise<void> {
    const settings = await this.#config.read();
    if (!settings.config) throw new Error(`Cannot override pricing: ${settings.error}`);
    if (!settings.config.enabled)
      throw new Error("Turn /offpeak on before using an explicit peak-price override.");
    await this.#updateTask(taskID, (task) => {
      if (!["QUEUED", "WAITING_OFFPEAK", "FAILED"].includes(task.state)) {
        throw new Error(`Task ${taskID} cannot be run now while it is ${task.state}.`);
      }
      if (task.state === "FAILED") {
        task.retryCount += 1;
        task.lastAttemptAt = new Date(this.#clock.now()).toISOString();
      }
      task.state = task.sessionID ? "WAITING_OFFPEAK" : "QUEUED";
      delete task.lastError;
      task.overrideUntil = new Date(this.#clock.now() + durationMs).toISOString();
      task.resumeRequested = true;
    });
    this.#signal.notify();
    this.#requestPump();
  }

  async status(current?: { providerID?: string; modelID?: string }): Promise<EngineStatus> {
    const settings = await this.#config.read();
    const tasks = await this.list();
    const selected =
      current?.providerID && current.modelID
        ? { providerID: current.providerID, modelID: current.modelID }
        : tasks.find((task) => task.state === "RUNNING" || task.state === "WAITING_OFFPEAK")?.model;
    const decision =
      settings.config && selected
        ? evaluatePricing(
            settings.config.policies,
            selected.providerID,
            selected.modelID,
            this.#clock.now(),
          )
        : { state: "UNKNOWN" as const, allowed: false, reason: "No provider/model selected." };
    const running = tasks.find(
      (task) => task.state === "RUNNING" || task.state === "WAITING_OFFPEAK",
    );
    const override = tasks.find(
      (task) => task.overrideUntil && Date.parse(task.overrideUntil) > this.#clock.now(),
    );
    const enabled = settings.config?.enabled ?? false;
    return {
      enabled,
      mode: settings.config?.mode ?? "auto",
      automaticExecution: enabled && settings.config?.mode !== "guard" ? "ACTIVE" : "PAUSED",
      automaticResume: enabled && settings.config?.mode === "auto" ? "ACTIVE" : "PAUSED",
      override: override?.overrideUntil
        ? { active: true, taskID: override.id, expiresAt: override.overrideUntil }
        : { active: false },
      ...(selected?.providerID ? { providerID: selected.providerID } : {}),
      ...(selected?.modelID ? { modelID: selected.modelID } : {}),
      ...(decision.policy?.id ? { policyID: decision.policy.id } : {}),
      pricingState: decision.state,
      requestsAllowed:
        (!enabled && running !== undefined) || decision.state === "UNKNOWN"
          ? false
          : decision.allowed,
      ...(decision.nextTransition !== undefined ? { nextTransition: decision.nextTransition } : {}),
      displayTimeZone: settings.config?.displayTimeZone ?? "UTC",
      queued: tasks.filter((task) => task.state === "QUEUED").length,
      ...(running
        ? {
            running: {
              id: running.id,
              ...(running.sessionID ? { sessionID: running.sessionID } : {}),
              state: running.state,
            },
          }
        : {}),
      waiting: tasks.filter((task) => task.state === "WAITING_OFFPEAK").length,
      interactiveWaiting: this.#interactiveWaiters.size,
      recoveryWaiting: this.#recoveries.size,
      titleRecoveryWaiting: [...this.#recoveries.values()].filter(
        (entry) => entry.origin === TITLE_RECOVERY_ORIGIN,
      ).length,
      failed: tasks.filter((task) => task.state === "FAILED").length,
      tasks,
      configPath: settings.path,
      ...(settings.error ? { configError: settings.error } : {}),
    };
  }

  async guardRequest(input: GuardInput): Promise<void> {
    // Any fresh request for this session supersedes a pending continuation of
    // the same class. A title request only supersedes a pending title; it must
    // not clear a primary deferral that another held request still owns, and a
    // primary request must not clear a title that is still being held.
    if (input.kind === "title")
      await this.#removeRecovery(input.sessionID, [TITLE_RECOVERY_ORIGIN]);
    else await this.#removeRecovery(input.sessionID, PRIMARY_RECOVERY_ORIGINS);
    await this.#guardPricing(input, undefined);
  }

  /**
   * Pre-model guard for OpenCode's `model.request` hook. It runs while the
   * session request is being prepared, before any provider attempt (and before
   * OpenCode's response-header timeout clock) exists, so holding for OFF_PEAK
   * here never leaves a provider attempt open.
   *
   * A held primary request persists a deferral: if the plugin reloads or the
   * server restarts while it waits, the existing recovery flush delivers one
   * same-session continuation once the allowed window arrives. The release
   * itself removes the deferral, so normal completion never sends a
   * continuation.
   *
   * A held Automatic title request (kind `title`) persists a semantic
   * `pending-title` marker instead of a continuation: recovery re-runs
   * OpenCode's own title generation for a session that still needs a title,
   * and it is cleared without any request when the session was titled (or
   * manually renamed) while it waited.
   */
  async guardModelRequest(input: GuardInput): Promise<void> {
    const origin: RecoveryOrigin | undefined =
      input.kind === "primary"
        ? "deferred"
        : input.kind === "title"
          ? TITLE_RECOVERY_ORIGIN
          : undefined;
    if (origin !== undefined) await this.#removeRecovery(input.sessionID, [origin]);
    await this.#guardPricing(input, origin);
  }

  async #guardPricing(
    input: GuardInput,
    deferralOrigin: RecoveryOrigin | undefined,
  ): Promise<void> {
    const task = await this.#taskForSession(input.sessionID);
    const first = await this.#config.read();
    if (!first.config)
      throw new PricingBlockedError(`Offpeak pricing guard failed closed: ${first.error}`);
    const decision = evaluatePricing(
      first.config.policies,
      input.providerID,
      input.modelID,
      this.#clock.now(),
    );
    if (decision.state === "UNTRACKED") return;
    if (decision.state === "UNKNOWN") {
      throw new PricingBlockedError(`Offpeak pricing guard failed closed: ${decision.reason}`);
    }
    if (this.#hasOverride(task, this.#clock.now()) && first.config.enabled) return;
    if (decision.allowed && (!task || first.config.enabled)) return;

    if (task && first.config.mode === "auto") {
      await this.#transition(task.id, "WAITING_OFFPEAK");
      await this.#holdUntilAllowed(input, task, undefined);
      return;
    }

    // A normal interactive request in auto mode is held at the boundary instead of
    // being discarded; the same request and session continue when pricing allows.
    if (!task && first.config.enabled && first.config.mode === "auto") {
      await this.#holdUntilAllowed(input, undefined, deferralOrigin);
      return;
    }

    if (task) await this.#transition(task.id, "WAITING_OFFPEAK");
    const reason = !first.config.enabled
      ? "OpenCode Offpeak is disabled; automatic task execution is paused and peak pricing remains blocked."
      : `${input.providerID}/${input.modelID} is in a peak-price window under policy ${decision.policy?.id}.`;
    throw new PricingBlockedError(
      task
        ? `${reason} Use /offpeak run-now <task-id> for an explicit 15-minute task override.`
        : `${reason} Interactive requests wait for off-peak automatically only in auto mode; queue and guard modes block them immediately.`,
    );
  }

  /**
   * Holds a request at the provider transport boundary until the plugin is enabled
   * and the pricing policy allows it. Used by queue-owned auto tasks, by normal
   * interactive auto-mode requests, and by the pre-model guard.
   *
   * The hard guarantee: the caller never crosses the transport boundary while
   * pricing is blocked. Wake-ups come from the shared config signal and one timer
   * for the policy's next transition. Queue tasks move through WAITING_OFFPEAK and
   * may use their explicit override; interactive requests are tracked in memory
   * (for status) and fail closed on shutdown instead of guessing the price state.
   *
   * `deferralOrigin` marks an interactive request that is safe to resume after a
   * plugin reload or server restart: the recovery entry is persisted while the
   * request waits and removed again when the wait ends normally. A shutdown or
   * guard error leaves it in place so recovery can be delivered once the
   * allowed window arrives.
   */
  async #holdUntilAllowed(
    input: GuardInput,
    task?: OffpeakTask,
    deferralOrigin?: RecoveryOrigin,
  ): Promise<void> {
    const waiter = task ? undefined : this.#registerInteractiveWaiter();
    const deferred = deferralOrigin !== undefined && !task;
    if (deferred) {
      await this.#registerRecovery(
        input.sessionID,
        input.providerID,
        input.modelID,
        deferralOrigin,
      );
      this.#requestPump();
    }
    const abortEpoch = this.#holdAborts.get(input.sessionID) ?? 0;
    try {
      while (!this.#disposed) {
        if ((this.#holdAborts.get(input.sessionID) ?? 0) !== abortEpoch) {
          throw new PricingBlockedError(
            "Offpeak hold was interrupted in OpenCode; the request was not sent.",
          );
        }
        const signalVersion = this.#signal.version();
        const settings = await this.#config.read();
        if (!settings.config)
          throw new PricingBlockedError(`Offpeak pricing guard failed closed: ${settings.error}`);
        const decision = evaluatePricing(
          settings.config.policies,
          input.providerID,
          input.modelID,
          this.#clock.now(),
        );
        if (decision.state === "UNKNOWN") {
          if (task) await this.#setTaskError(task.id, decision.reason);
          throw new PricingBlockedError(`Offpeak pricing guard failed closed: ${decision.reason}`);
        }
        if (
          task &&
          settings.config.enabled &&
          this.#hasOverride(await this.#taskByID(task.id), this.#clock.now())
        ) {
          await this.#transition(task.id, "RUNNING");
          return;
        }
        if (settings.config.enabled && decision.allowed) {
          if (task) await this.#transition(task.id, "RUNNING");
          if (deferred) await this.#removeRecovery(input.sessionID, [deferralOrigin]);
          return;
        }
        if (settings.config.enabled && decision.nextTransition === undefined) {
          throw new PricingBlockedError(
            "Offpeak policy has no known next transition; request blocked.",
          );
        }
        const delay =
          settings.config.enabled && decision.nextTransition !== undefined
            ? Math.max(1, decision.nextTransition - this.#clock.now())
            : undefined;
        await this.#signal.waitSince(signalVersion, delay);
      }
      throw new PricingBlockedError("Offpeak plugin is shutting down; request blocked.");
    } finally {
      if (waiter !== undefined) this.#interactiveWaiters.delete(waiter);
    }
  }

  #registerInteractiveWaiter(): number {
    const waiter = ++this.#nextInteractiveWaiter;
    this.#interactiveWaiters.add(waiter);
    return waiter;
  }

  /**
   * Called from OpenCode's `retry` hook before a retry is scheduled. When a
   * retryable provider/network failure happens while pricing is blocked in auto
   * mode, the retry is stopped and the work is marked to continue at the next
   * allowed window instead of failing the turn. Returns "hold" when the caller
   * must veto the retry (`decision = { retry: false }`).
   */
  async noteRetryFailure(input: RetryFailureInput): Promise<"pass" | "hold"> {
    if (this.#disposed) return "pass";
    const settings = await this.#config.read();
    if (!settings.config) return "pass";
    if (!settings.config.enabled || settings.config.mode !== "auto") return "pass";
    if (!input.willRetry && !RETRYABLE_ERROR_TYPES.has(input.errorType)) return "pass";
    const decision = evaluatePricing(
      settings.config.policies,
      input.providerID,
      input.modelID,
      this.#clock.now(),
    );
    if (decision.state !== "PEAK") return "pass";
    const task = await this.#taskForSession(input.sessionID);
    if (task) {
      if (this.#hasOverride(task, this.#clock.now())) return "pass";
      if (task.state !== "RUNNING" && task.state !== "WAITING_OFFPEAK") return "pass";
      if (task.state === "RUNNING") {
        await this.#updateTask(task.id, (current) => {
          current.state = "WAITING_OFFPEAK";
          delete current.lastError;
        });
      }
      this.#signal.notify();
      this.#requestPump();
      return "hold";
    }
    await this.#registerRecovery(input.sessionID, input.providerID, input.modelID, "retry-failure");
    this.#signal.notify();
    this.#requestPump();
    return "hold";
  }

  /**
   * Called when OpenCode reports that a session's execution was interrupted.
   *
   * - "user": the user cancelled. A pending deferral is cleared and the hold is
   *   aborted so nothing continues automatically.
   * - "inactivity": OpenCode's location-activity sweep ended the execution. The
   *   hold is aborted and a deferral (if present) is kept so the same session
   *   continues once pricing allows.
   * - "superseded"/"shutdown": the hold is aborted; the session's own claim or
   *   restart recovery owns what happens next.
   */
  async noteExecutionInterrupted(input: { sessionID: string; reason: string }): Promise<void> {
    if (this.#disposed) return;
    if (input.reason === "user") {
      // The user cancelled the work. Neither the same-session continuation nor
      // a pending automatic title is delivered for abandoned work; OpenCode
      // itself also generates no title without new input.
      await this.#removeRecovery(input.sessionID, ["deferred", TITLE_RECOVERY_ORIGIN]);
    }
    if (
      input.reason !== "user" &&
      input.reason !== "inactivity" &&
      input.reason !== "superseded" &&
      input.reason !== "shutdown"
    ) {
      return;
    }
    this.#holdAborts.set(input.sessionID, (this.#holdAborts.get(input.sessionID) ?? 0) + 1);
    this.#signal.notify();
    this.#requestPump();
  }

  async #loadRecoveries(): Promise<void> {
    const repo = this.#recoveriesRepo;
    if (!repo) return;
    const document = await repo.load();
    for (const entry of document.entries) {
      if (entry.directory !== this.#location) continue;
      this.#recoveries.set(this.#recoveryKey(entry), entry);
    }
  }

  #recoveryKey(entry: Pick<RecoveryEntry, "sessionID" | "origin">): string {
    return `${entry.origin ?? "legacy"}\u0000${entry.sessionID}`;
  }

  async #registerRecovery(
    sessionID: string,
    providerID: string,
    modelID: string,
    origin: RecoveryOrigin,
  ): Promise<void> {
    const entry: RecoveryEntry = {
      sessionID,
      providerID,
      modelID,
      directory: this.#location,
      heldAt: new Date(this.#clock.now()).toISOString(),
      origin,
    };
    const key = this.#recoveryKey(entry);
    if (this.#recoveries.has(key)) return;
    this.#recoveries.set(key, entry);
    await this.#persistRecoveries();
  }

  async #removeRecovery(
    sessionID: string,
    origins: ReadonlyArray<RecoveryOrigin | undefined>,
  ): Promise<void> {
    let changed = false;
    for (const origin of origins) {
      const key =
        origin === undefined
          ? `legacy\u0000${sessionID}`
          : this.#recoveryKey({ sessionID, origin });
      if (this.#recoveries.delete(key)) changed = true;
    }
    if (!changed) return;
    this.#recoveryChecks.delete(sessionID);
    this.#titleChecks.delete(sessionID);
    await this.#persistRecoveries();
  }

  async #persistRecoveries(): Promise<void> {
    const repo = this.#recoveriesRepo;
    if (!repo) return;
    await this.#lock.run(async () => {
      const document = await repo.load();
      const others = document.entries.filter((entry) => entry.directory !== this.#location);
      await repo.save({
        schemaVersion: 1,
        entries: [...others, ...this.#recoveries.values()],
      });
    });
  }

  /**
   * Delivers recoveries whose allowed window has arrived. Called from the pump,
   * so the existing signal and boundary timer drive it; there is no polling
   * loop.
   *
   * Primary continuations are delivered first so a same-session continuation
   * makes the session busy again before any pending title is considered: the
   * continuation's input promotion triggers OpenCode's own title generation,
   * and the title marker is then cleared without sending anything.
   */
  async #flushRecoveries(): Promise<void> {
    if (this.#disposed) return;
    if (this.#recoveries.size === 0) {
      this.#scheduleRecovery(undefined);
      return;
    }
    const settings = await this.#config.read();
    if (!settings.config) return;
    let next: number | undefined;
    const entries = [...this.#recoveries.values()].filter(
      (entry) => entry.directory === this.#location,
    );
    for (const entry of entries) {
      if (entry.origin === TITLE_RECOVERY_ORIGIN) continue;
      const decision = evaluatePricing(
        settings.config.policies,
        entry.providerID,
        entry.modelID,
        this.#clock.now(),
      );
      if (settings.config.enabled && decision.allowed) {
        const retryAt = await this.#deliverRecovery(entry);
        if (retryAt !== undefined) next = next === undefined ? retryAt : Math.min(next, retryAt);
        continue;
      }
      if (settings.config.enabled && decision.nextTransition !== undefined) {
        next =
          next === undefined ? decision.nextTransition : Math.min(next, decision.nextTransition);
      }
    }
    for (const entry of entries) {
      if (entry.origin !== TITLE_RECOVERY_ORIGIN) continue;
      const decision = evaluatePricing(
        settings.config.policies,
        entry.providerID,
        entry.modelID,
        this.#clock.now(),
      );
      if (settings.config.enabled && decision.allowed) {
        const retryAt = await this.#deliverTitleRecovery(entry);
        if (retryAt !== undefined) next = next === undefined ? retryAt : Math.min(next, retryAt);
        continue;
      }
      if (settings.config.enabled && decision.nextTransition !== undefined) {
        next =
          next === undefined ? decision.nextTransition : Math.min(next, decision.nextTransition);
      }
    }
    this.#scheduleRecovery(next);
  }

  /** Returns a timestamp to retry at when the session has not settled yet. */
  async #deliverRecovery(entry: RecoveryEntry): Promise<number | undefined> {
    let session: SessionSnapshot;
    try {
      session = await this.#sessions.get(entry.sessionID);
    } catch (error) {
      this.#onError(error);
      await this.#removeRecovery(entry.sessionID, [entry.origin]);
      return undefined;
    }
    if (session.outcome === "succeeded") {
      await this.#removeRecovery(entry.sessionID, [entry.origin]);
      return undefined;
    }
    if (session.outcome === undefined) {
      const firstCheck = this.#recoveryChecks.get(entry.sessionID) ?? this.#clock.now();
      this.#recoveryChecks.set(entry.sessionID, firstCheck);
      if (this.#clock.now() - firstCheck < RECOVERY_SETTLE_CAP_MS) {
        return this.#clock.now() + RECOVERY_SETTLE_DELAY_MS;
      }
      await this.#removeRecovery(entry.sessionID, [entry.origin]);
      this.#onError(
        new Error(`Offpeak recovery for ${entry.sessionID} skipped: the session did not settle.`),
      );
      return undefined;
    }
    // Remove before sending so the continuation is delivered at most once.
    await this.#removeRecovery(entry.sessionID, [entry.origin]);
    try {
      await this.#sessions.prompt(entry.sessionID, RECOVERY_CONTINUATION);
    } catch (error) {
      this.#onError(error);
    }
    return undefined;
  }

  /**
   * Delivers a pending-title recovery. This is a semantic watch, not a replay:
   *
   * - The session is re-checked for a still-missing automatic title. A title
   *   the session already has (generated by OpenCode or renamed by the user)
   *   clears the marker without sending anything, so a title is never
   *   overwritten and never regenerated twice.
   * - A session that still needs a title is left to OpenCode's own generation:
   *   every path that loses a title hold (inactivity, supersede, shutdown,
   *   reload) also resumes the session — the plugin's same-session
   *   continuation or OpenCode's restart recovery — and that input promotion
   *   is OpenCode's native trigger for `SessionTitle.generate`. The marker
   *   waits for the title to appear and then clears.
   * - OpenCode 2.0.27 exposes no plugin-facing regeneration call, and the
   *   plugin host's `session.update({ title: "" })` is not the HTTP API's
   *   regeneration either — it renames the session to an empty title — so the
   *   recovery deliberately mutates nothing. If no title appears within the
   *   settle cap, the marker is dropped with a diagnostic; a later input
   *   promotion still names the session normally.
   *
   * Returns a timestamp to re-check at while the title is still pending.
   */
  async #deliverTitleRecovery(entry: RecoveryEntry): Promise<number | undefined> {
    let session: SessionSnapshot;
    try {
      session = await this.#sessions.get(entry.sessionID);
    } catch (error) {
      this.#onError(error);
      await this.#removeRecovery(entry.sessionID, [TITLE_RECOVERY_ORIGIN]);
      return undefined;
    }
    if (!needsAutoTitle(session)) {
      await this.#removeRecovery(entry.sessionID, [TITLE_RECOVERY_ORIGIN]);
      return undefined;
    }
    const firstCheck = this.#titleChecks.get(entry.sessionID) ?? this.#clock.now();
    this.#titleChecks.set(entry.sessionID, firstCheck);
    if (this.#clock.now() - firstCheck < RECOVERY_SETTLE_CAP_MS) {
      return this.#clock.now() + RECOVERY_SETTLE_DELAY_MS;
    }
    await this.#removeRecovery(entry.sessionID, [TITLE_RECOVERY_ORIGIN]);
    this.#onError(
      new Error(
        `Offpeak pending title for ${entry.sessionID} was not generated after the allowed window; a later input promotion still names the session.`,
      ),
    );
    return undefined;
  }

  #scheduleRecovery(at?: number): void {
    if (this.#recoveryTimer) {
      this.#clock.clearTimeout(this.#recoveryTimer);
      this.#recoveryTimer = undefined;
    }
    if (at === undefined || this.#disposed) return;
    const delay = Math.max(1, at - this.#clock.now());
    this.#recoveryTimer = this.#clock.setTimeout(() => {
      this.#recoveryTimer = undefined;
      void this.#flushRecoveries().catch((error) => this.#onError(error));
    }, delay);
    this.#recoveryTimer.unref?.();
  }

  #hasOverride(task: OffpeakTask | undefined, nowMs: number): boolean {
    return Boolean(task?.overrideUntil && Date.parse(task.overrideUntil) > nowMs);
  }

  async #taskForSession(sessionID: string): Promise<OffpeakTask | undefined> {
    return this.#lock.run(async () =>
      (await this.#repo.load()).tasks.find((task) => task.sessionID === sessionID),
    );
  }

  async #taskByID(taskID: string): Promise<OffpeakTask | undefined> {
    return this.#lock.run(async () =>
      (await this.#repo.load()).tasks.find((task) => task.id === taskID),
    );
  }

  async #updateTask(taskID: string, update: (task: OffpeakTask) => void): Promise<OffpeakTask> {
    return this.#lock.run(async () => {
      const queue = await this.#repo.load();
      const task = queue.tasks.find((item) => item.id === taskID);
      if (!task) throw new Error(`Task ${taskID} was not found.`);
      update(task);
      task.lastTransition = new Date(this.#clock.now()).toISOString();
      await this.#repo.save(queue);
      return structuredClone(task);
    });
  }

  async #transition(taskID: string, state: TaskState): Promise<void> {
    await this.#updateTask(taskID, (task) => {
      task.state = state;
      if (state === "RUNNING" && !task.startedAt)
        task.startedAt = new Date(this.#clock.now()).toISOString();
    });
  }

  async #setTaskError(taskID: string, error?: string): Promise<void> {
    await this.#updateTask(taskID, (task) => {
      if (error === undefined) delete task.lastError;
      else task.lastError = error;
    });
  }

  #requestPump(): void {
    if (this.#disposed) return;
    this.#pumpRequested = true;
    if (this.#pumping) return;
    this.#pumping = (async () => {
      while (this.#pumpRequested && !this.#disposed) {
        this.#pumpRequested = false;
        await this.#pump();
      }
    })()
      .catch((error) => this.#onError(error))
      .finally(() => {
        this.#pumping = undefined;
        if (this.#pumpRequested) this.#requestPump();
      });
  }

  async #pump(): Promise<void> {
    if (this.#timer) {
      this.#clock.clearTimeout(this.#timer);
      this.#timer = undefined;
    }
    await this.#flushRecoveries();
    const settings = await this.#config.read();
    if (!settings.config?.enabled || this.#disposed) return;
    if (this.#runners.size) return;

    const queue = await this.#lock.run(() => this.#repo.load());
    const hasRunning = queue.tasks.some((task) => task.state === "RUNNING");
    if (hasRunning) return;

    const tasks = queue.tasks
      .filter((task) => task.state === "QUEUED" || task.state === "WAITING_OFFPEAK")
      .sort((left, right) => Date.parse(left.createdAt) - Date.parse(right.createdAt));
    for (const task of tasks) {
      const override = this.#hasOverride(task, this.#clock.now());
      if (settings.config.mode === "guard" && !task.resumeRequested && !override) continue;
      if (
        task.state === "WAITING_OFFPEAK" &&
        settings.config.mode === "queue" &&
        !task.resumeRequested
      )
        continue;
      const decision = evaluatePricing(
        settings.config.policies,
        task.model.providerID,
        task.model.modelID,
        this.#clock.now(),
      );
      if (decision.state === "UNKNOWN" || decision.state === "UNTRACKED") {
        await this.#updateTask(task.id, (current) => {
          current.state = "FAILED";
          current.lastError = decision.reason ?? "No pricing policy matches this task.";
        });
        continue;
      }
      if (!decision.allowed && !override) {
        await this.#updateTask(task.id, (current) => {
          current.state = "WAITING_OFFPEAK";
          delete current.lastError;
        });
        this.#schedule(decision.nextTransition);
        return;
      }
      if (
        task.state === "WAITING_OFFPEAK" &&
        settings.config.mode === "queue" &&
        !task.resumeRequested &&
        !override
      )
        continue;
      if (task.resumeRequested) {
        await this.#updateTask(task.id, (current) => {
          current.resumeRequested = false;
        });
      }
      await this.#transition(task.id, "RUNNING");
      this.#runners.add(task.id);
      try {
        await this.#execute(task, task.sessionID !== undefined);
      } finally {
        this.#runners.delete(task.id);
      }
      const current = await this.#taskByID(task.id);
      if (current?.state === "WAITING_OFFPEAK") {
        if (settings.config.mode === "auto") this.#scheduleForTask(current, settings.config);
        return;
      }
      if (current?.state === "FAILED" || current?.state === "CANCELLED") return;
      return this.#pump();
    }
  }

  #schedule(at?: number): void {
    if (at === undefined || this.#disposed) return;
    if (this.#timer) this.#clock.clearTimeout(this.#timer);
    const delay = Math.max(1, at - this.#clock.now());
    this.#timer = this.#clock.setTimeout(() => {
      this.#timer = undefined;
      this.#requestPump();
    }, delay);
    this.#timer.unref?.();
  }

  #scheduleForTask(task: OffpeakTask, settings: OffpeakConfig): void {
    const decision = evaluatePricing(
      settings.policies,
      task.model.providerID,
      task.model.modelID,
      this.#clock.now(),
    );
    this.#schedule(decision.nextTransition);
  }

  async #execute(task: OffpeakTask, resume: boolean): Promise<void> {
    let sessionID = task.sessionID;
    try {
      if (!sessionID) {
        sessionID = await this.#sessions.create({
          cwd: task.cwd,
          model: task.model,
          taskID: task.id,
        });
        const createdSessionID = sessionID;
        await this.#updateTask(task.id, (current) => {
          current.sessionID = createdSessionID;
          current.startedAt ??= new Date(this.#clock.now()).toISOString();
        });
      } else if (resume) {
        await this.#sessions.wait(sessionID);
        const state = await this.#sessions.get(sessionID);
        if (state.outcome === "succeeded") {
          await this.#complete(task.id);
          return;
        }
      }

      const current = await this.#taskByID(task.id);
      if (current?.state === "CANCELLED") return;
      if (!sessionID) throw new Error("OpenCode did not return a session ID.");
      const prompt = resume
        ? `Continue the task in this session from the current project state. Avoid repeating work that is already complete.\n\nOriginal task:\n${task.prompt}`
        : task.prompt;
      await this.#sessions.prompt(sessionID, prompt);
      await this.#sessions.wait(sessionID);
      const finalState = await this.#sessions.get(sessionID);
      const latest = await this.#taskByID(task.id);
      if (latest?.state === "CANCELLED" || latest?.state === "WAITING_OFFPEAK") return;
      if (finalState.outcome === "succeeded") {
        await this.#complete(task.id);
        return;
      }
      const message =
        finalState.outcome === "interrupted"
          ? "OpenCode interrupted the session. Use retry to continue this same session."
          : finalState.outcome === "failed"
            ? "OpenCode reported a failed session. Use retry to continue this same session."
            : "The session became idle without a succeeded outcome. Use retry to continue this same session.";
      await this.#fail(task.id, message);
    } catch (error) {
      const latest = await this.#taskByID(task.id).catch(() => undefined);
      if (latest?.state === "CANCELLED" || latest?.state === "WAITING_OFFPEAK") return;
      await this.#fail(task.id, error instanceof Error ? error.message : "OpenCode task failed.");
    }
  }

  async #complete(taskID: string): Promise<void> {
    await this.#updateTask(taskID, (task) => {
      task.state = "COMPLETED";
      task.completedAt = new Date(this.#clock.now()).toISOString();
      delete task.lastError;
      delete task.overrideUntil;
      task.resumeRequested = false;
    });
  }

  async #fail(taskID: string, message: string): Promise<void> {
    await this.#updateTask(taskID, (task) => {
      task.state = "FAILED";
      task.lastError = message;
      delete task.overrideUntil;
      task.resumeRequested = false;
    });
  }

  async #reconcileAfterLoad(): Promise<void> {
    const queue = await this.#lock.run(() => this.#repo.load());
    for (const task of queue.tasks) {
      if (task.state === "RUNNING") {
        if (!task.sessionID) {
          await this.#fail(
            task.id,
            "Server restarted before the session ID was recorded; use retry.",
          );
          continue;
        }
        this.#runners.add(task.id);
        void this.#reconcileRunning(task);
      }
    }
  }

  async #reconcileRunning(task: OffpeakTask): Promise<void> {
    const sessionID = task.sessionID;
    if (!sessionID) {
      await this.#fail(task.id, "The stored OpenCode session ID is missing; use retry.");
      this.#runners.delete(task.id);
      this.#requestPump();
      return;
    }
    try {
      await this.#sessions.wait(sessionID);
      const session = await this.#sessions.get(sessionID);
      if (session.outcome === "succeeded") {
        await this.#complete(task.id);
      } else {
        await this.#fail(
          task.id,
          "OpenCode restarted while this task was RUNNING. The provider outcome may be ambiguous; use retry to explicitly continue the same session.",
        );
      }
    } catch (error) {
      await this.#fail(
        task.id,
        `OpenCode restart left the task outcome ambiguous: ${error instanceof Error ? error.message : "unknown error"}. Use retry to continue the same session.`,
      );
    } finally {
      this.#runners.delete(task.id);
      this.#signal.notify();
      this.#requestPump();
    }
  }
}
