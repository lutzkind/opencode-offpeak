import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigRepository,
  OffpeakEngine,
  PricingBlockedError,
  QueueRepository,
  RecoveryRepository,
  SESSION_OVERRIDES_STORAGE_KEY,
  SessionOverridesRepository,
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
  compactions = [];
  interrupts = 0;
  workers = new Map();
  outcomes = new Map();
  behavior = async () => undefined;
  createdTasks = [];
  snapshots = new Map();
  missing = new Set();
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
    if (this.missing.has(sessionID)) {
      const error = new Error(`Session not found: ${sessionID}`);
      Object.assign(error, { _tag: "SessionNotFoundError" });
      throw error;
    }
    const outcome = this.outcomes.get(sessionID);
    const extra = this.snapshots.get(sessionID) ?? {};
    return { ...(outcome !== undefined ? { outcome } : {}), ...extra };
  }
  async interrupt(sessionID) {
    this.interrupts += 1;
    this.outcomes.set(sessionID, "interrupted");
  }
  async compact(sessionID) {
    this.compactions.push(sessionID);
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

async function assertStillPending(outcome, milliseconds = 60) {
  const result = await Promise.race([
    outcome.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), milliseconds)),
  ]);
  assert.equal(result, "pending");
}

async function harness(now = "2026-10-12T01:30:00Z", options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-session-test-"));
  const clock = options.clock ?? new FakeClock(now);
  const storage = options.storage ?? new MemoryStorage();
  const sessions = options.sessions ?? new FakeSessions();
  const config = new ConfigRepository({
    configPath: path.join(root, "offpeak.json"),
    ...(options.options ?? {}),
  });
  const notifications = options.notifications ?? [];
  const engine = new OffpeakEngine({
    repository: new QueueRepository(storage),
    recoveries: new RecoveryRepository(storage),
    sessionOverrides: new SessionOverridesRepository(storage),
    location: "test-location",
    config,
    sessions,
    clock,
    id: () => `task-${Math.random().toString(16).slice(2, 8)}`,
    notify: (event) => notifications.push(event),
  });
  await engine.start();
  return {
    root,
    clock,
    storage,
    sessions,
    config,
    engine,
    notifications,
    async close() {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Reconstructs an engine over the same storage (reload / server restart). */
async function restart(h) {
  const engine = new OffpeakEngine({
    repository: new QueueRepository(h.storage),
    recoveries: new RecoveryRepository(h.storage),
    sessionOverrides: new SessionOverridesRepository(h.storage),
    location: "test-location",
    config: h.config,
    sessions: h.sessions,
    clock: h.clock,
    notify: (event) => h.notifications.push(event),
  });
  await engine.start();
  return engine;
}

const selectedModel = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" };
const PEAK = "2026-10-12T02:00:00Z"; // Monday 02:00 UTC: inside the verified peak window.
const OFF_PEAK = "2026-10-12T00:30:00Z";

test("session protection defaults to ON and OFF_PEAK requests are unchanged", async () => {
  const h = await harness(OFF_PEAK);
  try {
    const status = await h.engine.status({ ...selectedModel, sessionID: "session-a" });
    assert.equal(status.sessionProtection, "ON");
    assert.equal(status.pricingState, "OFF_PEAK");
    assert.equal(status.requestsAllowed, true);
    // OFF_PEAK passes with protection ON and OFF alike.
    await h.engine.guardRequest({ sessionID: "session-a", ...selectedModel, transport: "http" });
    await h.engine.setSessionProtection("session-a", "off");
    await h.engine.guardRequest({ sessionID: "session-a", ...selectedModel, transport: "http" });
    // FLAT and UNTRACKED providers stay allowed with protection ON.
    await h.engine.guardRequest({
      sessionID: "session-a",
      providerID: "opencode-go",
      modelID: "gpt-6-luna",
      transport: "http",
    });
    await h.engine.guardRequest({
      sessionID: "session-a",
      providerID: "opencode",
      modelID: "deepseek-v4.1-flash-free",
      transport: "http",
    });
  } finally {
    await h.close();
  }
});

test("PEAK with session protection ON holds; session off allows the same request immediately", async () => {
  const h = await harness(PEAK);
  let providerCalls = 0;
  const sessionID = "session-a";
  try {
    const held = h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
      .then(() => {
        providerCalls += 1;
      });
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    // Protection ON: the request waits and a primary deferral is persisted.
    assert.equal(providerCalls, 0);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);

    // The user switches this session's protection off; the hold wakes
    // immediately, the same request continues, and the deferral is removed.
    assert.equal(await h.engine.setSessionProtection(sessionID, "off"), "OFF");
    await held;
    assert.equal(providerCalls, 1);
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(providerCalls, 1);
    const status = await h.engine.status({ ...selectedModel, sessionID });
    assert.equal(status.pricingState, "PEAK");
    assert.equal(status.sessionProtection, "OFF");
    assert.equal(status.requestsAllowed, true);
    assert.equal(status.recoveryWaiting, 0);
    assert.equal(status.interactiveWaiting, 0);
    // No continuation was injected and the session was never interrupted.
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal(h.sessions.interrupts, 0);
    // Exactly one hold notification and one override release.
    assert.deepEqual(
      h.notifications.map((event) => `${event.type}:${event.kind ?? ""}`),
      ["hold:", "resume:override"],
    );
  } finally {
    await h.close();
  }
});

test("session on restores waiting: the next PEAK request holds again", async () => {
  const h = await harness(PEAK);
  const sessionID = "session-a";
  try {
    await h.engine.setSessionProtection(sessionID, "off");
    const first = h.engine.guardModelRequest({
      sessionID,
      ...selectedModel,
      kind: "primary",
      transport: "model",
    });
    await first; // Allowed immediately at PEAK.
    assert.equal(await h.engine.setSessionProtection(sessionID, "on"), "ON");
    const held = h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
      .then(
        () => "released",
        () => "blocked",
      );
    await assertStillPending(held);
    assert.equal((await h.engine.status({ ...selectedModel, sessionID })).sessionProtection, "ON");
  } finally {
    await h.close();
  }
});

test("a committed request is never recalled by switching protection off or on", async () => {
  const clock = new ManualClock("2026-10-12T03:59:59Z");
  const h = await harness("2026-10-12T03:59:59Z", { clock });
  const sessionID = "session-committed";
  let releases = 0;
  try {
    const held = h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
      .then(() => {
        releases += 1;
      });
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    // The allowed window arrives first: the dispatch decision is taken.
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(() => releases === 1);
    // A late cancel reports the truth and a protection switch changes nothing.
    assert.deepEqual(await h.engine.cancelHold({ sessionID }), {
      cancelled: false,
      state: "committed",
    });
    await h.engine.setSessionProtection(sessionID, "off");
    await h.engine.setSessionProtection(sessionID, "on");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(releases, 1);
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal(h.sessions.interrupts, 0);
    await held;
  } finally {
    await h.close();
  }
});

test("an already cancelled/refused hold is not resurrected by session off", async () => {
  const h = await harness(PEAK);
  const sessionID = "session-cancelled";
  try {
    const held = h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
      .then(() => "returned");
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    const cancelled = await h.engine.cancelHold({ sessionID, reason: "obsolete" });
    assert.equal(cancelled.cancelled, true);
    assert.equal(cancelled.state, "refused");
    // Switching protection off after the cancellation must not release or
    // resurrect the refused request: the refusal stays armed and is consumed at
    // the transport boundary without any provider dispatch.
    await h.engine.setSessionProtection(sessionID, "off");
    assert.equal(await held, "returned");
    const consumed = h.engine.consumeRefusal({
      sessionID,
      ...selectedModel,
      kind: "primary",
    });
    assert.equal(consumed, true);
    assert.equal(h.engine.consumeRefusal({ sessionID, ...selectedModel, kind: "primary" }), false);
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    // The consumed refusal still keeps offpeak's own retry recovery away.
    const outcome = await h.engine.noteRetryFailure({
      sessionID,
      ...selectedModel,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal(outcome, "pass");
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
  } finally {
    await h.close();
  }
});

test("session off allows and session on restores compaction, title, and generate requests alike", async () => {
  const h = await harness(PEAK);
  const sessionID = "session-native";
  try {
    for (const kind of ["compaction", "title", "generate"]) {
      const wait = h.engine
        .guardModelRequest({ sessionID, ...selectedModel, kind, transport: "model" })
        .then(
          () => "released",
          () => "blocked",
        );
      await assertStillPending(wait);
      assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 1);
      await h.engine.setSessionProtection(sessionID, "off");
      assert.equal(await wait, "released");
      // The release removes any marker the hold had persisted.
      assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
      await h.engine.setSessionProtection(sessionID, "on");
    }
    // Under protection ON the same compaction would persist a pending-compaction
    // marker instead of running; that v0.1.9 behavior is asserted by the
    // dedicated regression below.
  } finally {
    await h.close();
  }
});

test("UNKNOWN models and invalid configuration fail closed even with session protection off", async () => {
  const h = await harness(PEAK);
  const sessionID = "session-fail-closed";
  try {
    await h.engine.setSessionProtection(sessionID, "off");
    await assert.rejects(
      h.engine.guardModelRequest({
        sessionID,
        providerID: "opencode-go",
        modelID: "some-unlisted-model",
        kind: "primary",
        transport: "model",
      }),
      (error) => error instanceof PricingBlockedError && /not in the verified/.test(error.message),
    );
    await writeFile(h.config.path, "{ broken json");
    await assert.rejects(
      h.engine.guardModelRequest({
        sessionID,
        ...selectedModel,
        kind: "primary",
        transport: "model",
      }),
      PricingBlockedError,
    );
  } finally {
    await h.close();
  }
});

test("multi-session isolation: A off, B and C remain protected, then A on again", async () => {
  const h = await harness(PEAK);
  try {
    await h.engine.setSessionProtection("session-a", "off");
    const a = h.engine
      .guardModelRequest({
        sessionID: "session-a",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => "released",
        () => "blocked",
      );
    assert.equal(await a, "released");
    const b = h.engine
      .guardModelRequest({
        sessionID: "session-b",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => "released",
        () => "blocked",
      );
    const c = h.engine
      .guardModelRequest({
        sessionID: "session-c",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => "released",
        () => "blocked",
      );
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 2);
    assert.equal(
      (await h.engine.status({ ...selectedModel, sessionID: "session-b" })).sessionProtection,
      "ON",
    );
    assert.equal(
      (await h.engine.status({ ...selectedModel, sessionID: "session-c" })).sessionProtection,
      "ON",
    );
    await h.engine.setSessionProtection("session-a", "on");
    await assertStillPending(b);
    await assertStillPending(c);
    assert.equal(
      (await h.engine.status({ ...selectedModel, sessionID: "session-a" })).sessionProtection,
      "ON",
    );
  } finally {
    await h.close();
  }
});

test("queue-owned sessions never inherit the interactive override", async () => {
  const h = await harness("2026-10-12T00:30:00Z");
  const providerRequests = { count: 0 };
  h.sessions.behavior = async ({ sessionID }) => {
    // This task starts off-peak; its provider attempt crosses into PEAK.
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    providerRequests.count += 1;
    h.clock.set(PEAK);
    await h.engine.guardRequest({ sessionID, ...selectedModel, transport: "http" });
    providerRequests.count += 1;
  };
  try {
    const task = await h.engine.queue({
      prompt: "crosses into peak",
      cwd: "/project",
      model: selectedModel,
    });
    await until(async () => {
      const stored = (await h.engine.list()).find((item) => item.id === task.id);
      return stored?.state === "WAITING_OFFPEAK" && stored.sessionID !== undefined;
    });
    const stored = (await h.engine.list()).find((item) => item.id === task.id);
    // The queue session carries an explicit user override; the task still must
    // not inherit it, because background queue tasks keep their own semantics.
    assert.equal(await h.engine.setSessionProtection(stored.sessionID, "off"), "OFF");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(providerRequests.count, 1);
    assert.equal(
      (await h.engine.list()).find((item) => item.id === task.id).state,
      "WAITING_OFFPEAK",
    );
    // The explicit task-scoped override still works exactly as before.
    await h.engine.runNow(task.id);
    await until(async () => providerRequests.count === 2);
    await until(
      async () =>
        (await h.engine.list()).find((item) => item.id === task.id)?.state === "COMPLETED",
    );
  } finally {
    await h.close();
  }
});

test("session off in queue and guard modes allows interactive PEAK requests; session on blocks them again", async () => {
  for (const mode of ["queue", "guard"]) {
    const h = await harness(PEAK, { options: { mode } });
    try {
      assert.equal((await h.engine.status(selectedModel)).mode, mode);
      await assert.rejects(
        h.engine.guardModelRequest({
          sessionID: "session-mode",
          ...selectedModel,
          kind: "primary",
          transport: "model",
        }),
        PricingBlockedError,
      );
      await h.engine.setSessionProtection("session-mode", "off");
      await h.engine.guardModelRequest({
        sessionID: "session-mode",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      });
      await h.engine.setSessionProtection("session-mode", "on");
      await assert.rejects(
        h.engine.guardModelRequest({
          sessionID: "session-mode",
          ...selectedModel,
          kind: "primary",
          transport: "model",
        }),
        PricingBlockedError,
      );
    } finally {
      await h.close();
    }
  }
});

test("global OFF precedence: the explicit session override still authorizes that session only", async () => {
  const h = await harness(PEAK);
  try {
    await h.engine.setEnabled(false);
    await h.engine.setSessionProtection("session-allowed", "off");
    // The explicit session grant is newer and more specific than the global
    // pause: that one session may run verified PEAK inference.
    await h.engine.guardModelRequest({
      sessionID: "session-allowed",
      ...selectedModel,
      kind: "primary",
      transport: "model",
    });
    // Every other session keeps the hard barrier while the plugin is OFF.
    await assert.rejects(
      h.engine.guardModelRequest({
        sessionID: "session-protected",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      }),
      PricingBlockedError,
    );
    // A task still cannot start while globally OFF.
    const task = await h.engine.queue({
      prompt: "do not start",
      cwd: "/project",
      model: selectedModel,
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal((await h.engine.list()).find((item) => item.id === task.id).state, "QUEUED");
    // run-now keeps requiring an enabled plugin.
    await assert.rejects(h.engine.runNow(task.id), /Turn \/offpeak on/);
  } finally {
    await h.close();
  }
});

test("session protection persists across a plugin reload and a server restart", async () => {
  const h = await harness(PEAK);
  const sessionID = "session-persisted";
  try {
    await h.engine.setSessionProtection(sessionID, "off");
    const persisted = h.storage.values.get(SESSION_OVERRIDES_STORAGE_KEY);
    assert.deepEqual(Object.keys(persisted.sessions), [sessionID]);
    assert.equal(persisted.sessions[sessionID].protection, "off");
    assert.equal(typeof persisted.sessions[sessionID].updatedAt, "string");
    await h.engine.dispose();
    const reloaded = await restart(h);
    assert.equal(reloaded.sessionProtection(sessionID), "OFF");
    await reloaded.guardModelRequest({
      sessionID,
      ...selectedModel,
      kind: "primary",
      transport: "model",
    });
    await reloaded.dispose();
    const restarted = await restart(h);
    assert.equal(restarted.sessionProtection(sessionID), "OFF");
    assert.equal(
      (await restarted.status({ ...selectedModel, sessionID })).sessionProtection,
      "OFF",
    );
    await restarted.setSessionProtection(sessionID, "on");
    assert.deepEqual(h.storage.values.get(SESSION_OVERRIDES_STORAGE_KEY), {
      schemaVersion: 1,
      sessions: {},
    });
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("session-deletion events and lazy access reap overrides for missing sessions only", async () => {
  const h = await harness(PEAK);
  try {
    await h.engine.setSessionProtection("session-existing", "off");
    await h.engine.setSessionProtection("session-deleted", "off");
    // The supported session.deleted event removes only that session's override.
    await h.engine.forgetSession("session-deleted");
    assert.equal(h.engine.sessionProtection("session-deleted"), "ON");
    assert.equal(h.engine.sessionProtection("session-existing"), "OFF");
    // Lazy status access prunes a session that no longer exists.
    h.sessions.missing.add("session-gone");
    await h.engine.setSessionProtection("session-gone", "off");
    const status = await h.engine.status({ ...selectedModel, sessionID: "session-gone" });
    assert.equal(status.sessionProtection, "ON");
    assert.equal(h.engine.sessionProtection("session-gone"), "ON");
    // A session that still exists is never reaped.
    assert.equal(
      (await h.engine.status({ ...selectedModel, sessionID: "session-existing" }))
        .sessionProtection,
      "OFF",
    );
    // Start-up pruning also drops overrides for sessions that are already missing.
    h.sessions.missing.add("session-existing");
    const restarted = await restart(h);
    assert.equal(restarted.sessionProtection("session-existing"), "ON");
    assert.deepEqual(h.storage.values.get(SESSION_OVERRIDES_STORAGE_KEY), {
      schemaVersion: 1,
      sessions: {},
    });
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("a lost deferred hold proceeds immediately when the session is switched off", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  const sessionID = "session-recovery";
  try {
    const held = h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "primary", transport: "model" })
      .then(
        () => "released",
        () => "blocked",
      );
    await until(async () => (await h.engine.status(selectedModel)).recoveryWaiting === 1);
    // The plugin reloads while the request waits: the hold fails closed and the
    // deferral stays for recovery.
    await h.engine.dispose();
    assert.equal(await held, "blocked");
    const reloaded = await restart(h);
    h.sessions.outcomes.set(sessionID, "failed");
    // Protection ON: the recovery waits for the boundary.
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.prompts.length, 0);
    assert.equal((await reloaded.status(selectedModel)).recoveryWaiting, 1);
    // Switching protection off releases the pending recovery on the spot, once.
    await reloaded.setSessionProtection(sessionID, "off");
    await until(() => h.sessions.prompts.length === 1);
    assert.equal(h.sessions.prompts[0].sessionID, sessionID);
    assert.match(h.sessions.prompts[0].text, /Continue the task in this session/);
    assert.equal((await reloaded.status(selectedModel)).recoveryWaiting, 0);
    // The boundary must not deliver a duplicate continuation.
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await clock.advanceTo("2026-10-13T00:00:00Z");
    await new Promise((resolve) => setTimeout(resolve, 25));
    assert.equal(h.sessions.prompts.length, 1);
    await reloaded.dispose();
  } finally {
    await h.close();
  }
});

test("retry-failure recovery proceeds immediately under session off without a duplicate retry continuation", async () => {
  const h = await harness(PEAK);
  const sessionID = "session-retry-recovery";
  try {
    h.sessions.outcomes.set(sessionID, "failed");
    const outcome = await h.engine.noteRetryFailure({
      sessionID,
      ...selectedModel,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal(outcome, "hold");
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 1);
    await h.engine.setSessionProtection(sessionID, "off");
    await until(() => h.sessions.prompts.length === 1);
    assert.equal(h.sessions.prompts[0].sessionID, sessionID);
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
    // A retryable failure in an overridden session keeps OpenCode's own retry
    // behavior instead of registering a recovery.
    const second = await h.engine.noteRetryFailure({
      sessionID,
      ...selectedModel,
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal(second, "pass");
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);
  } finally {
    await h.close();
  }
});

test("pending-compaction and pending-title recoveries honor the override without class clobbering", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const storage = new MemoryStorage();
  const sessions = new FakeSessions();
  // Seed the exact persisted recovery classes v0.1.9 writes.
  await new RecoveryRepository(storage).save({
    schemaVersion: 1,
    entries: [
      {
        sessionID: "session-compaction",
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        directory: "test-location",
        heldAt: "2026-10-12T01:31:00.000Z",
        origin: "pending-compaction",
      },
      {
        sessionID: "session-title",
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        directory: "test-location",
        heldAt: "2026-10-12T01:31:00.000Z",
        origin: "pending-title",
      },
    ],
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-session-recovery-"));
  const config = new ConfigRepository({ configPath: path.join(root, "offpeak.json") });
  sessions.outcomes.set("session-compaction", "failed");
  sessions.outcomes.set("session-title", "failed");
  const order = [];
  sessions.compact = async (sessionID) => {
    order.push(`compact:${sessionID}`);
    sessions.compactions.push(sessionID);
  };
  const engine = new OffpeakEngine({
    repository: new QueueRepository(storage),
    recoveries: new RecoveryRepository(storage),
    sessionOverrides: new SessionOverridesRepository(storage),
    location: "test-location",
    config,
    sessions,
    clock,
  });
  await engine.start();
  try {
    // Protection is ON: the pending compaction is admitted by the v0.1.9
    // auto-mode rule, but the title marker only verifies (nothing is sent).
    await until(() => sessions.compactions.length === 1);
    assert.equal(await engine.setSessionProtection("session-title", "off"), "OFF");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sessions.prompts.length, 0);
    assert.equal(sessions.compactions.length, 1);
    // The override never clobbers another session's recovery.
    const document = await new RecoveryRepository(storage).load();
    assert.deepEqual(
      document.entries.map((entry) => `${entry.sessionID}:${entry.origin}`),
      ["session-title:pending-title"],
    );
    // Once OpenCode names the session, the marker clears without a request.
    sessions.snapshots.set("session-title", { title: "Named by OpenCode" });
    await engine.noteExecutionSettled("session-title");
    await until(async () => (await new RecoveryRepository(storage).load()).entries.length === 0);
  } finally {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction and primary recoveries for one overridden session flush in compact-first order, exactly once", async () => {
  const clock = new ManualClock("2026-10-12T02:30:00Z");
  const storage = new MemoryStorage();
  const sessions = new FakeSessions();
  await new RecoveryRepository(storage).save({
    schemaVersion: 1,
    entries: [
      {
        sessionID: "session-both",
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        directory: "test-location",
        heldAt: "2026-10-12T01:31:00.000Z",
        origin: "pending-compaction",
      },
      {
        sessionID: "session-both",
        providerID: selectedModel.providerID,
        modelID: selectedModel.modelID,
        directory: "test-location",
        heldAt: "2026-10-12T01:31:00.000Z",
        origin: "deferred",
      },
    ],
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-session-order-"));
  const config = new ConfigRepository({ configPath: path.join(root, "offpeak.json") });
  const order = [];
  sessions.outcomes.set("session-both", "failed");
  sessions.compact = async (sessionID) => {
    order.push("compact");
    sessions.compactions.push(sessionID);
  };
  const engine = new OffpeakEngine({
    repository: new QueueRepository(storage),
    recoveries: new RecoveryRepository(storage),
    sessionOverrides: new SessionOverridesRepository(storage),
    location: "test-location",
    config,
    sessions,
    clock,
  });
  await engine.start();
  try {
    // Protection ON: the compaction is admitted, the primary continuation is
    // forced with it (v0.1.9 compact-first), then no duplicate follows.
    await until(() => sessions.prompts.length === 1);
    assert.deepEqual(order, ["compact"]);
    assert.equal(sessions.prompts[0].sessionID, "session-both");
    // Turning protection off afterwards cannot replay anything (the entries are
    // already consumed).
    await engine.setSessionProtection("session-both", "off");
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(sessions.prompts.length, 1);
    assert.equal(sessions.compactions.length, 1);
  } finally {
    await engine.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("compaction regression: ON waits with a pending-compaction marker, OFF runs immediately without one", async () => {
  // A: protection ON during PEAK keeps the v0.1.9 pending-compaction behavior.
  const onClock = new ManualClock("2026-10-12T01:30:00Z");
  const on = await harness("2026-10-12T01:30:00Z", { clock: onClock });
  try {
    const held = on.engine
      .guardModelRequest({
        sessionID: "session-compact-on",
        ...selectedModel,
        kind: "compaction",
        transport: "model",
      })
      .then(
        () => "released",
        () => "blocked",
      );
    await until(
      async () => (await on.engine.status(selectedModel)).compactionRecoveryWaiting === 1,
    );
    await assertStillPending(held);
    await onClock.advanceTo("2026-10-12T04:00:00Z");
    assert.equal(await held, "released");
    assert.equal((await on.engine.status(selectedModel)).recoveryWaiting, 0);
    assert.equal(on.sessions.prompts.length, 0);
  } finally {
    await on.close();
  }

  // B: protection OFF during PEAK runs the compaction immediately and leaves no
  // marker behind; the next prompt works normally.
  const off = await harness(PEAK);
  try {
    await off.engine.setSessionProtection("session-compact-off", "off");
    await off.engine.guardModelRequest({
      sessionID: "session-compact-off",
      ...selectedModel,
      kind: "compaction",
      transport: "model",
    });
    const status = await off.engine.status(selectedModel);
    assert.equal(status.compactionRecoveryWaiting, 0);
    assert.equal(status.recoveryWaiting, 0);
    assert.equal(status.interactiveWaiting, 0);
    await off.engine.guardRequest({
      sessionID: "session-compact-off",
      ...selectedModel,
      transport: "http",
    });
    assert.equal(off.sessions.prompts.length, 0);
    assert.equal(off.sessions.compactions.length, 0);
  } finally {
    await off.close();
  }
});

test("switching protection off after a held auxiliary request notifies no hold/resume pair", async () => {
  const h = await harness(PEAK);
  const sessionID = "session-aux";
  try {
    const held = h.engine
      .guardModelRequest({ sessionID, ...selectedModel, kind: "title", transport: "model" })
      .then(() => "released");
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    await h.engine.setSessionProtection(sessionID, "off");
    assert.equal(await held, "released");
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(h.notifications, []);
    assert.equal((await h.engine.status(selectedModel)).titleRecoveryWaiting, 0);
  } finally {
    await h.close();
  }
});
