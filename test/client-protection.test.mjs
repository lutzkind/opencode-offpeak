import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CLIENT_SETTINGS_STORAGE_KEY,
  ClientsRepository,
  ConfigRepository,
  OffpeakEngine,
  PricingBlockedError,
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
  prompts = [];
  compactions = [];
  outcomes = new Map();
  missing = new Set();
  async prompt(sessionID, text) {
    this.prompts.push({ sessionID, text });
  }
  async get(sessionID) {
    if (this.missing.has(sessionID)) {
      const error = new Error(`Session not found: ${sessionID}`);
      Object.assign(error, { _tag: "SessionNotFoundError" });
      throw error;
    }
    const outcome = this.outcomes.get(sessionID);
    return outcome ? { outcome } : {};
  }
  async compact(sessionID) {
    this.compactions.push(sessionID);
  }
}

async function until(predicate, message = "condition was not reached") {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

async function harness(now = "2026-10-12T01:30:00Z", options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-client-test-"));
  const clock = options.clock ?? new ManualClock(now);
  const storage = options.storage ?? new MemoryStorage();
  const sessions = options.sessions ?? new FakeSessions();
  const config = new ConfigRepository({
    configPath: path.join(root, "offpeak.json"),
    ...(options.options ?? {}),
  });
  const engine = new OffpeakEngine({
    recoveries: new RecoveryRepository(storage),
    sessionOverrides: new SessionOverridesRepository(storage),
    clients: new ClientsRepository(storage),
    location: "test-location",
    config,
    sessions,
    clock,
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
    async restart() {
      const next = new OffpeakEngine({
        recoveries: new RecoveryRepository(storage),
        sessionOverrides: new SessionOverridesRepository(storage),
        clients: new ClientsRepository(storage),
        location: "test-location",
        config,
        sessions,
        clock,
      });
      await next.start();
      return next;
    },
  };
}

const selectedModel = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" };
const PEAK = "2026-10-12T02:00:00Z";
const OFF_PEAK = "2026-10-12T05:00:00Z";

/**
 * A second engine for another location in the same server process. OpenCode
 * loads one plugin setup per project directory, so a command can be handled by
 * a different engine than the one holding a request.
 */
async function secondary(h, location = "other-location") {
  const engine = new OffpeakEngine({
    recoveries: new RecoveryRepository(h.storage),
    sessionOverrides: new SessionOverridesRepository(h.storage),
    clients: new ClientsRepository(h.storage),
    location,
    config: h.config,
    sessions: h.sessions,
    clock: h.clock,
  });
  await engine.start();
  return engine;
}

test("a client global changed through another location releases a live hold immediately", async () => {
  const h = await harness(PEAK);
  const other = await secondary(h);
  try {
    await other.registerSessionClient("cross-location-global", "desktop");
    let released = false;
    const held = h.engine
      .guardModelRequest({
        sessionID: "cross-location-global",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => {
          released = true;
        },
        () => {
          released = true;
        },
      );
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    assert.equal(released, false);
    await other.setClientProtection("desktop", "off");
    await until(() => released);
    await held;
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
  } finally {
    await other.dispose();
    await h.close();
  }
});

test("a chat override changed through another location releases a live hold and is visible there", async () => {
  const h = await harness(PEAK);
  const other = await secondary(h);
  try {
    await other.registerSessionClient("cross-location-chat", "desktop");
    let released = false;
    const held = h.engine
      .guardModelRequest({
        sessionID: "cross-location-chat",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => {
          released = true;
        },
        () => {
          released = true;
        },
      );
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    assert.equal(released, false);
    await other.setSessionProtection("cross-location-chat", "off");
    await until(() => released);
    await held;
    const status = await h.engine.clientStatus({ sessionID: "cross-location-chat" });
    assert.equal(status.session.protection, "OFF");
    assert.equal(status.session.source, "session-override");
    assert.equal(status.session.override, "off");
  } finally {
    await other.dispose();
    await h.close();
  }
});

test("overrides written through different locations are both preserved", async () => {
  const h = await harness(PEAK);
  const first = await secondary(h, "location-one");
  const second = await secondary(h, "location-two");
  try {
    await first.setSessionProtection("override-one", "off");
    await second.setSessionProtection("override-two", "on");
    const document = await new SessionOverridesRepository(h.storage).load();
    assert.equal(document.sessions["override-one"].protection, "off");
    assert.equal(document.sessions["override-two"].protection, "on");
  } finally {
    await first.dispose();
    await second.dispose();
    await h.close();
  }
});

test("both client defaults start ON and an absent document is not rewritten", async () => {
  const h = await harness();
  try {
    assert.deepEqual((await h.engine.clientStatus()).defaults, { cli: "ON", desktop: "ON" });
    assert.equal(h.storage.values.has(CLIENT_SETTINGS_STORAGE_KEY), false);
  } finally {
    await h.close();
  }
});

test("CLI and Desktop defaults are independent", async () => {
  const h = await harness();
  try {
    await h.engine.setClientProtection("cli", "off");
    assert.deepEqual((await h.engine.clientStatus()).defaults, { cli: "OFF", desktop: "ON" });
    await h.engine.setClientProtection("desktop", "off");
    assert.deepEqual((await h.engine.clientStatus()).defaults, { cli: "OFF", desktop: "OFF" });
    await h.engine.setClientProtection("cli", "on");
    assert.deepEqual((await h.engine.clientStatus()).defaults, { cli: "ON", desktop: "OFF" });
  } finally {
    await h.close();
  }
});

test("an unregistered chat stays protected regardless of both globals", async () => {
  const h = await harness();
  try {
    await h.engine.setClientProtection("cli", "off");
    await h.engine.setClientProtection("desktop", "off");
    const status = await h.engine.clientStatus({ sessionID: "unknown-session" });
    assert.equal(status.session.ownership, "unknown");
    assert.equal(status.session.protection, "ON");
    assert.equal(status.session.source, "unknown");
  } finally {
    await h.close();
  }
});

test("a shared chat follows the client that most recently opened it", async () => {
  const h = await harness();
  try {
    await h.engine.setClientProtection("cli", "on");
    await h.engine.setClientProtection("desktop", "off");
    await h.engine.registerSessionClient("shared", "cli");
    assert.equal((await h.engine.clientStatus({ sessionID: "shared" })).session.protection, "ON");
    await h.engine.registerSessionClient("shared", "desktop");
    const status = await h.engine.clientStatus({ sessionID: "shared" });
    assert.equal(status.session.ownership, "desktop");
    assert.equal(status.session.protection, "OFF");
    assert.equal(status.session.source, "client-default");
  } finally {
    await h.close();
  }
});

test("an explicit chat ON overrides a globally OFF client", async () => {
  const h = await harness(PEAK);
  try {
    await h.engine.setClientProtection("desktop", "off");
    await h.engine.registerSessionClient("chat-on", "desktop");
    await h.engine.setSessionProtection("chat-on", "on");
    const status = await h.engine.clientStatus({ sessionID: "chat-on" });
    assert.equal(status.session.protection, "ON");
    assert.equal(status.session.override, "on");
    const held = h.engine
      .guardModelRequest({
        sessionID: "chat-on",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => "settled",
        () => "settled",
      );
    const outcome = await Promise.race([
      held,
      new Promise((resolve) => setTimeout(() => resolve("pending"), 50)),
    ]);
    assert.equal(outcome, "pending");
    await h.engine.dispose();
    await held;
  } finally {
    await h.close();
  }
});

test("an explicit chat OFF overrides a globally ON client", async () => {
  const h = await harness(PEAK);
  try {
    await h.engine.setClientProtection("desktop", "on");
    await h.engine.registerSessionClient("chat-off", "desktop");
    await h.engine.setSessionProtection("chat-off", "off");
    await h.engine.guardModelRequest({
      sessionID: "chat-off",
      ...selectedModel,
      kind: "primary",
      transport: "model",
    });
    const status = await h.engine.clientStatus({ sessionID: "chat-off" });
    assert.equal(status.session.protection, "OFF");
    assert.equal(status.session.override, "off");
  } finally {
    await h.close();
  }
});

test("auto clears the chat override and the chat follows its client global again", async () => {
  const h = await harness(PEAK);
  try {
    await h.engine.setClientProtection("desktop", "off");
    await h.engine.registerSessionClient("chat-auto", "desktop");
    await h.engine.setSessionProtection("chat-auto", "on");
    assert.equal(
      (await h.engine.clientStatus({ sessionID: "chat-auto" })).session.protection,
      "ON",
    );
    await h.engine.setSessionProtection("chat-auto", "auto");
    const status = await h.engine.clientStatus({ sessionID: "chat-auto" });
    assert.equal(status.session.protection, "OFF");
    assert.equal(status.session.source, "client-default");
    assert.equal(status.session.override, undefined);
  } finally {
    await h.close();
  }
});

test("a held request releases when its chat allows peak and re-protects when it is turned back on", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  try {
    await h.engine.setClientProtection("cli", "on");
    await h.engine.registerSessionClient("held-chat", "cli");
    let released = false;
    const held = h.engine
      .guardModelRequest({
        sessionID: "held-chat",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => {
          released = true;
        },
        () => {
          released = true;
        },
      );
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    assert.equal(released, false);
    await h.engine.setSessionProtection("held-chat", "off");
    await until(() => released);
    await held;
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 0);
    await h.engine.setSessionProtection("held-chat", "on");
    const next = h.engine.guardModelRequest({
      sessionID: "held-chat",
      ...selectedModel,
      kind: "primary",
      transport: "model",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 1);
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 0);
    await next;
  } finally {
    await h.close();
  }
});

test("turning a client global OFF releases only that client's held chats", async () => {
  const clock = new ManualClock("2026-10-12T01:30:00Z");
  const h = await harness("2026-10-12T01:30:00Z", { clock });
  try {
    await h.engine.registerSessionClient("cli-held", "cli");
    await h.engine.registerSessionClient("desktop-held", "desktop");
    const cliHeld = h.engine.guardModelRequest({
      sessionID: "cli-held",
      ...selectedModel,
      kind: "primary",
      transport: "model",
    });
    const desktopHeld = h.engine.guardModelRequest({
      sessionID: "desktop-held",
      ...selectedModel,
      kind: "primary",
      transport: "model",
    });
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 2);
    await h.engine.setClientProtection("desktop", "off");
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    await desktopHeld;
    await clock.advanceTo("2026-10-12T04:00:00Z");
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 0);
    await cliHeld;
  } finally {
    await h.close();
  }
});

test("defaults, ownership, and chat settings persist across a restart", async () => {
  const h = await harness();
  try {
    await h.engine.setClientProtection("cli", "off");
    await h.engine.registerSessionClient("persisted", "cli");
    await h.engine.setSessionProtection("persisted", "on");
    await h.engine.dispose();
    const restarted = await h.restart();
    const status = await restarted.clientStatus({ sessionID: "persisted" });
    assert.deepEqual(status.defaults, { cli: "OFF", desktop: "ON" });
    assert.equal(status.session.ownership, "cli");
    assert.equal(status.session.protection, "ON");
    assert.equal(status.session.override, "on");
    await restarted.dispose();
  } finally {
    await h.close();
  }
});

test("session deletion removes ownership and the chat setting together", async () => {
  const h = await harness();
  try {
    await h.engine.registerSessionClient("deleted", "desktop");
    await h.engine.setSessionProtection("deleted", "off");
    await h.engine.forgetSession("deleted");
    const status = await h.engine.clientStatus({ sessionID: "deleted" });
    assert.equal(status.session.ownership, "unknown");
    assert.equal(status.session.protection, "ON");
    assert.equal(status.session.override, undefined);
  } finally {
    await h.close();
  }
});

test("UNKNOWN pricing and invalid configuration fail closed even with both clients OFF", async () => {
  const h = await harness(PEAK);
  try {
    await h.engine.setClientProtection("cli", "off");
    await h.engine.setClientProtection("desktop", "off");
    await h.engine.registerSessionClient("fail-closed", "desktop");
    await assert.rejects(
      h.engine.guardModelRequest({
        sessionID: "fail-closed",
        providerID: "opencode-go",
        modelID: "some-unlisted-model",
        kind: "primary",
        transport: "model",
      }),
      PricingBlockedError,
    );
    await writeFile(h.config.path, "{ broken json");
    await assert.rejects(
      h.engine.guardModelRequest({
        sessionID: "fail-closed",
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

test("off-peak requests stay allowed for every client and unknown chat", async () => {
  const h = await harness(OFF_PEAK);
  try {
    await h.engine.setClientProtection("cli", "on");
    await h.engine.setClientProtection("desktop", "on");
    await h.engine.guardRequest({
      sessionID: "offpeak-cli",
      ...selectedModel,
      transport: "http",
    });
    await h.engine.guardRequest({
      sessionID: "offpeak-desktop",
      ...selectedModel,
      transport: "http",
    });
    await h.engine.guardRequest({
      sessionID: "offpeak-unknown",
      ...selectedModel,
      transport: "http",
    });
  } finally {
    await h.close();
  }
});

test("invalid stored client settings fail closed and are never overwritten", async () => {
  const storage = new MemoryStorage();
  await storage.set(CLIENT_SETTINGS_STORAGE_KEY, { schemaVersion: 1, defaults: {} });
  const h = await harness("2026-10-12T02:00:00Z", { storage });
  try {
    const status = await h.engine.clientStatus({ sessionID: "invalid-doc" });
    assert.deepEqual(status.defaults, { cli: "ON", desktop: "ON" });
    assert.equal(status.session.protection, "ON");
    assert.ok(status.error);
    await assert.rejects(h.engine.setClientProtection("cli", "off"));
    assert.deepEqual(await storage.get(CLIENT_SETTINGS_STORAGE_KEY), {
      schemaVersion: 1,
      defaults: {},
    });
  } finally {
    await h.close();
  }
});

test("an unreadable chat override document forces protection ON even when the global is OFF", async () => {
  const storage = new MemoryStorage();
  await storage.set(SESSION_OVERRIDES_STORAGE_KEY, { schemaVersion: 99, sessions: {} });
  const h = await harness("2026-10-12T02:00:00Z", { storage });
  try {
    await h.engine.setClientProtection("desktop", "off");
    const status = await h.engine.clientStatus({ sessionID: "unreadable-overrides" });
    assert.equal(status.session.protection, "ON");
    assert.equal(status.session.source, "unknown");
    const held = h.engine
      .guardModelRequest({
        sessionID: "unreadable-overrides",
        ...selectedModel,
        kind: "primary",
        transport: "model",
      })
      .then(
        () => "released",
        () => "blocked",
      );
    await until(async () => (await h.engine.status(selectedModel)).interactiveWaiting === 1);
    assert.equal((await h.engine.status(selectedModel)).interactiveWaiting, 1);
    await h.engine.dispose();
    assert.equal(await held, "blocked");
  } finally {
    await h.close();
  }
});
