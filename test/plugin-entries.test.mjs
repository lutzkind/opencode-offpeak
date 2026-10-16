import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, PricingBlockedError } from "../dist/index.js";
import serverPlugin from "../dist/server.js";
import tuiPlugin from "../dist/tui.js";

async function assertStillPending(outcome, milliseconds) {
  const result = await Promise.race([
    outcome.then(
      () => "settled",
      () => "settled",
    ),
    new Promise((resolve) => setTimeout(() => resolve("pending"), milliseconds)),
  ]);
  assert.equal(result, "pending");
}

test("OpenCode v2 server and TUI entrypoints register the request gate and /offpeak RPC commands", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-plugin-test-"));
  const configPath = path.join(root, "offpeak.json");
  const blockedPolicy = {
    ...defaultConfig().policies[0],
    blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
  };
  await writeFile(configPath, JSON.stringify({ ...defaultConfig(), policies: [blockedPolicy] }));
  const values = new Map();
  const hooks = new Map();
  const sessionStore = new Map();
  const toasts = [];
  const emittedEvents = [];
  let rpcDefinition;
  let rpcHandlers;
  const eventQueue = [];
  const eventWaiters = [];
  const pushEvent = (event) => {
    const waiter = eventWaiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else eventQueue.push(event);
  };
  const serverContext = {
    options: { configPath },
    app: { name: "opencode", version: "2.0.26", channel: "latest" },
    location: { directory: "/fixture-project" },
    event: {
      subscribe(requestOptions) {
        const signal = requestOptions?.signal;
        return {
          [Symbol.asyncIterator]() {
            return {
              next() {
                if (signal?.aborted) {
                  return Promise.resolve({ value: undefined, done: true });
                }
                const queued = eventQueue.shift();
                if (queued) return Promise.resolve({ value: queued, done: false });
                return new Promise((resolve) => {
                  const finish = () => resolve({ value: undefined, done: true });
                  signal?.addEventListener("abort", finish, { once: true });
                  eventWaiters.push((result) => {
                    signal?.removeEventListener("abort", finish);
                    resolve(result);
                  });
                });
              },
              return() {
                return Promise.resolve({ value: undefined, done: true });
              },
            };
          },
        };
      },
    },
    storage: {
      async get(key) {
        return structuredClone(values.get(key));
      },
      async set(key, value) {
        values.set(key, structuredClone(value));
      },
    },
    session: {
      async hook(name, callback) {
        hooks.set(name, callback);
        return { dispose: async () => hooks.delete(name) };
      },
      async create(input) {
        const id = `session-${sessionStore.size + 1}`;
        sessionStore.set(id, { input, outcome: undefined });
        return { id };
      },
      async prompt(input) {
        const session = sessionStore.get(input.sessionID);
        session.prompt = input;
        session.outcome = "succeeded";
        return {};
      },
      async wait() {},
      async get(input) {
        return sessionStore.get(input.sessionID);
      },
      async interrupt(input) {
        sessionStore.get(input.sessionID).outcome = "interrupted";
        return {};
      },
    },
    rpc: {
      async register(definition, handlers) {
        rpcDefinition = definition;
        rpcHandlers = handlers;
        return {
          dispose: async () => undefined,
          events: {
            async emit(name, data) {
              emittedEvents.push({ name, data });
            },
          },
        };
      },
    },
  };

  const dispose = await serverPlugin.setup(serverContext);
  const heldOutcome = hooks
    .get("http.request")({
      sessionID: "interactive-session",
      kind: "primary",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      request: new Request("http://fixture.invalid"),
    })
    .then(
      () => "resolved",
      (error) => error,
    );
  try {
    assert.equal(rpcDefinition.id, "opencode-offpeak");
    assert.deepEqual(Object.keys(rpcDefinition.events).sort(), ["hold", "resume"]);
    assert.ok(hooks.has("model.request"));
    assert.ok(hooks.has("http.request"));
    assert.ok(hooks.has("experimental.ws.handshake"));
    assert.ok(hooks.has("experimental.ws.send"));
    assert.ok(hooks.has("retry"));

    // A retryable provider failure while peak is active is vetoed (it must not retry
    // into the provider) and recorded for the next off-peak continuation.
    const retryable = {
      sessionID: "retry-session",
      agent: "build",
      model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      error: { type: "provider.transport", message: "Timed out waiting for response headers" },
      attempt: 2,
      decision: { retry: true, delay: 1000 },
    };
    await hooks.get("retry")(retryable);
    assert.deepEqual(retryable.decision, { retry: false });
    // A non-retryable failure keeps OpenCode's terminal decision and no recovery.
    const nonRetryable = {
      ...retryable,
      sessionID: "interactive-invalid",
      error: { type: "provider.invalid-request", message: "fixture invalid request" },
      decision: { retry: false },
    };
    await hooks.get("retry")(nonRetryable);
    assert.deepEqual(nonRetryable.decision, { retry: false });

    // auto + ON + peak: the server entrypoint holds the interactive request at the
    // boundary instead of discarding it, and announces it once to the UI.
    await assertStillPending(heldOutcome, 60);
    await new Promise((resolve) => setTimeout(resolve, 60));
    const holdEvents = emittedEvents.filter((event) => event.name === "hold");
    assert.equal(holdEvents.length, 1);
    assert.equal(holdEvents[0].data.sessionID, "interactive-session");
    assert.equal(typeof holdEvents[0].data.display, "string");
    assert.equal(typeof holdEvents[0].data.until, "number");

    // A primary pre-model request is deferred before any provider attempt exists and
    // persists a deferral entry so a reload can continue the same session.
    const modelHeldOutcome = hooks
      .get("model.request")({
        sessionID: "interactive-model-request",
        kind: "primary",
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      })
      .then(
        () => "resolved",
        (error) => error,
      );
    await assertStillPending(modelHeldOutcome, 60);
    const deferredStatus = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    // One recovery from the retry veto above plus this session's deferral.
    assert.equal(deferredStatus.status.recoveryWaiting, 2);

    // A user interrupt clears the deferral and aborts the hold without continuing.
    pushEvent({
      type: "session.execution.interrupted",
      data: { sessionID: "interactive-model-request", reason: "user" },
    });
    const userAborted = await modelHeldOutcome;
    assert.ok(userAborted instanceof PricingBlockedError);
    assert.match(userAborted.message, /interrupted/);
    const afterUserInterrupt = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    assert.equal(afterUserInterrupt.status.recoveryWaiting, 1);

    // An inactivity interrupt aborts the hold but keeps the deferral so the same
    // session continues at the next allowed window.
    const inactivityHeld = hooks
      .get("model.request")({
        sessionID: "interactive-inactivity",
        kind: "primary",
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
      })
      .then(
        () => "resolved",
        (error) => error,
      );
    await assertStillPending(inactivityHeld, 60);
    pushEvent({
      type: "session.execution.interrupted",
      data: { sessionID: "interactive-inactivity", reason: "inactivity" },
    });
    const inactivityAborted = await inactivityHeld;
    assert.ok(inactivityAborted instanceof PricingBlockedError);
    const afterInactivity = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    assert.equal(afterInactivity.status.recoveryWaiting, 2);

    // Session-scoped protection: default ON; the explicit OFF is this one
    // session's authorization for verified peak-priced inference, and it also
    // releases that session's still-valid waiting work immediately.
    const defaultProtection = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      sessionID: "entrypoint-override",
    });
    assert.equal(defaultProtection.status.sessionProtection, "ON");
    // The fake host now knows the session exists; lazy pruning must keep state
    // for a session that still exists.
    sessionStore.set("entrypoint-override", { outcome: undefined, time: { created: Date.now() } });
    const overrideHeld = hooks
      .get("http.request")({
        sessionID: "entrypoint-override",
        kind: "primary",
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
        request: new Request("http://fixture.invalid"),
      })
      .then(
        () => "released",
        (error) => error,
      );
    await assertStillPending(overrideHeld, 60);
    const sessionOff = await rpcHandlers.control({
      action: "session-off",
      sessionID: "entrypoint-override",
    });
    assert.equal(sessionOff.state, "OFF");
    assert.match(sessionOff.message, /Session off-peak protection disabled/);
    // The held request wakes immediately, in the same session, at peak rates.
    assert.equal(await overrideHeld, "released");
    const overridden = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      sessionID: "entrypoint-override",
    });
    assert.equal(overridden.status.sessionProtection, "OFF");
    assert.equal(overridden.status.pricingState, "PEAK");
    assert.equal(overridden.status.requestsAllowed, true);
    // Without a session ID the command is refused rather than guessing.
    await assert.rejects(
      rpcHandlers.control({ action: "session-off" }),
      /No current OpenCode session/,
    );
    // OpenCode's own session-deletion event reaps the override.
    pushEvent({ type: "session.deleted", data: { sessionID: "entrypoint-override" } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const afterDeletion = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      sessionID: "entrypoint-override",
    });
    assert.equal(afterDeletion.status.sessionProtection, "ON");
    const sessionOn = await rpcHandlers.control({
      action: "session-on",
      sessionID: "entrypoint-override",
    });
    assert.equal(sessionOn.state, "ON");
    assert.match(sessionOn.message, /Session off-peak protection enabled/);

    const off = await rpcHandlers.control({ action: "off" });
    assert.match(off.message, /Peak pricing is still blocked/);
    // OFF never releases a held request and is not a price override.
    await assertStillPending(heldOutcome, 60);
    // A fresh interactive peak request while OFF is blocked immediately.
    await assert.rejects(
      hooks.get("http.request")({
        sessionID: "interactive-off",
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
        request: new Request("http://fixture.invalid"),
      }),
      PricingBlockedError,
    );
    const queued = await rpcHandlers.control({
      action: "queue",
      prompt: "fixture task",
      cwd: "/fixture-project",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    assert.match(queued.message, /Queued [a-f0-9-]+/);
    // No task session was created while the plugin is OFF (the pre-registered
    // verification sessions carry no task input).
    assert.equal([...sessionStore.values()].filter((session) => session.input).length, 0);
    const status = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    assert.equal(status.status.enabled, false);
    assert.equal(status.status.queued, 1);
    assert.equal(status.status.requestsAllowed, false);
    assert.equal(status.status.interactiveWaiting, 1);
    assert.equal(status.status.recoveryWaiting, 2);
    // Without a session, no session protection is reported (home screen).
    assert.equal(status.status.sessionProtection, undefined);

    let layer;
    const eventHandlers = new Map();
    const tuiContext = {
      app: { name: "opencode", version: "2.0.26", channel: "latest" },
      data: {
        on(type, handler) {
          eventHandlers.set(type, handler);
          return () => eventHandlers.delete(type);
        },
      },
      keymap: { layer: (factory) => (layer = factory()) },
      client: {
        rpc: (definition) => {
          assert.equal(definition.id, "opencode-offpeak");
          return { control: (input) => rpcHandlers.control(input) };
        },
      },
      location: { directory: "/fixture-project" },
      ui: {
        model: { current: () => ({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }) },
        router: { current: () => ({ type: "session", sessionID: "tui-session" }) },
        tabs: { list: () => [] },
        toast: { show: (options) => toasts.push(options) },
      },
    };
    const disposeTui = tuiPlugin.setup(tuiContext);
    assert.deepEqual([...eventHandlers.keys()].sort(), [
      "rpc.opencode-offpeak.hold",
      "rpc.opencode-offpeak.resume",
    ]);
    // The TUI renders the server's notifications as non-chat toasts.
    eventHandlers.get("rpc.opencode-offpeak.hold")({
      type: "rpc.opencode-offpeak.hold",
      data: { sessionID: "interactive-session", display: "04:00 UTC", until: 1, timeZone: "UTC" },
    });
    assert.match(toasts.at(-1).message, /request held until 04:00 UTC/);
    assert.equal(toasts.at(-1).sessionID, "interactive-session");
    eventHandlers.get("rpc.opencode-offpeak.hold")({ type: "rpc.opencode-offpeak.hold", data: {} });
    assert.equal(toasts.length, 1);
    eventHandlers.get("rpc.opencode-offpeak.resume")({
      type: "rpc.opencode-offpeak.resume",
      data: { sessionID: "interactive-session", kind: "continuation" },
    });
    assert.match(toasts.at(-1).message, /Continuing this session/);
    eventHandlers.get("rpc.opencode-offpeak.resume")({
      type: "rpc.opencode-offpeak.resume",
      data: { sessionID: "interactive-session", kind: "release" },
    });
    assert.match(toasts.at(-1).message, /Resuming the held request/);
    await disposeTui();
    assert.equal(eventHandlers.size, 0);
    assert.equal(layer.mode, "global");
    const command = layer.commands.find((entry) => entry.slash?.name === "offpeak");
    assert.ok(command);
    assert.equal(command.id, "opencode-offpeak.command");
    assert.equal(command.slash.arguments, true);
    assert.deepEqual(command.slash.aliases, ["op"]);
    await command.run("/offpeak status");
    assert.match(toasts.at(-1).message, /Plugin: DISABLED/);
    await command.run("/op queue from the TUI");
    assert.match(toasts.at(-1).message, /Queued [a-f0-9-]+/);
    const tasks = (await rpcHandlers.control({ action: "list" })).tasks;
    assert.equal(tasks.length, 2);
    await command.run(`/offpeak cancel ${tasks[0].id}`);
    assert.match(toasts.at(-1).message, /Cancelled/);
    await command.run(`/offpeak remove ${tasks[0].id}`);
    assert.match(toasts.at(-1).message, /Removed/);
    assert.equal((await rpcHandlers.control({ action: "list" })).tasks.length, 1);

    // Session protection from the real TUI command: the focused session is
    // resolved from the supported route, never typed by hand.
    sessionStore.set("tui-session", { outcome: undefined, time: { created: Date.now() } });
    await command.run("/offpeak session off");
    assert.match(toasts.at(-1).message, /Session off-peak protection disabled/);
    assert.match(toasts.at(-1).message, /verified peak-priced inference/);
    const tuiSessionStatus = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      sessionID: "tui-session",
    });
    assert.equal(tuiSessionStatus.status.sessionProtection, "OFF");
    await command.run("/offpeak status");
    assert.match(toasts.at(-1).message, /Session protection: OFF/);
    await command.run("/offpeak session on");
    assert.match(toasts.at(-1).message, /Session off-peak protection enabled/);
    await command.run("/offpeak status");
    assert.match(toasts.at(-1).message, /Session protection: ON/);
    await command.run("/offpeak session sometimes");
    assert.match(toasts.at(-1).message, /Usage: \/offpeak session on\|off/);
    // Without a focused session the command refuses instead of guessing.
    tuiContext.ui.router.current = () => ({ type: "home" });
    await command.run("/offpeak session off");
    assert.match(toasts.at(-1).message, /No current OpenCode session is focused/);
    tuiContext.ui.router.current = () => ({ type: "session", sessionID: "tui-session" });
  } finally {
    await dispose?.();
    await rm(root, { recursive: true, force: true });
  }
  // Shutdown fails the still-held request closed instead of releasing it under
  // an uncertain pricing state.
  const shutdown = await heldOutcome;
  assert.ok(shutdown instanceof PricingBlockedError);
  assert.match(shutdown.message, /shutting down/);
});

test("both entrypoints reject unsupported OpenCode hosts with an actionable error", async () => {
  const oldHost = { name: "opencode", version: "2.0.18", channel: "latest" };
  await assert.rejects(async () => {
    await serverPlugin.setup({
      options: {},
      app: oldHost,
      location: { directory: "/fixture-project" },
      storage: { get: async () => undefined, set: async () => undefined },
      session: {
        hook: async () => ({ dispose: async () => undefined }),
        create: async () => ({ id: "session" }),
        prompt: async () => ({}),
        wait: async () => undefined,
        get: async () => ({}),
        interrupt: async () => ({}),
      },
      rpc: { register: async () => ({ dispose: async () => undefined }) },
    });
  }, /requires OpenCode >=2\.0\.26 <2\.1\.0; this server host runs 2\.0\.18/);
  await assert.rejects(async () => {
    await tuiPlugin.setup({
      app: oldHost,
      keymap: { layer: () => assert.fail("keymap.layer must not run on an unsupported host") },
      client: { rpc: () => ({ control: async () => ({}) }) },
      location: { directory: "/fixture-project" },
      ui: {
        model: { current: () => undefined },
        toast: { show: () => undefined },
      },
    });
  }, /requires OpenCode >=2\.0\.26 <2\.1\.0; this TUI host runs 2\.0\.18/);
  await assert.rejects(async () => {
    await tuiPlugin.setup({
      app: undefined,
      keymap: { layer: () => assert.fail("keymap.layer must not run without a host version") },
      client: { rpc: () => ({ control: async () => ({}) }) },
      location: { directory: "/fixture-project" },
      ui: {
        model: { current: () => undefined },
        toast: { show: () => undefined },
      },
    });
  }, /this TUI host runs an unknown version/);
});
