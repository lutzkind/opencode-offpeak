import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import * as gui from "@opencode/plugin/gui";
import { createRoot } from "solid-js";
import {
  defaultServerID,
  ownershipLabel,
  peakInferencePermitted,
  readClientStatus,
  registerDesktopSession,
  resolveTargetServer,
  serverOptions,
  sessionOverrideActive,
  setDesktopProtection,
  setSessionProtection,
  sourceLabel,
} from "../dist/gui/connection.js";
import serverPlugin from "../dist/server.js";
import tuiPlugin from "../dist/tui.js";

const root = path.resolve(import.meta.dirname, "..");
const bundlePath = path.join(root, "dist/gui-experimental.cjs");

/**
 * The packaged GUI is CommonJS and requires the app's shared modules. Node's
 * default condition would give Solid's server build, which rejects the client
 * APIs at require time; the app provides the browser build. This loader gives
 * the bundle the real ESM GUI SDK and the minimal Solid web runtime its module
 * scope touches, so the actual packaged file can be loaded and its setup
 * exercised.
 */
async function loadBundle() {
  const web = {
    template: () => ({ firstChild: {} }),
    insert: () => undefined,
    createComponent: () => undefined,
    spread: () => undefined,
    setAttribute: () => undefined,
  };
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === "@opencode/plugin/gui") return gui;
    if (request === "solid-js/web") return web;
    return original.call(this, request, ...rest);
  };
  try {
    const require = Module.createRequire(import.meta.url);
    return require(bundlePath);
  } finally {
    Module._load = original;
  }
}

function fakeClient(name, calls, result) {
  return {
    rpc(definition) {
      calls.push({ server: name, definition: definition.id });
      return {
        control(input) {
          calls.push({ server: name, action: input.action, input });
          if (result instanceof Error) return Promise.reject(result);
          return Promise.resolve(result);
        },
      };
    },
  };
}

function server(id, name, calls, result) {
  return {
    id,
    name,
    url: `http://${id}.invalid`,
    client: fakeClient(id, calls, result),
    connected: true,
    builtin: id === "sidecar",
  };
}

const statusResult = {
  client: {
    defaults: { cli: "ON", desktop: "OFF" },
    session: {
      sessionID: "ses_remote",
      ownership: "desktop",
      protection: "OFF",
      source: "client-default",
    },
  },
};

test("the packaged Desktop GUI loads and registers exactly one command and settings page", async () => {
  const bundle = await loadBundle();
  assert.equal(typeof bundle.default?.setup, "function");
  const calls = [];
  const remote = server("remote", "Remote", calls, statusResult);
  const local = server("sidecar", "Local", calls, statusResult);
  const session = { id: "ses_remote", key: "remote\nses_remote", pending: false, server: remote };
  const additions = [];
  const context = {
    id: "opencode-offpeak",
    sessions: { current: () => session },
    servers: {
      list: () => ["sidecar", "remote"],
      get: (id) => (id === "remote" ? remote : id === "sidecar" ? local : undefined),
    },
    client: local.client,
    add(registry, item) {
      additions.push({ registry, item: typeof item === "function" ? item() : item });
      return () => undefined;
    },
    layout: { settings: (page) => calls.push({ settings: page }) },
    ui: {},
  };
  const dispose = createRoot((disposeRoot) => {
    bundle.default.setup(context);
    return disposeRoot;
  });
  try {
    // The settings page has the native shape and only the Desktop setting.
    const page = additions.find((entry) => entry.registry === gui.SettingsPage)?.item;
    assert.ok(page);
    assert.equal(page.id, "opencode-offpeak");
    assert.equal(typeof page.render, "function");
    assert.ok(page.entries.some((entry) => entry.id === "desktop-protection"));
    assert.ok(page.entries.some((entry) => entry.id === "session-override"));
    const command = additions.find((entry) => entry.registry === gui.Command)?.item;
    assert.equal(command.id, "settings");
    command.run();
    assert.deepEqual(calls.at(-1), { settings: "opencode-offpeak" });
    // Registration targets the routed session's remote server, never the
    // Desktop sidecar that loaded the GUI.
    assert.deepEqual(
      calls.filter((call) => call.action === "client-register").map((call) => call.server),
      ["remote"],
    );
    assert.equal(calls.find((call) => call.action === "client-register").input.client, "desktop");
    // One command and one settings page: no duplicate registration.
    assert.equal(additions.filter((entry) => entry.registry === gui.Command).length, 1);
    assert.equal(additions.filter((entry) => entry.registry === gui.SettingsPage).length, 1);
  } finally {
    dispose();
  }
});

test("GUI RPC targets the selected session's server and the settings helpers never use the sidecar", async () => {
  const calls = [];
  const remote = server("remote", "Remote", calls, statusResult);
  const local = server("sidecar", "Local", calls, statusResult);
  const session = { id: "ses_remote", key: "remote\nses_remote", pending: false, server: remote };
  const context = {
    sessions: { current: () => session },
    servers: {
      list: () => ["sidecar", "remote"],
      get: (id) => (id === "remote" ? remote : id === "sidecar" ? local : undefined),
    },
    client: local.client,
  };
  assert.equal(defaultServerID(context), "remote");
  assert.equal(resolveTargetServer(context), remote);
  assert.equal(resolveTargetServer(context, "sidecar"), local);
  assert.deepEqual(
    serverOptions(context).map((option) => option.value),
    ["sidecar", "remote"],
  );
  const read = await readClientStatus(context, "remote", "ses_remote");
  assert.equal(read.defaults.desktop, "OFF");
  const written = await setDesktopProtection(context, "off", "remote", "ses_remote");
  assert.equal(written.session.protection, "OFF");
  await registerDesktopSession(session);
  const actions = calls.filter((call) => call.action !== undefined);
  assert.ok(
    actions.every((call) => call.server === "remote"),
    JSON.stringify(actions),
  );
  assert.deepEqual(
    actions.map((call) => call.action),
    ["client", "client-set", "client-register"],
  );
  assert.deepEqual(
    actions.filter((call) => call.action === "client-set").map((call) => call.input),
    [{ action: "client-set", client: "desktop", protection: "off", sessionID: "ses_remote" }],
  );
  assert.equal(peakInferencePermitted(read), true);
  assert.equal(ownershipLabel("ambiguous"), "Shared session (CLI + Desktop); protected");
  assert.match(sourceLabel("unknown"), /fail-closed/);
});

test("GUI session override targets the owning server and re-reads the authoritative status", async () => {
  const calls = [];
  const remote = server("remote", "Remote", calls, statusResult);
  const local = server("sidecar", "Local", calls, statusResult);
  const context = {
    sessions: { current: () => ({ id: "ses_remote", server: remote }) },
    servers: {
      list: () => ["sidecar", "remote"],
      get: (id) => (id === "remote" ? remote : id === "sidecar" ? local : undefined),
    },
    client: local.client,
  };

  const next = await setSessionProtection(context, "off", "remote", "ses_remote");
  assert.equal(next.defaults.desktop, "OFF");
  // The write goes to the session's own server, followed by one authoritative read.
  assert.deepEqual(
    calls
      .filter((call) => call.action !== undefined)
      .map((call) => `${call.server}:${call.action}`),
    ["remote:session-off", "remote:client"],
  );
  assert.deepEqual(calls.find((call) => call.action === "session-off").input, {
    action: "session-off",
    sessionID: "ses_remote",
  });

  calls.length = 0;
  await setSessionProtection(context, "on", "remote", "ses_remote");
  assert.deepEqual(
    calls.filter((call) => call.action !== undefined).map((call) => call.action),
    ["session-on", "client"],
  );

  await assert.rejects(
    () => setSessionProtection(context, "off", "remote", undefined),
    /Open a session/,
  );
});

test("sessionOverrideActive reflects only the explicit override, not a client default", () => {
  const override = {
    defaults: { cli: "ON", desktop: "ON" },
    session: {
      sessionID: "ses_remote",
      ownership: "cli",
      protection: "OFF",
      source: "session-override",
    },
  };
  const byDefault = {
    defaults: { cli: "ON", desktop: "OFF" },
    session: {
      sessionID: "ses_remote",
      ownership: "desktop",
      protection: "OFF",
      source: "client-default",
    },
  };
  assert.equal(sessionOverrideActive(override), true);
  assert.equal(sessionOverrideActive(byDefault), false);
  assert.equal(sessionOverrideActive(undefined), false);
});

test("GUI settings fail clearly when the remote server is unavailable or rejects the RPC", async () => {
  const calls = [];
  const remote = server("remote", "Remote", calls, new Error("remote offline"));
  const context = {
    sessions: { current: () => ({ id: "ses_remote", server: remote }) },
    servers: { list: () => ["remote"], get: () => remote },
    client: remote.client,
  };
  await assert.rejects(() => readClientStatus(context, "remote", "ses_remote"), /remote offline/);
  await assert.rejects(
    () => setDesktopProtection(context, "on", "remote", "ses_remote"),
    /remote offline/,
  );
  const empty = {
    sessions: { current: () => undefined },
    servers: { list: () => [], get: () => undefined },
    client: remote.client,
  };
  await assert.rejects(() => readClientStatus(empty, undefined, undefined), /No OpenCode server/);
});

test("server, TUI, and GUI entrypoints load together without duplicate server initialization", async () => {
  const bundle = await loadBundle();
  assert.equal(bundle.default.setup !== undefined, true);
  assert.equal(serverPlugin.id, "opencode-offpeak");
  assert.equal(tuiPlugin.id, "opencode-offpeak");
  // Loading the GUI bundle does not import or run the server engine.
  const source = await readFile(bundlePath, "utf8");
  assert.doesNotMatch(source, /OffpeakEngine/);
  assert.doesNotMatch(source, /\.\/server\.js/);
  assert.doesNotMatch(source, /\.\/engine\.js/);
  assert.doesNotMatch(source, /\.\/store\.js/);
  // The GUI expects only the app-provided shared modules.
  const requires = [...source.matchAll(/require\("([^"]+)"\)/g)].map((match) => match[1]);
  assert.deepEqual([...new Set(requires)].sort(), [
    "@opencode/plugin/gui",
    "solid-js",
    "solid-js/web",
  ]);
});
