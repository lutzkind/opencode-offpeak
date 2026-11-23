import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  ClientsRepository,
  ConfigRepository,
  defaultConfig,
  OffpeakEngine,
  PricingBlockedError,
  QueueRepository,
  RecoveryRepository,
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

class FixedClock {
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
}

class FakeSessions {
  prompts = [];
  missing = new Set();
  async create() {
    return "queue-session";
  }
  async prompt(sessionID, text) {
    this.prompts.push({ sessionID, text });
  }
  async wait() {}
  async get(sessionID) {
    if (this.missing.has(sessionID)) throw new Error(`Session not found: ${sessionID}`);
    return {};
  }
  async interrupt() {}
  async compact() {}
}

const PEAK = "2026-10-12T02:00:00Z";
const OFF_PEAK = "2026-10-12T05:00:00Z";
const model = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" };

function blockedPolicy() {
  return {
    ...defaultConfig().policies[0],
    blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
  };
}

async function harness(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-client-test-"));
  const configPath = path.join(root, "offpeak.json");
  const policy = options.policy ?? { ...defaultConfig(), policies: [blockedPolicy()] };
  await writeFile(configPath, JSON.stringify(policy));
  const storage = options.storage ?? new MemoryStorage();
  const sessions = options.sessions ?? new FakeSessions();
  const clock = new FixedClock(options.now ?? PEAK);
  const engine = new OffpeakEngine({
    repository: new QueueRepository(storage),
    recoveries: new RecoveryRepository(storage),
    sessionOverrides: new SessionOverridesRepository(storage),
    clients: new ClientsRepository(storage),
    location: "test-location",
    config: new ConfigRepository({ configPath }),
    sessions,
    clock,
    id: () => "task-test",
  });
  await engine.start();
  return {
    root,
    storage,
    sessions,
    clock,
    engine,
    async close() {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function pending(promise, milliseconds = 50) {
  return Promise.race([
    promise.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), milliseconds)),
  ]);
}

function guard(engine, sessionID, providerID = model.providerID, modelID = model.modelID) {
  return engine.guardRequest({
    sessionID,
    providerID,
    modelID,
    kind: "primary",
    transport: "http",
  });
}

function guarded(engine, sessionID, providerID, modelID) {
  return guard(engine, sessionID, providerID, modelID).then(
    () => "allowed",
    (error) => error,
  );
}

test("both client defaults initialize to ON and an absent document is not rewritten", async () => {
  const h = await harness();
  try {
    const status = await h.engine.clientStatus({ sessionID: "never-seen" });
    assert.deepEqual(status.defaults, { cli: "ON", desktop: "ON" });
    assert.equal(status.session.ownership, "unknown");
    assert.equal(status.session.protection, "ON");
    assert.equal(status.session.source, "unknown");
    assert.equal(h.storage.values.has(CLIENT_SETTINGS_STORAGE_KEY), false);
  } finally {
    await h.close();
  }
});

test("CLI OFF and Desktop ON are independent, and unknown sessions stay protected", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("cli-session", "cli");
    await h.engine.registerSessionClient("desktop-session", "desktop");
    await h.engine.setClientProtection("cli", "off");

    assert.equal(await guarded(h.engine, "cli-session"), "allowed");
    const desktop = await pending(guarded(h.engine, "desktop-session"));
    assert.equal(desktop, "pending");
    assert.equal(await pending(guarded(h.engine, "unknown-session")), "pending");

    const status = await h.engine.clientStatus({ sessionID: "cli-session" });
    assert.deepEqual(status.defaults, { cli: "OFF", desktop: "ON" });
    assert.equal(status.session.ownership, "cli");
    assert.equal(status.session.source, "client-default");
    assert.equal(status.session.protection, "OFF");
  } finally {
    await h.close();
  }
});

test("CLI ON and Desktop OFF are independent", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("cli-session", "cli");
    await h.engine.registerSessionClient("desktop-session", "desktop");
    await h.engine.setClientProtection("desktop", "off");

    assert.equal(await guarded(h.engine, "desktop-session"), "allowed");
    assert.equal(await pending(guarded(h.engine, "cli-session")), "pending");
    const status = await h.engine.clientStatus({ sessionID: "desktop-session" });
    assert.deepEqual(status.defaults, { cli: "ON", desktop: "OFF" });
    assert.equal(status.session.protection, "OFF");
  } finally {
    await h.close();
  }
});

test("both ON protects both clients; both OFF permits only their own verified peak sessions", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("cli-session", "cli");
    await h.engine.registerSessionClient("desktop-session", "desktop");
    assert.equal(await pending(guarded(h.engine, "cli-session")), "pending");
    assert.equal(await pending(guarded(h.engine, "desktop-session")), "pending");

    await h.engine.setClientProtection("cli", "off");
    await h.engine.setClientProtection("desktop", "off");
    assert.equal(await guarded(h.engine, "cli-session"), "allowed");
    assert.equal(await guarded(h.engine, "desktop-session"), "allowed");
    assert.equal(await pending(guarded(h.engine, "unknown-session")), "pending");
  } finally {
    await h.close();
  }
});

test("changing one client setting never writes or changes the other", async () => {
  const h = await harness();
  try {
    await h.engine.setClientProtection("cli", "off");
    let document = h.storage.values.get(CLIENT_SETTINGS_STORAGE_KEY);
    assert.deepEqual(document.defaults, { cli: "off", desktop: "on" });
    await h.engine.setClientProtection("desktop", "off");
    document = h.storage.values.get(CLIENT_SETTINGS_STORAGE_KEY);
    assert.deepEqual(document.defaults, { cli: "off", desktop: "off" });
    await h.engine.setClientProtection("cli", "on");
    document = h.storage.values.get(CLIENT_SETTINGS_STORAGE_KEY);
    assert.deepEqual(document.defaults, { cli: "on", desktop: "off" });
    await h.engine.setClientProtection("desktop", "on");
    document = h.storage.values.get(CLIENT_SETTINGS_STORAGE_KEY);
    assert.deepEqual(document.defaults, { cli: "on", desktop: "on" });
  } finally {
    await h.close();
  }
});

test("an explicit session override retains precedence over either client default", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("override-session", "cli");
    await h.engine.setSessionProtection("override-session", "off");
    // CLI is ON, but the session's explicit authorization wins.
    assert.equal(await guarded(h.engine, "override-session"), "allowed");
    let status = await h.engine.clientStatus({ sessionID: "override-session" });
    assert.equal(status.session.source, "session-override");
    assert.equal(status.session.protection, "OFF");

    // Removing the explicit override returns to the client default (ON).
    await h.engine.setSessionProtection("override-session", "on");
    assert.equal(await pending(guarded(h.engine, "override-session")), "pending");
    status = await h.engine.clientStatus({ sessionID: "override-session" });
    assert.equal(status.session.source, "client-default");
    assert.equal(status.session.protection, "ON");

    // A session override does not let a queue task inherit the client default.
    await h.engine.setClientProtection("cli", "off");
    await h.engine.queue({ prompt: "queue task", cwd: "/fixture", model });
    const task = (await h.engine.list())[0];
    task.sessionID = "queue-task-session";
    await h.storage.set("opencode-offpeak/queue-v1", {
      schemaVersion: 1,
      tasks: [task],
    });
    await h.engine.registerSessionClient("queue-task-session", "cli");
    status = await h.engine.clientStatus({ sessionID: "queue-task-session" });
    assert.equal(status.session.ownership, "queue");
    assert.equal(status.session.protection, "ON");
    assert.equal(status.session.source, "queue");
  } finally {
    await h.close();
  }
});

test("existing installations migrate with both defaults ON and existing overrides intact", async () => {
  const storage = new MemoryStorage();
  storage.values.set("opencode-offpeak/session-overrides-v1", {
    schemaVersion: 1,
    sessions: { legacy: { protection: "off", updatedAt: "2026-01-01T00:00:00.000Z" } },
  });
  const h = await harness({ storage });
  try {
    const status = await h.engine.clientStatus({ sessionID: "legacy" });
    assert.deepEqual(status.defaults, { cli: "ON", desktop: "ON" });
    assert.equal(status.session.source, "session-override");
    assert.equal(h.storage.values.has(CLIENT_SETTINGS_STORAGE_KEY), false);
    assert.equal(await guarded(h.engine, "legacy"), "allowed");
  } finally {
    await h.close();
  }
});

test("defaults and ownership survive a plugin reload and a server restart", async () => {
  const storage = new MemoryStorage();
  const first = await harness({ storage });
  await first.engine.registerSessionClient("persisted-session", "desktop");
  await first.engine.setClientProtection("desktop", "off");
  await first.engine.setClientProtection("cli", "off");
  await first.engine.setClientProtection("cli", "on");
  await first.close();

  const second = await harness({ storage });
  try {
    const status = await second.engine.clientStatus({ sessionID: "persisted-session" });
    assert.deepEqual(status.defaults, { cli: "ON", desktop: "OFF" });
    assert.equal(status.session.ownership, "desktop");
    assert.equal(status.session.protection, "OFF");
    assert.equal(await guarded(second.engine, "persisted-session"), "allowed");
  } finally {
    await second.close();
  }
});

test("session deletion cleans ownership and an explicit override together", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("deleted-session", "cli");
    await h.engine.setSessionProtection("deleted-session", "off");
    await h.engine.forgetSession("deleted-session");
    let document = h.storage.values.get(CLIENT_SETTINGS_STORAGE_KEY);
    assert.deepEqual(document.sessions, {});
    assert.deepEqual(h.storage.values.get("opencode-offpeak/session-overrides-v1").sessions, {});
    let status = await h.engine.clientStatus({ sessionID: "deleted-session" });
    assert.equal(status.session.ownership, "unknown");

    // Lazy bounded cleanup reaps only a confident not-found.
    await h.engine.registerSessionClient("stale-session", "desktop");
    h.sessions.missing.add("stale-session");
    await h.engine.pruneSessionProtections();
    document = h.storage.values.get(CLIENT_SETTINGS_STORAGE_KEY);
    assert.deepEqual(document.sessions, {});
    status = await h.engine.clientStatus({ sessionID: "stale-session" });
    assert.equal(status.session.ownership, "unknown");
  } finally {
    await h.close();
  }
});

test("a shared session is ambiguous and remains protected even when one client is OFF", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("shared-session", "cli");
    await h.engine.setClientProtection("cli", "off");
    assert.equal(await guarded(h.engine, "shared-session"), "allowed");

    await h.engine.registerSessionClient("shared-session", "desktop");
    const status = await h.engine.clientStatus({ sessionID: "shared-session" });
    assert.equal(status.session.ownership, "ambiguous");
    assert.equal(status.session.source, "ambiguous");
    assert.equal(status.session.protection, "ON");
    // A new request is held, not sent, despite the CLI default being OFF.
    assert.equal(await pending(guarded(h.engine, "shared-session")), "pending");
  } finally {
    await h.close();
  }
});

test("a held request releases when its client default becomes OFF and re-protects when ON", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("live-session", "desktop");
    const held = guarded(h.engine, "live-session");
    assert.equal(await pending(held), "pending");
    await h.engine.setClientProtection("desktop", "off");
    assert.equal(await held, "allowed");
    // An already dispatched request is not recalled; the next one waits.
    const next = guarded(h.engine, "live-session");
    await h.engine.setClientProtection("desktop", "on");
    assert.equal(await pending(next), "pending");
  } finally {
    await h.close();
  }
});

test("switching global and chat protection never drops, reorders, or duplicates queued work", async () => {
  const h = await harness();
  try {
    h.sessions.get = async () => ({ outcome: "succeeded" });
    await h.engine.setEnabled(false);
    const task = await h.engine.queue({
      prompt: "queued across protection changes",
      cwd: "/fixture",
      model,
    });
    await h.engine.registerSessionClient("queue-session", "cli");
    await h.engine.setSessionProtection("queue-session", "off");

    // Global changes and an unrelated session override leave the queued task
    // exactly where it was: the same ID, the same state, one record.
    await h.engine.setClientProtection("cli", "off");
    await h.engine.setClientProtection("desktop", "off");
    let tasks = await h.engine.list();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, task.id);
    assert.equal(tasks[0].state, "QUEUED");

    // At peak, even both interfaces OFF and the override cannot adopt a queue
    // task; it waits through the existing queue path instead of running twice.
    await h.engine.setEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    tasks = await h.engine.list();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, task.id);
    assert.equal(tasks[0].state, "WAITING_OFFPEAK");
    assert.equal(h.sessions.prompts.length, 0);

    // Off-peak wakes the same task once through the existing pump.
    h.clock.value = Date.parse("2026-10-12T23:59:30Z");
    await h.engine.setSessionProtection("queue-session", "on");
    const end = Date.now() + 2000;
    while (Date.now() < end) {
      const current = (await h.engine.list())[0];
      if (current?.state === "COMPLETED") break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    tasks = await h.engine.list();
    assert.equal(tasks.length, 1);
    assert.equal(tasks[0].id, task.id);
    assert.equal(tasks[0].state, "COMPLETED");
    assert.equal(h.sessions.prompts.length, 1);
    assert.equal(h.sessions.prompts[0].text, "queued across protection changes");
  } finally {
    await h.close();
  }
});

test("registration after an unregistered hold releases only the correct client", async () => {
  const h = await harness();
  try {
    await h.engine.setClientProtection("desktop", "off");
    const held = guarded(h.engine, "late-desktop");
    assert.equal(await pending(held), "pending");
    await h.engine.registerSessionClient("late-desktop", "desktop");
    assert.equal(await held, "allowed");
    assert.equal(await pending(guarded(h.engine, "late-cli")), "pending");
  } finally {
    await h.close();
  }
});

test("UNKNOWN pricing and invalid configuration stay fail-closed even with both clients OFF", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("unknown-model", "cli");
    await h.engine.setClientProtection("cli", "off");
    const unknown = await guarded(h.engine, "unknown-model", "opencode-go", "no-such-model");
    assert.ok(unknown instanceof PricingBlockedError);
    assert.match(unknown.message, /failed closed/);

    // Replacing the stored policy with an invalid document also fails closed.
    const invalid = await harness({ policy: { enabled: "yes" } });
    try {
      await invalid.engine.registerSessionClient("invalid-config", "cli");
      await invalid.engine.setClientProtection("cli", "off");
      const result = await guarded(invalid.engine, "invalid-config");
      assert.ok(result instanceof PricingBlockedError);
      assert.match(result.message, /failed closed/);
    } finally {
      await invalid.close();
    }
  } finally {
    await h.close();
  }
});

test("global OFF remains passive and keeps peak pricing blocked for both clients", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("cli-session", "cli");
    await h.engine.registerSessionClient("desktop-session", "desktop");
    await h.engine.setClientProtection("cli", "off");
    await h.engine.setClientProtection("desktop", "off");
    await h.engine.setEnabled(false);
    const status = await h.engine.status({
      ...model,
      sessionID: "cli-session",
    });
    assert.equal(status.enabled, false);
    // The explicit client authorization still applies to these one sessions;
    // OFF itself is not an override and the queue remains stopped.
    assert.equal(status.requestsAllowed, true);
    assert.equal(status.queued, 0);
    const blocked = await guarded(h.engine, "unknown-session");
    assert.ok(blocked instanceof PricingBlockedError);
  } finally {
    await h.close();
  }
});

test("off-peak remains allowed for every client and unknown session", async () => {
  const h = await harness({ now: OFF_PEAK, policy: defaultConfig() });
  try {
    await h.engine.registerSessionClient("cli-session", "cli");
    assert.equal(await guarded(h.engine, "cli-session"), "allowed");
    assert.equal(await guarded(h.engine, "unknown-session"), "allowed");
  } finally {
    await h.close();
  }
});

test("invalid stored client settings fail closed and are never overwritten", async () => {
  const storage = new MemoryStorage();
  storage.values.set(CLIENT_SETTINGS_STORAGE_KEY, {
    schemaVersion: 1,
    defaults: { cli: "sometimes", desktop: "on" },
    sessions: {},
  });
  const h = await harness({ storage });
  try {
    const status = await h.engine.clientStatus();
    assert.deepEqual(status.defaults, { cli: "ON", desktop: "ON" });
    assert.match(status.error, /invalid/);
    await assert.rejects(h.engine.setClientProtection("cli", "off"), /invalid/);
    await assert.rejects(h.engine.registerSessionClient("new-session", "cli"), /invalid/);
    assert.deepEqual(storage.values.get(CLIENT_SETTINGS_STORAGE_KEY).defaults, {
      cli: "sometimes",
      desktop: "on",
    });
    assert.equal(await pending(guarded(h.engine, "new-session")), "pending");
  } finally {
    await h.close();
  }
});
