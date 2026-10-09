import { type FSWatcher, mkdirSync, watch } from "node:fs";
import path from "node:path";
import type { ConfigRepository, OffpeakConfig } from "./config.js";
import { evaluatePricing, type PolicyDecision } from "./policy.js";
import {
  AsyncSignal,
  Mutex,
  type OffpeakTask,
  type QueueRepository,
  type TaskModel,
  type TaskState,
} from "./store.js";

export interface SessionDriver {
  create(input: { cwd: string; model: TaskModel; taskID: string }): Promise<string>;
  prompt(sessionID: string, text: string): Promise<void>;
  wait(sessionID: string): Promise<void>;
  get(sessionID: string): Promise<{ outcome?: "succeeded" | "failed" | "interrupted" }>;
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
  failed: number;
  tasks: OffpeakTask[];
  configPath: string;
  configError?: string;
}

export interface GuardInput {
  sessionID: string;
  providerID: string;
  modelID: string;
  transport: "http" | "websocket";
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
  readonly #signal = new AsyncSignal();
  readonly #runners = new Set<string>();
  #timer: NodeJS.Timeout | undefined;
  #watcher: FSWatcher | undefined;
  #disposed = false;
  #pumping: Promise<void> | undefined;
  #pumpRequested = false;

  constructor(options: EngineOptions) {
    this.#repo = options.repository;
    this.#config = options.config;
    this.#sessions = options.sessions;
    this.#clock = options.clock ?? systemClock;
    this.#id = options.id ?? (() => crypto.randomUUID());
    this.#onError = options.onError ?? (() => undefined);
  }

  async start(): Promise<void> {
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
      failed: tasks.filter((task) => task.state === "FAILED").length,
      tasks,
      configPath: settings.path,
      ...(settings.error ? { configError: settings.error } : {}),
    };
  }

  async guardRequest(input: GuardInput): Promise<void> {
    const task = await this.#taskForSession(input.sessionID);
    const first = await this.#config.read();
    if (!first.config)
      throw new PricingBlockedError(`Offpeak pricing guard failed closed: ${first.error}`);
    let decision = evaluatePricing(
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
      while (!this.#disposed) {
        const signalVersion = this.#signal.version();
        const settings = await this.#config.read();
        if (!settings.config)
          throw new PricingBlockedError(`Offpeak pricing guard failed closed: ${settings.error}`);
        decision = evaluatePricing(
          settings.config.policies,
          input.providerID,
          input.modelID,
          this.#clock.now(),
        );
        if (decision.state === "UNKNOWN") {
          await this.#setTaskError(task.id, decision.reason);
          throw new PricingBlockedError(`Offpeak pricing guard failed closed: ${decision.reason}`);
        }
        if (
          settings.config.enabled &&
          this.#hasOverride(await this.#taskByID(task.id), this.#clock.now())
        ) {
          await this.#transition(task.id, "RUNNING");
          return;
        }
        if (settings.config.enabled && decision.allowed) {
          await this.#transition(task.id, "RUNNING");
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
    }

    if (task) await this.#transition(task.id, "WAITING_OFFPEAK");
    const reason = !first.config.enabled
      ? "OpenCode Offpeak is disabled; automatic task execution is paused and peak pricing remains blocked."
      : `${input.providerID}/${input.modelID} is in a peak-price window under policy ${decision.policy?.id}.`;
    throw new PricingBlockedError(
      `${reason} Use /offpeak run-now <task-id> for an explicit 15-minute task override.`,
    );
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
