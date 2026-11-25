import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import Module from "node:module";
import path from "node:path";
import test from "node:test";
import * as gui from "@opencode/plugin/gui";
import * as solid from "solid-js";
import { createRoot } from "solid-js";
import {
  defaultServerID,
  ensureSessionMetadata,
  openSessions,
  ownershipLabel,
  peakInferencePermitted,
  readClientStatus,
  registerDesktopSession,
  rememberRoutedSession,
  resolveSessionTarget,
  resolveTargetServer,
  runDesktopOffpeakCommand,
  serverOptions,
  sessionDirectory,
  sessionDisplayName,
  sessionOverrideActive,
  sessionProjectName,
  sessionTitle,
  setDesktopProtection,
  setSessionProtection,
  shortSessionID,
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
    if (request === "solid-js") return solid;
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
          if (typeof result === "function") return Promise.resolve(result(input));
          return Promise.resolve(result);
        },
      };
    },
  };
}

function server(id, name, calls, result, data) {
  return {
    id,
    name,
    url: `http://${id}.invalid`,
    client: fakeClient(id, calls, result),
    connected: true,
    builtin: id === "sidecar",
    ...(data ? { data } : {}),
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

test("the packaged Desktop GUI loads and registers the settings page plus one slash command", async () => {
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
    const bundleSource = await readFile(bundlePath, "utf8");
    assert.match(bundleSource, /Desktop Protection/);
    assert.match(bundleSource, /Off-peak protection/);
    assert.equal(
      page.entries.find((entry) => entry.id === "desktop-protection")?.title,
      "Desktop Protection",
    );
    assert.equal(
      page.entries.find((entry) => entry.id === "chat-protection")?.title,
      "Off-peak protection for this chat",
    );
    const commands = additions
      .filter((entry) => entry.registry === gui.Command)
      .map((entry) => entry.item);
    const settingsCommand = commands.find((entry) => entry.id === "settings");
    assert.ok(settingsCommand);
    settingsCommand.run();
    assert.deepEqual(calls.at(-1), { settings: "opencode-offpeak" });
    const slashCommand = commands.find((entry) => entry.slash?.name === "offpeak");
    assert.ok(slashCommand);
    assert.equal(slashCommand.slash.arguments, true);
    assert.equal(slashCommand.section, "session");
    // Registration targets the routed session's remote server, never the
    // Desktop sidecar that loaded the GUI.
    assert.deepEqual(
      calls.filter((call) => call.action === "client-register").map((call) => call.server),
      ["remote"],
    );
    assert.equal(calls.find((call) => call.action === "client-register").input.client, "desktop");
    // One settings page and exactly one slash command: no duplicate handler.
    assert.equal(additions.filter((entry) => entry.registry === gui.Command).length, 2);
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
  assert.equal(ownershipLabel("unknown"), "Unknown client; protected");
  assert.match(sourceLabel("unknown"), /protected/);
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
  // The write goes to the session's own server and returns its new state.
  assert.deepEqual(
    calls
      .filter((call) => call.action !== undefined)
      .map((call) => `${call.server}:${call.action}`),
    ["remote:session-set"],
  );
  assert.deepEqual(calls.find((call) => call.action === "session-set").input, {
    action: "session-set",
    sessionID: "ses_remote",
    protection: "off",
  });

  calls.length = 0;
  await setSessionProtection(context, "auto", "remote", "ses_remote");
  assert.deepEqual(
    calls.filter((call) => call.action !== undefined).map((call) => call.action),
    ["session-set"],
  );

  await assert.rejects(
    () => setSessionProtection(context, "off", "remote", undefined),
    /Open a chat/,
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

test("settings resolves the routed session after the route leaves the session screen", () => {
  rememberRoutedSession(undefined);
  const calls = [];
  const remote = server("remote", "Remote", calls, statusResult);
  const local = server("sidecar", "Local", calls, statusResult);
  const remoteSession = { id: "ses_a", key: "remote\nses_a", pending: false, server: remote };
  const otherSession = { id: "ses_b", key: "remote\nses_b", pending: false, server: remote };
  const servers = {
    list: () => ["sidecar", "remote"],
    get: (id) => (id === "remote" ? remote : id === "sidecar" ? local : undefined),
  };
  const base = {
    client: local.client,
    servers,
    sessions: {
      current: () => remoteSession,
      list: () => [otherSession, remoteSession],
    },
  };

  // Mounted session wins.
  assert.equal(resolveSessionTarget(base), remoteSession);

  // Settings unmounts the session screen: the active tab still identifies it.
  const byTab = {
    ...base,
    sessions: { current: () => undefined, list: () => [otherSession, remoteSession] },
    tabs: { list: () => [{ key: "remote\nses_b", session: otherSession, active: true }] },
  };
  assert.equal(resolveSessionTarget(byTab), otherSession);

  // No mounted screen and no active tab: the last routed session is remembered.
  rememberRoutedSession(remoteSession);
  const remembered = {
    ...base,
    sessions: { current: () => undefined, list: () => [otherSession, remoteSession] },
    tabs: { list: () => [{ key: "remote\nses_b", session: otherSession, active: false }] },
  };
  assert.equal(resolveSessionTarget(remembered), remoteSession);

  // An explicit pick wins over the remembered session.
  assert.equal(resolveSessionTarget(remembered, "ses_b"), otherSession);

  // Nothing routed, one open session: it is the only safe choice.
  rememberRoutedSession(undefined);
  const sole = {
    ...base,
    sessions: { current: () => undefined, list: () => [remoteSession] },
    tabs: { list: () => [] },
  };
  assert.equal(resolveSessionTarget(sole), remoteSession);

  // Nothing open at all.
  const none = {
    ...base,
    sessions: { current: () => undefined, list: () => [] },
  };
  assert.equal(resolveSessionTarget(none), undefined);
  assert.deepEqual(openSessions(none), []);
  rememberRoutedSession(undefined);
});

test("the settings page prefers the session's server, then the local server", () => {
  rememberRoutedSession(undefined);
  const calls = [];
  const remote = server("remote", "Remote", calls, statusResult);
  const local = server("sidecar", "Local", calls, statusResult);
  const servers = {
    list: () => ["remote", "sidecar"],
    get: (id) => (id === "remote" ? remote : id === "sidecar" ? local : undefined),
  };
  const noSession = {
    client: local.client,
    servers,
    sessions: { current: () => undefined, list: () => [] },
  };
  // The Desktop's own server is always present and reachable; a remote is only
  // used when it owns the session or the user picks it.
  assert.equal(defaultServerID(noSession), "sidecar");

  const remoteSession = { id: "ses_a", key: "remote\nses_a", pending: false, server: remote };
  const withSession = {
    ...noSession,
    sessions: { current: () => undefined, list: () => [remoteSession] },
  };
  assert.equal(defaultServerID(withSession), "remote");
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

test("Desktop session labels use actual titles, project names, and shortened IDs", () => {
  const calls = [];
  const infos = {
    ses_abcdefghijklmnop: {
      title: "Fix the login flow",
      projectID: "prj_payments",
      location: { directory: "/work/payments/subdir" },
    },
    ses_untitled: { projectID: "prj_unknown", location: { directory: "/work/plain" } },
  };
  const projects = {
    prj_payments: { name: "Payments", canonical: "/work/payments" },
    prj_other: { canonical: "/work/other-repo" },
  };
  const syncs = [];
  const data = {
    session: {
      get: (id) => infos[id],
      missing: (id) => infos[id] === undefined && id === "ses_missing",
      sync: async (id) => {
        syncs.push(id);
        await new Promise((resolve) => setTimeout(resolve, 0));
        infos[id] = { title: "Loaded from the server", projectID: "prj_payments" };
      },
    },
    project: { get: (id) => projects[id] },
  };
  const remote = server("remote", "Remote", calls, statusResult, data);
  const session = {
    id: "ses_abcdefghijklmnop",
    key: "remote\nses_abcdefghijklmnop",
    pending: false,
    server: remote,
  };
  assert.equal(sessionTitle(session), "Fix the login flow");
  assert.equal(sessionProjectName(session), "Payments");
  assert.match(
    sessionDisplayName(session),
    /^Fix the login flow — Payments \(ses_abcdefgh…mnop\)$/,
  );
  assert.equal(shortSessionID(session.id), "ses_abcdefgh…mnop");
  assert.equal(session.id, "ses_abcdefghijklmnop");
  assert.equal(sessionDirectory(session), "/work/payments/subdir");

  // OpenCode's rename event updates the reactive store; the computed label
  // follows it instead of caching a title of its own.
  infos[session.id].title = "Renamed login flow";
  assert.match(sessionDisplayName(session), /^Renamed login flow — Payments/);

  // A genuinely untitled session gets a fallback label, never an invented title.
  const untitled = { ...session, id: "ses_untitled" };
  assert.equal(sessionTitle(untitled), "Untitled session");
  assert.equal(sessionProjectName(untitled), "plain");
  assert.match(sessionDisplayName(untitled), /^Untitled session — plain/);

  // Project metadata may be unavailable; the canonical directory basename is
  // still a truthful secondary label.
  const projectless = {
    ...session,
    id: "ses_projectless",
  };
  infos.ses_projectless = { title: "No project row", location: { directory: "/work/other-repo" } };
  assert.equal(sessionProjectName(projectless), "other-repo");

  const foreign = { ...session, id: "ses_foreign" };
  ensureSessionMetadata(foreign);
  ensureSessionMetadata(foreign);
  assert.equal(syncs.length, 1);
  assert.equal(syncs[0], "ses_foreign");
  assert.equal(sessionTitle(foreign), "Untitled session");
  // The sync is asynchronous and the store updates; a later render sees it.
  return new Promise((resolve) => setTimeout(resolve, 0)).then(() => {
    assert.equal(sessionTitle(foreign), "Loaded from the server");
    ensureSessionMetadata(foreign);
    assert.equal(syncs.length, 1, "a loaded session is never re-fetched");
    const missing = { ...session, id: "ses_missing" };
    ensureSessionMetadata(missing);
    assert.equal(syncs.length, 1, "a confidently missing session is not fetched");
  });
});

test("Desktop chat slash commands use the shared handler and the Desktop surface", async () => {
  const bundle = await loadBundle();
  const calls = [];
  const toasts = [];
  const remote = server("remote", "Remote", calls, (input) => {
    if (input.action === "client-register") {
      return {
        client: {
          defaults: { cli: "ON", desktop: "ON" },
          session: {
            sessionID: "ses_remote",
            ownership: "desktop",
            protection: "ON",
            source: "client-default",
          },
        },
      };
    }
    if (input.action === "client-set") {
      return {
        client: {
          defaults: { cli: "ON", desktop: input.protection === "off" ? "OFF" : "ON" },
          session: {
            sessionID: "ses_remote",
            ownership: "desktop",
            protection: input.protection === "off" ? "OFF" : "ON",
            source: "client-default",
          },
        },
      };
    }
    if (input.action === "session-set") {
      return {
        client: {
          defaults: { cli: "ON", desktop: "ON" },
          session: {
            sessionID: "ses_remote",
            ownership: "desktop",
            protection: input.protection === "off" ? "OFF" : "ON",
            source: input.protection === "auto" ? "client-default" : "session-override",
            ...(input.protection === "auto" ? {} : { override: input.protection }),
          },
        },
      };
    }
    return {
      status: {
        enabled: true,
        mode: "auto",
        pricingState: "PEAK",
        clientDefaults: { cli: "ON", desktop: "OFF" },
        client: { ownership: "desktop", protection: "OFF", source: "client-default" },
        effectiveProtection: "OFF",
        requestsAllowed: true,
        queued: 0,
        waiting: 0,
        failed: 0,
      },
    };
  });
  const session = { id: "ses_remote", key: "remote\nses_remote", pending: false, server: remote };
  const additions = [];
  const context = {
    id: "opencode-offpeak",
    sessions: { current: () => session, list: () => [session] },
    servers: { list: () => ["remote"], get: () => remote },
    client: remote.client,
    screen: {
      current: () => ({
        composer: {
          model: () => ({ providerID: "opencode-go", modelID: "deepseek-v4.1-flash" }),
        },
      }),
    },
    toast: { show: (options) => toasts.push(options) },
    add(registry, item) {
      additions.push({ registry, item: typeof item === "function" ? item() : item });
      return () => undefined;
    },
    layout: { settings: () => undefined },
    ui: {},
  };
  const dispose = createRoot((disposeRoot) => {
    bundle.default.setup(context);
    return disposeRoot;
  });
  try {
    const command = additions.find(
      (entry) => entry.registry === gui.Command && entry.item.slash?.name === "offpeak",
    )?.item;
    assert.ok(command);
    await command.run("off");
    assert.deepEqual(calls.filter((call) => call.action === "client-set").at(-1).input, {
      action: "client-set",
      client: "desktop",
      protection: "off",
      sessionID: "ses_remote",
    });
    assert.match(toasts.at(-1).description, /^Desktop protection: OFF$/m);
    assert.match(toasts.at(-1).description, /CLI protection: ON \(not modified\)/);

    await command.run("chat off");
    assert.deepEqual(calls.filter((call) => call.action === "session-set").at(-1).input, {
      action: "session-set",
      sessionID: "ses_remote",
      protection: "off",
    });
    assert.match(toasts.at(-1).description, /This chat: allow peak \(explicit\)/);
    assert.match(toasts.at(-1).description, /Desktop protection: ON \(unchanged\)/);

    await command.run("status");
    assert.deepEqual(calls.filter((call) => call.action === "status").at(-1).input, {
      action: "status",
      sessionID: "ses_remote",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    });
    assert.match(toasts.at(-1).description, /CLI protection: ON/);
    assert.match(toasts.at(-1).description, /Desktop protection: OFF/);

    // The helper rejects when no Desktop server can be resolved.
    await assert.rejects(
      () =>
        runDesktopOffpeakCommand(
          {
            sessions: { current: () => undefined },
            servers: { list: () => [], get: () => undefined },
          },
          "status",
        ),
      /No OpenCode server/,
    );
  } finally {
    dispose();
  }
});

test("Desktop shows the server's hold and resume events as non-chat toasts", async () => {
  const bundle = await loadBundle();
  const handlers = new Map();
  const toasts = [];
  const data = {
    session: { get: () => ({ title: "Held chat", projectID: "prj" }) },
    project: { get: () => ({ name: "Fixture" }) },
    on(type, handler) {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  };
  const calls = [];
  const remote = server("remote", "Remote", calls, statusResult, data);
  const session = { id: "ses_remote", key: "remote\nses_remote", pending: false, server: remote };
  const additions = [];
  const context = {
    id: "opencode-offpeak",
    sessions: { current: () => session, list: () => [session] },
    servers: { list: () => ["remote"], get: () => remote },
    client: remote.client,
    toast: { show: (options) => toasts.push(options) },
    add(registry, item) {
      additions.push({ registry, item: typeof item === "function" ? item() : item });
      return () => undefined;
    },
    layout: { settings: () => undefined },
    ui: {},
  };
  const dispose = createRoot((disposeRoot) => {
    bundle.default.setup(context);
    return disposeRoot;
  });
  try {
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.deepEqual([...handlers.keys()].sort(), [
      "rpc.opencode-offpeak.hold",
      "rpc.opencode-offpeak.resume",
    ]);
    handlers.get("rpc.opencode-offpeak.hold")({
      data: { sessionID: "ses_remote", display: "04:00 UTC" },
    });
    assert.match(toasts.at(-1).description, /request held until 04:00 UTC/);
    handlers.get("rpc.opencode-offpeak.hold")({ data: {} });
    assert.equal(toasts.length, 1);
    handlers.get("rpc.opencode-offpeak.resume")({
      data: { sessionID: "ses_remote", kind: "override" },
    });
    assert.match(toasts.at(-1).description, /Protection is OFF for this chat/);
    assert.equal(toasts.at(-1).variant, "success");
  } finally {
    dispose();
  }
  assert.equal(handlers.size, 0, "subscriptions are removed with the plugin");
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
