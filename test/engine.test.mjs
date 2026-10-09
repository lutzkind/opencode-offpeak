import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigRepository,
  defaultConfig,
  OffpeakEngine,
  PricingBlockedError,
  QueueRepository,
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

class FakeSessions {
  next = 0;
  prompts = [];
  workers = new Map();
  outcomes = new Map();
  behavior = async () => undefined;
  createdTasks = [];
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
      .then(() => this.outcomes.set(sessionID, "succeeded"))
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
    const outcome = this.outcomes.get(sessionID);
    return outcome ? { outcome } : {};
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
  const clock = new FakeClock(now);
  const storage = options.storage ?? new MemoryStorage();
  const sessions = options.sessions ?? new FakeSessions();
  const config = new ConfigRepository({
    configPath: path.join(root, "offpeak.json"),
    ...(options.options ?? {}),
  });
  const engine = new OffpeakEngine({
    repository: new QueueRepository(storage),
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
