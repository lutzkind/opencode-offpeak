import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { defaultConfig, PricingBlockedError } from "../dist/index.js";
import serverPlugin from "../dist/server.js";
import tuiPlugin from "../dist/tui.js";

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
  let rpcDefinition;
  let rpcHandlers;
  const serverContext = {
    options: { configPath },
    location: { directory: "/fixture-project" },
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
        return { dispose: async () => undefined };
      },
    },
  };

  const dispose = await serverPlugin.setup(serverContext);
  try {
    assert.equal(rpcDefinition.id, "opencode-offpeak");
    assert.ok(hooks.has("http.request"));
    assert.ok(hooks.has("experimental.ws.handshake"));
    assert.ok(hooks.has("experimental.ws.send"));
    await assert.rejects(
      hooks.get("http.request")({
        sessionID: "interactive-session",
        model: { providerID: "opencode-go", id: "deepseek-v4.1-flash" },
        request: new Request("http://fixture.invalid"),
      }),
      PricingBlockedError,
    );

    const off = await rpcHandlers.control({ action: "off" });
    assert.match(off.message, /Peak pricing is still blocked/);
    const queued = await rpcHandlers.control({
      action: "queue",
      prompt: "fixture task",
      cwd: "/fixture-project",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    assert.match(queued.message, /Queued [a-f0-9-]+/);
    assert.equal(sessionStore.size, 0);
    const status = await rpcHandlers.control({
      action: "status",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    assert.equal(status.status.enabled, false);
    assert.equal(status.status.queued, 1);
    assert.equal(status.status.requestsAllowed, false);

    let layer;
    const tuiContext = {
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
        toast: { show: (options) => toasts.push(options) },
      },
    };
    tuiPlugin.setup(tuiContext);
    const command = layer.commands.find((entry) => entry.slash?.name === "offpeak");
    assert.ok(command);
    assert.equal(command.slash.arguments, true);
    assert.deepEqual(command.slash.aliases, ["op"]);
    await command.run("status");
    assert.match(toasts.at(-1).message, /Plugin: DISABLED/);
    await command.run("queue from the TUI");
    assert.match(toasts.at(-1).message, /Queued [a-f0-9-]+/);
    assert.equal((await rpcHandlers.control({ action: "list" })).tasks.length, 2);
  } finally {
    await dispose?.();
    await rm(root, { recursive: true, force: true });
  }
});
