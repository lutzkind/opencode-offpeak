import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigRepository,
  defaultConfig,
  OffpeakEngine,
  PricingBlockedError,
  QueueRepository,
  RecoveryRepository,
} from "../dist/index.js";

class MemoryStorage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

class FakeClock {
  constructor(now) {
    this.value = Date.parse(now);
  }
  now = () => this.value;
  setTimeout = (callback, milliseconds) => {
    const timer = setTimeout(callback, milliseconds);
    timer.unref();
    return timer;
  };
  clearTimeout = (timer) => clearTimeout(timer);
  set(value) {
    this.value = Date.parse(value);
  }
}

class ManualClock {
  constructor(now) {
    this.value = Date.parse(now);
    this.timers = new Set();
    this.sequence = 0;
  }
  now = () => this.value;
  setTimeout = (callback, milliseconds) => {
    const timer = { id: ++this.sequence, at: this.value + Math.max(0, milliseconds), callback };
    this.timers.add(timer);
    return timer;
  };
  clearTimeout = (timer) => {
    this.timers.delete(timer);
  };
  set(value) {
    this.value = Date.parse(value);
  }
  async advanceTo(value) {
    this.value = Date.parse(value);
    await this.flush();
  }
  async flush() {
    for (let round = 0; round < 200; round += 1) {
      const due = [...this.timers].filter((timer) => timer.at <= this.value);
      if (!due.length) return;
      for (const timer of due) {
        this.timers.delete(timer);
        timer.callback();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("ManualClock did not settle");
  }
}

class FakeSessions {
  next = 0;
  prompts = [];
  workers = new Map();
  outcomes = new Map();
  behavior = async () => undefined;
  createdTasks = [];
  snapshots = new Map();
  missing = new Set();
  titles = [];
  titleBehavior = async () => undefined;
  async create(input) {
    const id = `session-${++this.next}`;
    this.createdTasks.push({ id, taskID: input.taskID, cwd: input.cwd, model: input.model });
    this.outcomes.set(id, undefined);
    return id;
  }
  async prompt(sessionID, text) {
    this.prompts.push({ sessionID, text });
    const worker = Promise.resolve()
      .then(() => this.behavior({ sessionID, text }))
      .then((result) => this.outcomes.set(sessionID, result?.outcome ?? "succeeded"))
      .catch((error) => {
        this.outcomes.set(sessionID, "failed");
        throw error;
      });
    this.workers.set(sessionID, worker);
  }
  async wait(sessionID) {
    await this.workers.get(sessionID)?.catch(() => undefined);
  }
  async get(sessionID) {
    if (this.missing.has(sessionID)) throw new Error(`Session not found: ${sessionID}`);
    const outcome = this.outcomes.get(sessionID);
    const extra = this.snapshots.get(sessionID) ?? {};
    return { ...(outcome ? { outcome } : {}), ...extra };
  }
  async generateTitle(sessionID) {
    this.titles.push(sessionID);
    await this.titleBehavior(sessionID);
  }
  async interrupt(sessionID) {
    this.outcomes.set(sessionID, "interrupted");
  }
}

async function until(predicate, message = "condition was not reached") {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function harness(now = "2026-10-12T00:30:00Z", options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-test-"));
  const clock = options.clock ?? new FakeClock(now);
  const storage = options.storage ?? new MemoryStorage();
  const sessions = options.sessions ?? new FakeSessions();
  const config = new ConfigRepository({
    configPath: path.join(root, "offpeak.json"),
    ...(options.options ?? {}),
  });
  const engine = new OffpeakEngine({
    repository: new QueueRepository(storage),
    recoveries: new RecoveryRepository(storage),
    location: options.location ?? "test-location",
    config,
    sessions,
    clock,
    id: options.id ?? (() => `task-${Math.random().toString(16).slice(2, 8)}`),
  });
  await engine.start();
  return {
    root,
    clock,
    storage,
    sessions,
    config,
    engine,
    async close() {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

const selectedModel = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" };

test("defaults enabled and persists both toggle states across engine restart", async () => {
  const h = await harness();
  try {
    assert.equal((await h.engine.status(selectedModel)).enabled, true);
    await h.engine.setEnabled(false);
    assert.equal((await h.engine.status(selectedModel)).enabled, false);
    await h.engine.dispose();
    const restarted = new OffpeakEngine({
      repository: new QueueRepository(h.storage),
      config: h.config,
      sessions: h.sessions,
      clock: h.clock,
    });
    await restarted.start();
    assert.equal((await restarted.status(selectedModel)).enabled, false);
    await restarted.setEnabled(true);
    assert.equal((await restarted.status(selectedModel)).enabled, true);
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("queue order, persistence, cancellation, and retry metadata are retained", async () => {
  const h = await harness("2026-10-12T12:00:00Z");
  try {
    await h.engine.setEnabled(false);
    const first = await h.engine.queue({
      prompt: "first task",
      cwd: "/project",
      model: selectedModel,
    });
    const second = await h.engine.queue({
      prompt: "second task",
      cwd: "/project",
      model: selectedModel,
    });
    const listed = await h.engine.list();
    assert.deepEqual(
      listed.map((task) => task.id),
      [first.id, second.id],
    );
    await h.engine.cancel(first.id);
    const afterCancel = await h.engine.list();
    assert.equal(afterCancel[0].state, "CANCELLED");
    assert.equal(afterCancel[1].state, "QUEUED");
    await h.close();
    const restarted = await harness("2026-10-12T12:00:00Z", { storage: h.storage });
    try {
      const persisted = await restarted.engine.list();
      assert.deepEqual(
        persisted.map((task) => task.id),
        [first.id, second.id],
      );
      assert.equal(persisted[0].state, "CANCELLED");
      assert.equal(persisted[1].state, "QUEUED");
    } finally {
      await restarted.close();
    }
  } finally {
    // The first harness may already have been closed above.
    await h.close();
  }
});

test("remove deletes only terminal tasks and persists the deletion", async () => {
  const h = await harness("2026-10-12T00:30:00Z");
  try {
    const completed = await h.engine.queue({
      prompt: "completed task",
      cwd: "/project",
      model: selectedModel,
    });
    await until(async () => (await h.engine.list())[0]?.state === "COMPLETED");
    await h.engine.setEnabled(false);
    const queued = await h.engine.queue({
      prompt: "still queued",
      cwd: "/project",
      model: selectedModel,
    });
    await assert.rejects(h.engine.remove(queued.id), /cancel it before removing/);
    await assert.rejects(h.engine.remove("missing-task"), /was not found/);
    await h.engine.remove(completed.id);
    assert.deepEqual(
      (await h.engine.list()).map((task) => task.id),
      [queued.id],
    );
    await h.close();
    const restarted = await harness("2026-10-12T00:30:00Z", { storage: h.storage });
    try {
      assert.deepEqual(
        (await restarted.engine.list()).map((task) => task.id),
        [queued.id],
      );
    } finally {
      await restarted.close();
    }
  } finally {
    await h.close();
  }
});

test("OFF preserves queued tasks and does not start them or permit peak inference", async () => {
  const h = await harness("2026-10-12T00:30:00Z");
  try {
    await h.engine.setEnabled(false);
    const task = await h.engine.queue({
      prompt: "preserve this",
      cwd: "/project",
      model: selectedModel,
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal((await h.engine.list())[0].id, task.id);
    h.clock.set("2026-10-12T02:00:00Z");
    await assert.rejects(
      h.engine.guardRequest({ sessionID: "interactive", ...selectedModel, transport: "http" }),
      PricingBlockedError,
    );
    h.clock.set("2026-10-12T04:00:00Z");
    await h.engine.setEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal((await h.engine.list()).find((item) => item.id === task.id).state, "QUEUED");
    await h.engine.setEnabled(true);
    await until(async () => h.sessions.prompts.length === 1);
    assert.equal((await h.engine.list())[0].sessionID, "session-1");
  } finally {
    await h.close();
  }
});

test("task crossing peak waits at the request boundary and resumes the same session after OFF then ON", async () => {
  const h = await harness();
  const enteredPeak = {};
  enteredPeak.promise = new Promise((resolve) => (enteredPeak.resolve = resolve));
  let providerRequests = 0;
  h.sessions.behavior = async ({ sessionID }) => {
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    providerRequests += 1;
    h.clock.set("2026-10-12T01:00:00Z");
    enteredPeak.resolve();
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    providerRequests += 1;
  };
  try {
    const task = await h.engine.queue({
      prompt: "continue across the window",
      cwd: "/project",
      model: selectedModel,
    });
    await enteredPeak.promise;
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    const waiting = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(waiting.sessionID, "session-1");
    assert.equal(providerRequests, 1);
    await h.engine.setEnabled(false);
    h.clock.set("2026-10-12T04:00:00Z");
    await h.engine.setEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(providerRequests, 1);
    assert.equal(
      (await h.engine.list()).find((item) => item.id === task.id).state,
      "WAITING_OFFPEAK",
    );
    await h.engine.setEnabled(true);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    const complete = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(providerRequests, 2);
    assert.equal(complete.sessionID, "session-1");
    assert.equal(h.sessions.prompts.length, 1);
  } finally {
    await h.close();
  }
});

test("an explicit task override is separate from OFF and allows peak inference for 15 minutes", async () => {
  const h = await harness("2026-10-12T02:00:00Z");
  let allowed = false;
  let finishTask;
  const hold = new Promise((resolve) => (finishTask = resolve));
  h.sessions.behavior = async ({ sessionID }) => {
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    allowed = true;
    await hold;
  };
  try {
    const task = await h.engine.queue({
      prompt: "intentional peak task",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    await h.engine.setEnabled(false);
    await assert.rejects(h.engine.runNow(task.id), /Turn \/offpeak on/);
    await h.engine.setEnabled(true);
    await h.engine.runNow(task.id);
    await until(async () => allowed);
    const status = await h.engine.status(selectedModel);
    assert.equal(status.override.active, true);
    assert.equal(status.override.taskID, task.id);
    assert.equal(allowed, true);
    finishTask();
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
  } finally {
    await h.close();
  }
});

test("expired overrides restore the hard peak guard", async () => {
  const h = await harness("2026-10-12T02:00:00Z");
  let holdTask;
  const hold = new Promise((resolve) => (holdTask = resolve));
  h.sessions.behavior = async () => hold;
  try {
    await h.engine.setEnabled(false);
    const task = await h.engine.queue({
      prompt: "expire override",
      cwd: "/project",
      model: selectedModel,
    });
    await h.engine.setEnabled(true);
    await h.engine.runNow(task.id);
    await until(async () => (await h.engine.list()).find((item) => item.id === task.id)?.sessionID);
    const stored = (await h.engine.list()).find((item) => item.id === task.id);
    h.clock.set("2026-10-12T02:16:00Z");
    const blocked = h.engine.guardRequest({
      sessionID: stored.sessionID,
      ...selectedModel,
      transport: "http",
    });
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    assert.equal((await h.engine.status(selectedModel)).override.active, false);
    await h.engine.dispose();
    await assert.rejects(blocked, PricingBlockedError);
    holdTask();
  } finally {
    await h.close();
  }
});

test("retry continues the exact stored session and completed tasks are not requeued", async () => {
  const h = await harness("2026-10-12T00:30:00Z");
  let prompts = 0;
  h.sessions.behavior = async () => {
    prompts += 1;
    if (prompts === 1) throw new Error("fixture failure");
  };
  try {
    const task = await h.engine.queue({
      prompt: "resumable work",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () => (await h.engine.list()).find((item) => item.id === task.id)?.state === "FAILED",
    );
    const oldSession = (await h.engine.list()).find((item) => item.id === task.id).sessionID;
    h.sessions.behavior = async () => {
      prompts += 1;
    };
    await h.engine.retry(task.id);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    const complete = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(complete.sessionID, oldSession);
    assert.equal(complete.retryCount, 1);
    assert.equal(h.sessions.prompts.length, 2);
    assert.equal(h.sessions.prompts[0].sessionID, h.sessions.prompts[1].sessionID);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(h.sessions.prompts.length, 2);
  } finally {
    await h.close();
  }
});

test("multiple queued tasks create separate OpenCode sessions in FIFO order", async () => {
  const h = await harness();
  try {
    const first = await h.engine.queue({ prompt: "first", cwd: "/one", model: selectedModel });
    const second = await h.engine.queue({ prompt: "second", cwd: "/two", model: selectedModel });
    await until(async () => (await h.engine.list()).every((task) => task.state === "COMPLETED"));
    assert.deepEqual(
      h.sessions.createdTasks.map((entry) => entry.taskID),
      [first.id, second.id],
    );
    assert.notEqual(h.sessions.createdTasks[0].id, h.sessions.createdTasks[1].id);
    assert.deepEqual(
      h.sessions.createdTasks.map((entry) => entry.cwd),
      ["/one", "/two"],
    );
  } finally {
    await h.close();
  }
});

test("queue mode holds at peak until explicit resume, then continues the same session", async () => {
  const h = await harness();
  let providerRequests = 0;
  let promptCount = 0;
  h.sessions.behavior = async ({ sessionID }) => {
    promptCount += 1;
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    providerRequests += 1;
    if (promptCount === 1) {
      h.clock.set("2026-10-12T01:00:00Z");
      await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
      providerRequests += 1;
    }
  };
  try {
    await h.config.write({ ...defaultConfig(), mode: "queue" });
    const task = await h.engine.queue({
      prompt: "queue-mode work",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    const waiting = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(waiting.sessionID, "session-1");
    assert.equal(providerRequests, 1);
    h.clock.set("2026-10-12T04:00:00Z");
    await h.engine.setEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(
      (await h.engine.list()).find((item) => item.id === task.id).state,
      "WAITING_OFFPEAK",
    );
    assert.equal(promptCount, 1);
    await h.engine.resume(task.id);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    const complete = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(complete.sessionID, "session-1");
    assert.equal(providerRequests, 2);
    assert.equal(promptCount, 2);
  } finally {
    await h.close();
  }
});

test("a session success cannot overwrite a persisted peak-boundary pause", async () => {
  const h = await harness();
  let requestsSent = 0;
  h.sessions.behavior = async ({ sessionID }) => {
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    requestsSent += 1;
    h.clock.set("2026-10-12T01:00:00Z");
    try {
      await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
      requestsSent += 1;
    } catch (error) {
      assert.ok(error instanceof PricingBlockedError);
    }
  };
  try {
    await h.config.write({ ...defaultConfig(), mode: "queue" });
    const task = await h.engine.queue({
      prompt: "a blocked inference request must keep the task waiting",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    const stored = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(stored.sessionID, "session-1");
    assert.equal(stored.state, "WAITING_OFFPEAK");
    assert.equal(requestsSent, 1);
  } finally {
    await h.close();
  }
});

test("queue mode consumes one manual resume and waits for another after the next peak", async () => {
  const h = await harness();
  let providerRequests = 0;
  let promptCount = 0;
  h.sessions.behavior = async ({ sessionID }) => {
    promptCount += 1;
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    providerRequests += 1;
    if (promptCount < 3) {
      h.clock.set("2026-10-12T01:00:00Z");
      await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    }
  };
  try {
    await h.config.write({ ...defaultConfig(), mode: "queue" });
    const task = await h.engine.queue({
      prompt: "manual resume should be consumed",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    h.clock.set("2026-10-12T04:00:00Z");
    await h.engine.resume(task.id);
    await until(async () => promptCount === 2);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    h.clock.set("2026-10-12T04:00:00Z");
    await h.engine.setEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(promptCount, 2);
    assert.equal(providerRequests, 2);
    assert.equal(
      (await h.engine.list()).find((item) => item.id === task.id).state,
      "WAITING_OFFPEAK",
    );
    await h.engine.resume(task.id);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    assert.equal(promptCount, 3);
    assert.equal(providerRequests, 3);
  } finally {
    await h.close();
  }
});

test("run-now resumes a waiting task in guard mode", async () => {
  const h = await harness();
  let promptCount = 0;
  let releaseFirst;
  const firstGate = new Promise((resolve) => (releaseFirst = resolve));
  let firstReady;
  const ready = new Promise((resolve) => (firstReady = resolve));
  h.sessions.behavior = async ({ sessionID }) => {
    promptCount += 1;
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    if (promptCount === 1) {
      firstReady();
      await firstGate;
      await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    }
  };
  try {
    await h.config.write({ ...defaultConfig(), mode: "guard" });
    const task = await h.engine.queue({
      prompt: "guard mode explicit override",
      cwd: "/project",
      model: selectedModel,
    });
    await h.engine.runNow(task.id);
    await ready;
    h.clock.set("2026-10-12T02:16:00Z");
    releaseFirst();
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    await h.engine.runNow(task.id);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    assert.equal(promptCount, 2);
    assert.equal(
      (await h.engine.list()).find((item) => item.id === task.id).sessionID,
      "session-1",
    );
  } finally {
    await h.close();
  }
});

test("guard mode enforces pricing but does not automatically start the queue", async () => {
  const h = await harness();
  try {
    await h.config.write({ ...defaultConfig(), mode: "guard" });
    const task = await h.engine.queue({
      prompt: "manual queue task",
      cwd: "/project",
      model: selectedModel,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal((await h.engine.list()).find((item) => item.id === task.id).state, "QUEUED");
    const status = await h.engine.status(selectedModel);
    assert.equal(status.automaticExecution, "PAUSED");
    await h.engine.runNow(task.id);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    assert.equal(h.sessions.prompts.length, 1);
  } finally {
    await h.close();
  }
});

test("RUNNING crash recovery never blindly replays an ambiguous provider outcome", async () => {
  const h = await harness("2026-10-12T12:00:00Z");
  await h.engine.dispose();
  try {
    const repository = new QueueRepository(h.storage);
    await repository.save({
      schemaVersion: 1,
      tasks: [
        {
          id: "ambiguous",
          prompt: "may have been sent",
          cwd: "/project",
          sessionID: "existing-session",
          model: selectedModel,
          policyID: "deepseek-opencode-go",
          state: "RUNNING",
          createdAt: "2026-10-12T00:00:00.000Z",
          startedAt: "2026-10-12T00:00:01.000Z",
          lastTransition: "2026-10-12T00:00:01.000Z",
          retryCount: 0,
        },
      ],
    });
    h.sessions.outcomes.set("existing-session", "interrupted");
    const recovered = new OffpeakEngine({
      repository,
      config: h.config,
      sessions: h.sessions,
      clock: h.clock,
    });
    await recovered.start();
    await until(async () => (await recovered.list())[0]?.state === "FAILED");
    const task = (await recovered.list())[0];
    assert.match(task.lastError, /ambiguous/);
    assert.equal(task.sessionID, "existing-session");
    assert.equal(h.sessions.prompts.length, 0);
    await recovered.dispose();
  } finally {
    await h.close();
  }
});

test("successful RUNNING recovery marks complete without replaying the session", async () => {
  const h = await harness("2026-10-12T12:00:00Z");
  await h.engine.dispose();
  try {
    const repository = new QueueRepository(h.storage);
    await repository.save({
      schemaVersion: 1,
      tasks: [
        {
          id: "already-succeeded",
          prompt: "do not replay",
          cwd: "/project",
          sessionID: "successful-session",
          model: selectedModel,
          policyID: "deepseek-opencode-go",
          state: "RUNNING",
          createdAt: "2026-10-12T00:00:00.000Z",
          lastTransition: "2026-10-12T00:00:01.000Z",
          retryCount: 0,
        },
      ],
    });
    h.sessions.outcomes.set("successful-session", "succeeded");
    const recovered = new OffpeakEngine({
      repository,
      config: h.config,
      sessions: h.sessions,
      clock: h.clock,
    });
    await recovered.start();
    await until(async () => (await recovered.list())[0]?.state === "COMPLETED");
    assert.equal((await recovered.list())[0].sessionID, "successful-session");
    assert.equal(h.sessions.prompts.length, 0);
    await recovered.dispose();
  } finally {
    await h.close();
  }
});

test("WAITING_OFFPEAK recovery resumes automatically in the stored session", async () => {
  const h = await harness("2026-10-12T02:00:00Z");
  await h.engine.dispose();
  try {
    const repository = new QueueRepository(h.storage);
    await repository.save({
      schemaVersion: 1,
      tasks: [
        {
          id: "safe-waiter",
          prompt: "continue safely",
          cwd: "/project",
          sessionID: "waiting-session",
          model: selectedModel,
          policyID: "deepseek-opencode-go",
          state: "WAITING_OFFPEAK",
          createdAt: "2026-10-12T00:00:00.000Z",
          lastTransition: "2026-10-12T01:00:00.000Z",
          retryCount: 0,
        },
      ],
    });
    h.sessions.outcomes.set("waiting-session", "interrupted");
    const recovered = new OffpeakEngine({
      repository,
      config: h.config,
      sessions: h.sessions,
      clock: h.clock,
    });
    await recovered.start();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await recovered.list())[0].state, "WAITING_OFFPEAK");
    assert.equal(h.sessions.prompts.length, 0);
    h.clock.set("2026-10-12T04:00:00Z");
    await recovered.setEnabled(true);
    await until(async () => (await recovered.list())[0]?.state === "COMPLETED");
    assert.equal((await recovered.list())[0].sessionID, "waiting-session");
    assert.equal(h.sessions.prompts.length, 1);
    assert.equal(h.sessions.prompts[0].sessionID, "waiting-session");
    assert.match(h.sessions.prompts[0].text, /Continue the task/);
    await recovered.dispose();
  } finally {
    await h.close();
  }
});

test("invalid plugin options and OpenCode config paths are handled without permitting requests", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-options-"));
  try {
    const invalid = new ConfigRepository({ enabled: "yes" }, { OPENCODE_CONFIG_DIR: root });
    const result = await invalid.read();
    assert.match(result.error, /enabled.*boolean/);
    assert.equal(invalid.path, path.join(root, "offpeak.json"));
    const xdg = new ConfigRepository({}, { XDG_CONFIG_HOME: root });
    assert.equal(xdg.path, path.join(root, "opencode", "offpeak.json"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("invalid configuration and unknown configured models block before transport", async () => {
  const h = await harness("2026-10-12T12:00:00Z");
  try {
    await assert.rejects(
      h.engine.guardRequest({
        sessionID: "interactive",
        providerID: "opencode-go",
        modelID: "unpublished-model",
        transport: "http",
      }),
      PricingBlockedError,
    );
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      h.config.path,
      JSON.stringify({ ...defaultConfig(), displayTimeZone: "Invalid/Zone" }),
    );
    await assert.rejects(
      h.engine.guardRequest({ sessionID: "interactive", ...selectedModel, transport: "http" }),
      PricingBlockedError,
    );
  } finally {
    await h.close();
  }
});

test("auto mode holds a normal interactive request at the pricing boundary and releases it at the scheduled transition", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  let releases = 0;
  let rejections = 0;
  let providerRequests = 0;
  const pending = h.engine
    .guardRequest({ sessionID: "interactive-session-1", ...selectedModel, transport: "http" })
    .then(
      () => {
        releases += 1;
        providerRequests += 1;
      },
      () => {
        rejections += 1;
      },
    );
  try {
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    assert.equal(releases, 0);
    assert.equal(rejections, 0);
    assert.equal(providerRequests, 0);
    assert.deepEqual(await h.engine.list(), []);
    assert.equal(h.sessions.createdTasks.length, 0);
    assert.equal(h.sessions.prompts.length, 0);

    // Only the scheduled pricing-boundary timer fires here: no config edit, no
    // new user input, no status command, and no external wake-up.
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => releases === 1);
    assert.equal(providerRequests, 1);
    assert.equal(rejections, 0);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(providerRequests, 1);
    assert.equal(releases, 1);
    assert.equal(rejections, 0);
    assert.equal(h.sessions.createdTasks.length, 0);
    assert.equal(h.sessions.prompts.length, 0);
    assert.deepEqual(await h.engine.list(), []);
    await pending;
  } finally {
    await h.close();
  }
});

test("OFF does not release a held interactive request and stays passive at the boundary", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  let releases = 0;
  let rejections = 0;
  const pending = h.engine
    .guardRequest({ sessionID: "interactive-off", ...selectedModel, transport: "http" })
    .then(
      () => {
        releases += 1;
      },
      () => {
        rejections += 1;
      },
    );
  try {
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    await h.engine.setEnabled(false);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(releases, 0);
    assert.equal(rejections, 0);

    // A fresh interactive peak request while OFF is blocked immediately, not held.
    await assert.rejects(
      h.engine.guardRequest({
        sessionID: "interactive-off-2",
        ...selectedModel,
        transport: "http",
      }),
      PricingBlockedError,
    );
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 1);

    // The off-peak boundary passes while OFF: the held request is not released.
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(releases, 0);
    assert.equal(rejections, 0);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 1);

    await h.engine.setEnabled(true);
    await until(async () => releases === 1);
    assert.equal(rejections, 0);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
    await pending;
  } finally {
    await h.close();
  }
});

test("plugin shutdown while an interactive request waits fails closed without transport", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  let providerRequests = 0;
  const outcome = h.engine
    .guardRequest({ sessionID: "interactive-shutdown", ...selectedModel, transport: "http" })
    .then(
      () => {
        providerRequests += 1;
        return undefined;
      },
      (error) => error,
    );
  try {
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    await h.engine.dispose();
    const error = await outcome;
    assert.ok(error instanceof PricingBlockedError);
    assert.match(error.message, /shutting down/);
    assert.equal(providerRequests, 0);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
  } finally {
    await h.close();
  }
});

test("queue and guard modes block interactive requests immediately instead of holding them", async () => {
  const h = await harness("2026-10-12T01:30:00Z");
  try {
    await h.config.write({ ...defaultConfig(), mode: "guard" });
    await assert.rejects(
      h.engine.guardRequest({
        sessionID: "interactive-guard",
        ...selectedModel,
        transport: "http",
      }),
      PricingBlockedError,
    );
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);

    await h.config.write({ ...defaultConfig(), mode: "queue" });
    await assert.rejects(
      h.engine.guardRequest({
        sessionID: "interactive-queue",
        ...selectedModel,
        transport: "http",
      }),
      PricingBlockedError,
    );
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
  } finally {
    await h.close();
  }
});

test("UNKNOWN configured models fail closed and UNTRACKED providers keep passing through", async () => {
  const h = await harness("2026-10-12T01:30:00Z");
  try {
    await assert.rejects(
      h.engine.guardRequest({
        sessionID: "interactive-unknown",
        providerID: "opencode-go",
        modelID: "unpublished-model",
        transport: "http",
      }),
      PricingBlockedError,
    );
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);

    await h.engine.guardRequest({
      sessionID: "interactive-untracked",
      providerID: "unrelated-provider",
      modelID: "unrelated-model",
      transport: "http",
    });
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
  } finally {
    await h.close();
  }
});

test("queue-owned auto tasks still resume at the scheduled boundary without external wake-ups", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  let providerRequests = 0;
  h.sessions.behavior = async ({ sessionID }) => {
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    providerRequests += 1;
  };
  try {
    const task = await h.engine.queue({
      prompt: "queue boundary resume",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    const stored = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(providerRequests, 1);
    assert.equal(h.sessions.createdTasks.length, 1);
    assert.equal(stored.sessionID, h.sessions.createdTasks[0].id);
  } finally {
    await h.close();
  }
});

const CONTINUATION =
  "Continue the task in this session from the current project state. Avoid repeating work that is already complete.";

test("a retryable provider failure during peak moves a queued task to WAITING_OFFPEAK and continues the same session at the boundary", async () => {
  const clock = new ManualClock("2026-10-12T00:30:00Z");
  const h = await harness("2026-10-12T00:30:00Z", { clock });
  const prompts = [];
  h.sessions.behavior = async ({ sessionID, text }) => {
    prompts.push(text);
    if (text.startsWith("Continue the task")) return undefined;
    // The request started off-peak and crosses into the peak window before failing.
    clock.set("2026-10-12T01:30:00Z");
    const outcome = await h.engine.noteRetryFailure({
      sessionID,
      providerID: selectedModel.providerID,
      modelID: selectedModel.modelID,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal(outcome, "hold");
    return { outcome: "failed" };
  };
  try {
    const task = await h.engine.queue({
      prompt: "recover after timeout",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "WAITING_OFFPEAK",
    );
    const waiting = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(waiting.state, "WAITING_OFFPEAK");
    assert.equal(waiting.lastError, undefined);
    assert.ok(waiting.sessionID);
    assert.equal((await h.engine.status(selectedModel)).failed, 0);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
    const stored = (await h.engine.list()).find((item) => item.id === task.id);
    assert.equal(stored.sessionID, waiting.sessionID);
    assert.equal(h.sessions.createdTasks.length, 1);
    assert.equal(prompts.length, 2);
    assert.equal(prompts[0], "recover after timeout");
    assert.ok(prompts[1].startsWith(CONTINUATION));
    assert.ok(prompts[1].includes("recover after timeout"));
  } finally {
    await h.close();
  }
});

test("non-retryable failures during peak stay FAILED instead of waiting for off-peak", async () => {
  const clock = new ManualClock("2026-10-12T00:30:00Z");
  const h = await harness("2026-10-12T00:30:00Z", { clock });
  h.sessions.behavior = async ({ sessionID }) => {
    clock.set("2026-10-12T01:30:00Z");
    const outcome = await h.engine.noteRetryFailure({
      sessionID,
      providerID: selectedModel.providerID,
      modelID: selectedModel.modelID,
      errorType: "provider.invalid-request",
      willRetry: false,
    });
    assert.equal(outcome, "pass");
    return { outcome: "failed" };
  };
  try {
    const task = await h.engine.queue({
      prompt: "invalid request",
      cwd: "/project",
      model: selectedModel,
    });
    await until(
      async () => (await h.engine.list()).find((item) => item.id === task.id)?.state === "FAILED",
    );
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
  } finally {
    await h.close();
  }
});

test("a retryable interactive failure during peak registers a recovery and continues the same session once at the boundary", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "session-interactive-recovery";
  try {
    h.sessions.outcomes.set(sessionID, "failed");
    h.sessions.workers.set(sessionID, Promise.resolve());
    const outcome = await h.engine.noteRetryFailure({
      sessionID,
      providerID: selectedModel.providerID,
      modelID: selectedModel.modelID,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal(outcome, "hold");
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);
    assert.equal(h.sessions.prompts.length, 0);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => h.sessions.prompts.length === 1);
    assert.equal(h.sessions.prompts[0].sessionID, sessionID);
    assert.equal(h.sessions.prompts[0].text, CONTINUATION);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    assert.equal(h.sessions.createdTasks.length, 0);
    await clock.advanceTo("2026-10-13T00:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.prompts.length, 1);
  } finally {
    await h.close();
  }
});

test("retry recovery stays passive when OFF, in queue or guard mode, for untracked or unknown models, and under an override", async () => {
  const h = await harness("2026-10-12T01:30:00Z");
  const input = {
    sessionID: "session-pass",
    providerID: selectedModel.providerID,
    modelID: selectedModel.modelID,
    errorType: "provider.transport",
    willRetry: true,
  };
  try {
    await h.engine.setEnabled(false);
    assert.equal(await h.engine.noteRetryFailure(input), "pass");
    await h.engine.setEnabled(true);
    await h.config.write({ ...defaultConfig(), mode: "queue" });
    assert.equal(await h.engine.noteRetryFailure(input), "pass");
    await h.config.write({ ...defaultConfig(), mode: "guard" });
    assert.equal(await h.engine.noteRetryFailure(input), "pass");
    await h.config.write({ ...defaultConfig(), mode: "auto" });
    assert.equal(
      await h.engine.noteRetryFailure({
        ...input,
        providerID: "other-provider",
        modelID: "other-model",
      }),
      "pass",
    );
    assert.equal(
      await h.engine.noteRetryFailure({ ...input, modelID: "unpublished-model" }),
      "pass",
    );
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);

    const now = new Date().toISOString();
    const repository = new QueueRepository(h.storage);
    const queue = await repository.load();
    queue.tasks.push({
      id: "task-override",
      prompt: "override",
      cwd: "/project",
      sessionID: "session-override",
      model: selectedModel,
      policyID: "deepseek-opencode-go",
      state: "RUNNING",
      createdAt: now,
      lastTransition: now,
      retryCount: 0,
      overrideUntil: new Date(Date.now() + 10 * 60_000).toISOString(),
    });
    await repository.save(queue);
    assert.equal(
      await h.engine.noteRetryFailure({ ...input, sessionID: "session-override" }),
      "pass",
    );
    assert.equal(
      (await h.engine.list()).find((item) => item.id === "task-override").state,
      "RUNNING",
    );
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
  } finally {
    await h.close();
  }
});

test("interactive recoveries persist across engine restart and stay scoped to their location", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const storage = new MemoryStorage();
  const sessions = new FakeSessions();
  const h = await harness("2026-10-12T01:30:00Z", { clock, storage, sessions });
  const sessionID = "session-persist";
  try {
    sessions.outcomes.set(sessionID, "failed");
    await h.engine.noteRetryFailure({
      sessionID,
      providerID: selectedModel.providerID,
      modelID: selectedModel.modelID,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);
    await h.engine.dispose();

    const other = new OffpeakEngine({
      repository: new QueueRepository(storage),
      recoveries: new RecoveryRepository(storage),
      location: "other-location",
      config: h.config,
      sessions,
      clock,
    });
    await other.start();
    assert.equal((await other.status(selectedModel)).recoveryWaiting, 0);
    await other.dispose();

    const restarted = new OffpeakEngine({
      repository: new QueueRepository(storage),
      recoveries: new RecoveryRepository(storage),
      location: "test-location",
      config: h.config,
      sessions,
      clock,
    });
    await restarted.start();
    assert.equal((await restarted.status(selectedModel)).recoveryWaiting, 1);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => sessions.prompts.length === 1);
    assert.equal(sessions.prompts[0].sessionID, sessionID);
    assert.equal(sessions.prompts[0].text, CONTINUATION);
    assert.equal((await restarted.status(selectedModel)).recoveryWaiting, 0);
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("a new held interactive request supersedes a pending recovery for the same session", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "session-supersede";
  try {
    h.sessions.outcomes.set(sessionID, "failed");
    await h.engine.noteRetryFailure({
      sessionID,
      providerID: selectedModel.providerID,
      modelID: selectedModel.modelID,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);
    const held = h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await held;
    assert.equal(h.sessions.prompts.length, 0);
  } finally {
    await h.close();
  }
});

test("a recovery is skipped when the session already succeeded or never settles", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const succeeded = "session-succeeded";
  const unsettled = "session-unsettled";
  try {
    h.sessions.outcomes.set(succeeded, "succeeded");
    await h.engine.noteRetryFailure({
      sessionID: succeeded,
      providerID: selectedModel.providerID,
      modelID: selectedModel.modelID,
      errorType: "provider.transport",
      willRetry: true,
    });
    await h.engine.noteRetryFailure({
      sessionID: unsettled,
      providerID: selectedModel.providerID,
      modelID: selectedModel.modelID,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 2);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 1);
    assert.equal(h.sessions.prompts.length, 0);
    // The unsettled session is retried briefly, then dropped without sending.
    await clock.advanceTo("2026-10-12T04:06:00Z");
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 0);
    assert.equal(h.sessions.prompts.length, 0);
  } finally {
    await h.close();
  }
});

test("a primary model.request guard defers the interactive request before transport and releases it at the boundary", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  let releases = 0;
  let rejections = 0;
  const pending = h.engine
    .guardModelRequest({
      sessionID: "model-request-session",
      ...selectedModel,
      kind: "primary",
      transport: "model",
    })
    .then(
      () => {
        releases += 1;
      },
      () => {
        rejections += 1;
      },
    );
  try {
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    assert.equal(releases, 0);
    assert.equal(rejections, 0);
    // The primary deferral is persisted so a restart can continue the same session.
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);

    // Only the scheduled pricing boundary fires; no config edit and no external wake-up.
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => releases === 1);
    assert.equal(rejections, 0);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(releases, 1);
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal(h.sessions.createdTasks.length, 0);
    await pending;

    // The transport guard still passes after the deferred release.
    await h.engine.guardRequest({
      sessionID: "model-request-session",
      ...selectedModel,
      transport: "http",
    });
  } finally {
    await h.close();
  }
});

test("an auxiliary model.request hold waits without a primary deferral; a title hold persists a pending-title marker", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  let releases = 0;
  const pending = h.engine
    .guardModelRequest({
      sessionID: "title-session",
      ...selectedModel,
      kind: "title",
      transport: "model",
    })
    .then(() => {
      releases += 1;
    });
  try {
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    // A held title request persists a semantic pending-title marker; it is not
    // a primary continuation deferral.
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);
    assert.equal((await h.engine.status(selectedModel)).titleRecoveryWaiting, 1);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => releases === 1);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    assert.equal((await h.engine.status(selectedModel)).titleRecoveryWaiting, 0);
    await pending;
  } finally {
    await h.close();
  }
});

test("compaction and generate model.request holds register no recovery of any kind", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const holds = [
    h.engine
      .guardModelRequest({
        sessionID: "compaction-session",
        ...selectedModel,
        kind: "compaction",
        transport: "model",
      })
      .then(() => "released"),
    h.engine
      .guardModelRequest({
        sessionID: "generate-session",
        ...selectedModel,
        kind: "generate",
        transport: "model",
      })
      .then(() => "released"),
  ];
  try {
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 2);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    assert.deepEqual(await Promise.all(holds), ["released", "released"]);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
  } finally {
    await h.close();
  }
});

test("a deferred primary request survives a plugin reload and continues the same session once at the boundary", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "reload-deferred-session";
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
    .catch(() => "blocked");
  try {
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 1);
    // The plugin reloads: the held request fails closed, the deferral is kept.
    await h.engine.dispose();
    assert.equal(await pending, "blocked");
    const storage = h.storage;
    const restarted = new OffpeakEngine({
      repository: new QueueRepository(storage),
      recoveries: new RecoveryRepository(storage),
      location: "test-location",
      config: h.config,
      sessions: h.sessions,
      clock,
    });
    // The reloaded turn failed while it was deferred.
    h.sessions.outcomes.set(sessionID, "failed");
    h.sessions.workers.set(sessionID, Promise.resolve());
    await restarted.start();
    assert.equal((await restarted.status(selectedModel)).recoveryWaiting, 1);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => h.sessions.prompts.length === 1);
    assert.equal(h.sessions.prompts[0].sessionID, sessionID);
    assert.equal(h.sessions.prompts[0].text, CONTINUATION);
    assert.equal((await restarted.status(selectedModel)).recoveryWaiting, 0);
    assert.equal(h.sessions.createdTasks.length, 0);
    await clock.advanceTo("2026-10-13T00:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.prompts.length, 1);
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("a queue-owned session held at the model.request guard waits in WAITING_OFFPEAK and returns to RUNNING at the boundary", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const now = new Date(clock.now()).toISOString();
  const repository = new QueueRepository(h.storage);
  const queue = await repository.load();
  queue.tasks.push({
    id: "task-model-request",
    prompt: "queued work",
    cwd: "/project",
    sessionID: "task-session",
    model: selectedModel,
    policyID: "deepseek-opencode-go",
    state: "RUNNING",
    createdAt: now,
    lastTransition: now,
    retryCount: 0,
  });
  await repository.save(queue);
  let releases = 0;
  const pending = h.engine
    .guardModelRequest({
      sessionID: "task-session",
      ...selectedModel,
      kind: "primary",
      transport: "model",
    })
    .then(() => {
      releases += 1;
    });
  try {
    await until(async () => (await h.engine.list())[0].state === "WAITING_OFFPEAK");
    assert.equal(releases, 0);
    // The queue task is tracked by its own state; no interactive recovery is added.
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => releases === 1);
    assert.equal((await h.engine.list())[0].state, "RUNNING");
    await pending;
  } finally {
    await h.close();
  }
});

test("a deferral released normally leaves no continuation behind after the next boundary", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "release-clean-session";
  const pending = h.engine.guardModelRequest({
    sessionID,
    ...selectedModel,
    kind: "primary",
    transport: "model",
  });
  try {
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 1);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await pending;
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 0);
    // The session completed its turn after the release.
    h.sessions.outcomes.set(sessionID, "succeeded");
    await clock.advanceTo("2026-10-13T00:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.prompts.length, 0);
  } finally {
    await h.close();
  }
});

test("a user interrupt aborts a deferred hold and clears the deferral", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "user-interrupt-session";
  let rejections = 0;
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
    .then(
      () => "resolved",
      (error) => {
        rejections += 1;
        return error;
      },
    );
  try {
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 1);
    h.sessions.outcomes.set(sessionID, "interrupted");
    await h.engine.noteExecutionInterrupted({ sessionID, reason: "user" });
    const failure = await pending;
    assert.equal(rejections, 1);
    assert.ok(failure instanceof PricingBlockedError);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.prompts.length, 0);
  } finally {
    await h.close();
  }
});

test("an inactivity interrupt aborts the deferred hold and continues the same session once at the boundary", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "inactivity-session";
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
    .then(
      () => "resolved",
      (error) => error,
    );
  try {
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 1);
    h.sessions.outcomes.set(sessionID, "interrupted");
    h.sessions.workers.set(sessionID, Promise.resolve());
    await h.engine.noteExecutionInterrupted({ sessionID, reason: "inactivity" });
    const failure = await pending;
    assert.ok(failure instanceof PricingBlockedError);
    // The deferral survives the interrupt so no manual retry is needed.
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => h.sessions.prompts.length === 1);
    assert.equal(h.sessions.prompts[0].sessionID, sessionID);
    assert.equal(h.sessions.prompts[0].text, CONTINUATION);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    // No blind replay of the interrupted provider request, and no new session.
    assert.equal(h.sessions.createdTasks.length, 0);
  } finally {
    await h.close();
  }
});

test("a shutdown interrupt leaves the deferral in place for restart recovery", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "shutdown-session";
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
    .then(
      () => "resolved",
      (error) => error,
    );
  try {
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 1);
    await h.engine.noteExecutionInterrupted({ sessionID, reason: "shutdown" });
    assert.ok((await pending) instanceof PricingBlockedError);
    h.sessions.outcomes.set(sessionID, "failed");
    h.sessions.workers.set(sessionID, Promise.resolve());
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => h.sessions.prompts.length === 1);
    assert.equal(h.sessions.prompts[0].sessionID, sessionID);
    assert.equal(h.sessions.prompts[0].text, CONTINUATION);
  } finally {
    await h.close();
  }
});

test("a pending-title marker survives a plugin reload and clears once OpenCode names the session", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "pending-title-reload";
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "title", transport: "model" })
    .catch(() => "blocked");
  try {
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 1);
    // The plugin reloads mid-hold: the held request fails closed, the marker stays.
    await h.engine.dispose();
    assert.equal(await pending, "blocked");
    const restarted = new OffpeakEngine({
      repository: new QueueRepository(h.storage),
      recoveries: new RecoveryRepository(h.storage),
      location: "test-location",
      config: h.config,
      sessions: h.sessions,
      clock,
    });
    await restarted.start();
    assert.equal((await restarted.status(selectedModel)).titleRecoveryWaiting, 1);
    // OpenCode's own promotion names the session once the turn continues.
    h.sessions.snapshots.set(sessionID, {
      title: "Recovered title",
      created: Date.parse("2026-10-12T01:30:00Z"),
    });
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await restarted.status(selectedModel)).titleRecoveryWaiting === 0);
    // The recovery itself never mutates the session or sends a title request.
    assert.equal(h.sessions.titles.length, 0);
    assert.equal(h.sessions.prompts.length, 0);
    assert.deepEqual(await restarted.list(), []);
    await clock.advanceTo("2026-10-13T00:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.titles.length, 0);
    assert.equal(h.sessions.snapshots.get(sessionID).title, "Recovered title");
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("a pending-title recovery never overwrites a manual rename and clears its marker", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "pending-title-renamed";
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "title", transport: "model" })
    .catch(() => "blocked");
  try {
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 1);
    h.sessions.snapshots.set(sessionID, {
      title: "My manually chosen title",
      created: Date.parse("2026-10-12T01:30:00Z"),
    });
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 0);
    assert.equal(h.sessions.titles.length, 0);
    assert.equal(h.sessions.snapshots.get(sessionID).title, "My manually chosen title");
  } finally {
    await h.close();
    await pending;
  }
});

test("a pending-title recovery clears without a request when the title already exists", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "pending-title-completed";
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "title", transport: "model" })
    .catch(() => "blocked");
  try {
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 1);
    h.sessions.snapshots.set(sessionID, {
      title: "Generated by another process",
      created: Date.parse("2026-10-12T01:30:00Z"),
    });
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 0);
    assert.equal(h.sessions.titles.length, 0);
  } finally {
    await h.close();
    await pending;
  }
});

test("a pending title waits for OpenCode's promotion and never mutates the session itself", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "pending-title-fallback";
  const created = Date.parse("2026-10-12T01:30:00Z");
  const pending = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "title", transport: "model" })
    .catch(() => "blocked");
  try {
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 1);
    // The exact creation-time fallback still means the session needs a title.
    h.sessions.snapshots.set(sessionID, {
      title: `New session - ${new Date(created).toISOString()}`,
      created,
    });
    // An interruption (not a normal release) leaves the marker behind.
    await h.engine.noteExecutionInterrupted({ sessionID, reason: "inactivity" });
    assert.equal(await pending, "blocked");
    await clock.advanceTo("2026-10-12T04:00:00Z");
    // The marker keeps watching (bounded by the settle cap) instead of
    // renaming anything itself.
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal((await h.engine.status(selectedModel)).titleRecoveryWaiting, 1);
    assert.equal(h.sessions.titles.length, 0);
    // OpenCode's promotion names it; the marker then clears on the next check.
    h.sessions.snapshots.set(sessionID, { title: "Promoted title", created });
    await clock.advanceTo("2026-10-12T04:00:04Z");
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 0);
    assert.equal(h.sessions.titles.length, 0);
    assert.equal(h.sessions.snapshots.get(sessionID).title, "Promoted title");
  } finally {
    await h.close();
    await pending;
  }
});

test("a pending-title recovery is skipped for child sessions and unknown sessions", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const child = "pending-title-child";
  const missing = "pending-title-missing";
  const holds = [
    h.engine
      .guardModelRequest({ sessionID: child, ...selectedModel, kind: "title", transport: "model" })
      .catch(() => "blocked"),
    h.engine
      .guardModelRequest({
        sessionID: missing,
        ...selectedModel,
        kind: "title",
        transport: "model",
      })
      .catch(() => "blocked"),
  ];
  try {
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 2);
    // A reload persists both markers; the child is a subagent session, the other
    // session is gone entirely.
    h.sessions.snapshots.set(child, { parentID: "parent-session" });
    h.sessions.missing.add(missing);
    await h.engine.dispose();
    assert.deepEqual(await Promise.all(holds), ["blocked", "blocked"]);
    const restarted = new OffpeakEngine({
      repository: new QueueRepository(h.storage),
      recoveries: new RecoveryRepository(h.storage),
      location: "test-location",
      config: h.config,
      sessions: h.sessions,
      clock,
    });
    await restarted.start();
    assert.equal((await restarted.status(selectedModel)).titleRecoveryWaiting, 2);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await restarted.status(selectedModel)).titleRecoveryWaiting === 0);
    assert.equal(h.sessions.titles.length, 0);
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("a user cancel clears a pending-title marker; an inactivity interrupt keeps it", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const cancelled = "pending-title-cancelled";
  const interrupted = "pending-title-interrupted";
  const holds = [
    h.engine
      .guardModelRequest({
        sessionID: cancelled,
        ...selectedModel,
        kind: "title",
        transport: "model",
      })
      .then(
        () => "resolved",
        () => "blocked",
      ),
    h.engine
      .guardModelRequest({
        sessionID: interrupted,
        ...selectedModel,
        kind: "title",
        transport: "model",
      })
      .then(
        () => "resolved",
        () => "blocked",
      ),
  ];
  try {
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 2);
    await h.engine.noteExecutionInterrupted({ sessionID: cancelled, reason: "user" });
    await h.engine.noteExecutionInterrupted({ sessionID: interrupted, reason: "inactivity" });
    assert.deepEqual(await Promise.all(holds), ["blocked", "blocked"]);
    // The cancelled session keeps no marker; the inactivity-interrupted one does.
    assert.equal((await h.engine.status(selectedModel)).titleRecoveryWaiting, 1);
    // OpenCode's continuation promotion names the session after the boundary.
    h.sessions.snapshots.set(interrupted, {
      title: "After inactivity",
      created: Date.parse("2026-10-12T01:30:00Z"),
    });
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 0);
    assert.equal(h.sessions.titles.length, 0);
    assert.equal(h.sessions.snapshots.get(interrupted).title, "After inactivity");
  } finally {
    await h.close();
  }
});

test("a delivered primary continuation lets OpenCode name the session; the title marker only verifies", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "pending-title-with-continuation";
  const created = Date.parse("2026-10-12T01:30:00Z");
  // Both requests are held: the title marker and the primary deferral coexist.
  const holds = [
    h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "title", transport: "model" })
      .catch(() => "blocked"),
    h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
      .catch(() => "blocked"),
  ];
  try {
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 2);
    assert.equal((await h.engine.status(selectedModel)).titleRecoveryWaiting, 1);
    // OpenCode's own promotion of the continuation names the session.
    h.sessions.outcomes.set(sessionID, "interrupted");
    h.sessions.workers.set(sessionID, Promise.resolve());
    h.sessions.behavior = async ({ sessionID: id }) => {
      h.sessions.snapshots.set(id, { title: "Continuation title", created });
      return { outcome: "succeeded" };
    };
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => h.sessions.prompts.length === 1);
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 0);
    // The continuation carried the title; the marker never generated one itself.
    assert.equal(h.sessions.titles.length, 0);
    assert.equal(h.sessions.snapshots.get(sessionID).title, "Continuation title");
    await Promise.all(holds);
  } finally {
    await h.close();
  }
});

test("multiple reloads keep one pending-title marker until OpenCode names the session", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "pending-title-multi-reload";
  const hold = h.engine
    .guardModelRequest({ sessionID, ...selectedModel, kind: "title", transport: "model" })
    .catch(() => "blocked");
  try {
    await until(async () => (await h.engine.status(selectedModel)).titleRecoveryWaiting === 1);
    await h.engine.dispose();
    await hold;
    let engine = h.engine;
    for (let round = 0; round < 3; round += 1) {
      engine = new OffpeakEngine({
        repository: new QueueRepository(h.storage),
        recoveries: new RecoveryRepository(h.storage),
        location: "test-location",
        config: h.config,
        sessions: h.sessions,
        clock,
      });
      await engine.start();
      assert.equal((await engine.status(selectedModel)).titleRecoveryWaiting, 1);
      await engine.dispose();
    }
    h.sessions.snapshots.set(sessionID, {
      title: "Native name",
      created: Date.parse("2026-10-12T01:30:00Z"),
    });
    const final = new OffpeakEngine({
      repository: new QueueRepository(h.storage),
      recoveries: new RecoveryRepository(h.storage),
      location: "test-location",
      config: h.config,
      sessions: h.sessions,
      clock,
    });
    await final.start();
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await final.status(selectedModel)).titleRecoveryWaiting === 0);
    await clock.advanceTo("2026-10-13T00:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.titles.length, 0);
    assert.equal((await final.status(selectedModel)).titleRecoveryWaiting, 0);
    await final.dispose();
  } finally {
    await h.close();
  }
});

test("a stored copy of the built-in policy adopts the built-in holiday calendar and flat model list", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-policy-adopt-"));
  const configPath = path.join(root, "offpeak.json");
  const builtin = defaultConfig().policies[0];
  const legacy = structuredClone(builtin);
  delete legacy.holidays;
  delete legacy.flatModels;
  legacy.verifiedAt = "2026-10-09";
  const customized = {
    ...structuredClone(legacy),
    id: "custom-window",
    blocked: [{ days: [1], start: "22:00", end: "23:00" }],
  };
  const explicit = {
    ...structuredClone(legacy),
    id: "explicit-lists",
    holidays: [],
    flatModels: ["only-this-model"],
  };
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        mode: "auto",
        displayTimeZone: "UTC",
        policies: [legacy, customized, explicit],
      }),
    );
    const config = new ConfigRepository({ configPath });
    const read = await config.read();
    assert.equal(read.error, undefined);
    const [adopted, kept, keptExplicit] = read.config.policies;
    assert.equal(adopted.id, builtin.id);
    assert.deepEqual(adopted.holidays, builtin.holidays);
    // The live v0.1.4 copy pinned before the flat model list existed adopts it
    // at read time, which is what restores automatic titles on the live install.
    assert.deepEqual(adopted.flatModels, builtin.flatModels);
    // A customized window is preserved exactly and gains no built-in data.
    assert.deepEqual(kept.blocked, customized.blocked);
    assert.equal(kept.holidays, undefined);
    assert.equal(kept.flatModels, undefined);
    // Explicit lists are never replaced by the built-in ones.
    assert.deepEqual(keptExplicit.holidays, []);
    assert.deepEqual(keptExplicit.flatModels, ["only-this-model"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("explicit holiday and flat lists on the built-in policy id are preserved on read", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-policy-explicit-"));
  const configPath = path.join(root, "offpeak.json");
  const builtin = defaultConfig().policies[0];
  const explicit = { ...structuredClone(builtin), holidays: [], flatModels: ["only-this-model"] };
  try {
    await writeFile(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        enabled: true,
        mode: "auto",
        displayTimeZone: "UTC",
        policies: [explicit],
      }),
    );
    const config = new ConfigRepository({ configPath });
    const read = await config.read();
    assert.equal(read.error, undefined);
    assert.deepEqual(read.config.policies[0].holidays, []);
    assert.deepEqual(read.config.policies[0].flatModels, ["only-this-model"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
