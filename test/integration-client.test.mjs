import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { OpenCode } from "@opencode/client";
import { defaultConfig } from "../dist/index.js";
import { OFFPEAK_RPC } from "../dist/rpc.js";
import { createFixtureProvider } from "./fixtures/fixture-provider.mjs";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
async function hasBinary(binary) {
  try {
    await exec("which", [binary]);
    return true;
  } catch {
    return false;
  }
}
const skip = (await hasBinary("opencode"))
  ? false
  : "requires the OpenCode v2 CLI (opencode) on PATH";
const hostVersion = skip
  ? "unavailable"
  : await exec("opencode", ["--version"]).then(
      ({ stdout }) =>
        stdout
          .trim()
          .replace(/^opencode\s+/i, "")
          .replace(/^v/, ""),
      () => "unknown",
    );
const password = `fixture-${process.pid}-${Math.random().toString(16).slice(2)}`;
const auth = `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;

async function waitFor(check, message, timeoutMs = 60000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try {
      last = await check();
      if (last) return last;
    } catch (error) {
      last = error;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`${message} (last: ${last})`);
}

function nextMinuteWindow() {
  const now = new Date();
  const minute = Math.floor(now.getUTCMinutes()) + 1;
  const hour = now.getUTCHours() + Math.floor(minute / 60);
  const minuteOfHour = minute % 60;
  if (hour >= 24) return undefined;
  const end = `${String(hour).padStart(2, "0")}:${String(minuteOfHour).padStart(2, "0")}`;
  if (end === "00:00") return undefined;
  return end;
}

/**
 * Returns the next UTC minute boundary, waiting for the following minute when
 * less than `minimumSeconds` remain. Without that guard a slow setup can reach
 * the policy boundary before the peak request under test is made.
 */
async function peakWindow(minimumSeconds = 20) {
  const secondsLeft = 60 - new Date().getUTCSeconds();
  if (secondsLeft < minimumSeconds) {
    await new Promise((resolve) => setTimeout(resolve, (secondsLeft + 1) * 1000));
  }
  return nextMinuteWindow();
}

function fixtureOffpeakConfig(end) {
  return {
    ...defaultConfig({ displayTimeZone: "UTC" }),
    policies: [
      {
        id: "fixture-peak",
        providers: ["fixture"],
        models: ["fixture-*"],
        timeZone: "UTC",
        blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end }],
        source: "fixture",
        verifiedAt: "2026-01-01",
      },
    ],
  };
}

function fixtureOpencodeConfig(baseURL) {
  return {
    $schema: "https://opencode.ai/config.json",
    plugins: [root],
    providers: {
      fixture: {
        name: "Fixture",
        package: "@opencode/ai/providers/openai-compatible",
        settings: { baseURL },
        models: { "fixture-model": { name: "Fixture Model" } },
      },
    },
  };
}

async function fixtureTemp() {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-integration-"));
  const configDir = path.join(temp, "config");
  const projectDir = path.join(temp, "project");
  for (const dir of [configDir, projectDir]) await mkdir(dir, { recursive: true });
  return { temp, configDir, projectDir };
}

async function startServer(rootDir, projectDir) {
  const child = spawn("opencode", ["serve", "--port", "0", "--print-logs"], {
    cwd: projectDir,
    env: {
      ...process.env,
      OPENCODE_CONFIG_DIR: path.join(rootDir, "config"),
      XDG_CONFIG_HOME: path.join(rootDir, "xdg"),
      XDG_DATA_HOME: path.join(rootDir, "data"),
      XDG_CACHE_HOME: path.join(rootDir, "cache"),
      XDG_STATE_HOME: path.join(rootDir, "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_OFFPEAK_CONFIG: path.join(rootDir, "config", "offpeak.json"),
      OPENCODE_SERVER_PASSWORD: password,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => {
    output += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    output += chunk.toString();
  });
  const baseUrl = await waitFor(
    () => {
      const match = output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/);
      return match?.[1];
    },
    "the isolated OpenCode server did not start",
    60000,
  );
  return {
    child,
    baseUrl,
    async stop() {
      if (child.exitCode !== null) return;
      child.kill("SIGTERM");
      await new Promise((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 10000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
  };
}

async function waitForPlugin(baseUrl) {
  return waitFor(
    async () => {
      const response = await fetch(`${baseUrl}/api/plugin`, {
        headers: { authorization: auth },
      });
      if (!response.ok) return undefined;
      const body = await response.json();
      const plugin = body.data?.find((entry) => entry.id === "opencode-offpeak");
      return plugin?.state?.status === "active" ? plugin : undefined;
    },
    "opencode-offpeak did not become active in the isolated server",
    60000,
  );
}

test(`real OpenCode ${hostVersion} fixture: CLI and Desktop defaults are independent at peak and both requests match`, {
  skip,
  timeout: 240000,
}, async () => {
  const end = await peakWindow();
  if (!end) {
    // A window crossing midnight would not be a short peak window. The test is
    // deterministic for every other minute of the day.
    assert.ok(true, "skipped at the UTC midnight boundary");
    return;
  }
  const { temp, configDir, projectDir } = await fixtureTemp();
  const fixture = createFixtureProvider();
  let server;
  try {
    const baseURL = await fixture.start();
    await writeFile(
      path.join(configDir, "offpeak.json"),
      JSON.stringify(fixtureOffpeakConfig(end)),
    );
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify(fixtureOpencodeConfig(baseURL)),
    );

    server = await startServer(temp, projectDir);
    await waitForPlugin(server.baseUrl);
    const client = OpenCode.make({
      baseUrl: server.baseUrl,
      headers: { authorization: auth },
    });
    const rpc = () => client.rpc(OFFPEAK_RPC);
    const model = { providerID: "fixture", id: "fixture-model" };

    const cliSession = await client.session.create({
      title: "CLI protected",
      location: { directory: projectDir },
      model,
    });
    const desktopSession = await client.session.create({
      title: "Desktop authorized",
      location: { directory: projectDir },
      model,
    });
    // Registration precedes the first prompt for both clients. This is the
    // supported client lifecycle point: the client knows its session before it
    // submits a prompt, and the server records ownership.
    await rpc().control({
      action: "client-register",
      client: "cli",
      sessionID: cliSession.id,
    });
    await rpc().control({
      action: "client-register",
      client: "desktop",
      sessionID: desktopSession.id,
    });
    await rpc().control({ action: "client-set", client: "desktop", protection: "off" });

    const statusModel = { providerID: model.providerID, modelID: model.id };
    const defaults = (await rpc().control({ action: "client" })).client.defaults;
    assert.deepEqual(defaults, { cli: "ON", desktop: "OFF" });
    const cliStatus = (
      await rpc().control({ action: "status", ...statusModel, sessionID: cliSession.id })
    ).status;
    assert.equal(cliStatus.client.ownership, "cli");
    assert.equal(cliStatus.effectiveProtection, "ON");
    assert.equal(cliStatus.pricingState, "PEAK");
    assert.equal(cliStatus.requestsAllowed, false);
    const desktopStatus = (
      await rpc().control({ action: "status", ...statusModel, sessionID: desktopSession.id })
    ).status;
    assert.equal(desktopStatus.client.ownership, "desktop");
    assert.equal(desktopStatus.effectiveProtection, "OFF");
    assert.equal(desktopStatus.requestsAllowed, true);

    // The protected CLI prompt must produce zero provider traffic.
    await client.session.prompt({ sessionID: cliSession.id, text: "cli-protected-request" });
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(fixture.requests.length, 0, "protected CLI traffic reached the provider at peak");

    // The authorized Desktop prompt produces exactly one peak-priced request.
    await client.session.prompt({
      sessionID: desktopSession.id,
      text: "desktop-authorized-request",
    });
    await waitFor(
      () => fixture.requests.length === 1,
      "the authorized Desktop request was not sent at peak",
      15000,
    );
    assert.match(fixture.requests[0].text, /desktop-authorized-request/);
    assert.doesNotMatch(fixture.requests[0].text, /cli-protected-request/);

    // At the permitted boundary the held CLI request is released exactly once,
    // without a re-send of the Desktop request.
    await waitFor(
      () => fixture.requests.length === 2,
      "the protected CLI request was not released at the boundary",
      90000,
    );
    assert.match(
      fixture.requests[1].text,
      /cli-protected-request/,
      `provider requests: ${JSON.stringify(fixture.requests.map((request) => request.text.slice(0, 80)))}`,
    );
    assert.equal(
      fixture.requests.filter((request) => /desktop-authorized-request/.test(request.text)).length,
      1,
    );
    assert.equal(
      fixture.requests.filter((request) => /cli-protected-request/.test(request.text)).length,
      1,
    );

    // Cross-effect check and persistence across a real server restart.
    await rpc().control({ action: "client-set", client: "cli", protection: "off" });
    await rpc().control({ action: "client-set", client: "desktop", protection: "on" });
    const changed = (await rpc().control({ action: "client" })).client.defaults;
    assert.deepEqual(changed, { cli: "OFF", desktop: "ON" });

    await server.stop();
    server = await startServer(temp, projectDir);
    await waitForPlugin(server.baseUrl);
    const restarted = OpenCode.make({
      baseUrl: server.baseUrl,
      headers: { authorization: auth },
    });
    const restartedDefaults = (await restarted.rpc(OFFPEAK_RPC).control({ action: "client" }))
      .client.defaults;
    assert.deepEqual(restartedDefaults, { cli: "OFF", desktop: "ON" });
    const restartedCli = (
      await restarted.rpc(OFFPEAK_RPC).control({
        action: "client",
        sessionID: cliSession.id,
      })
    ).client;
    assert.equal(restartedCli.session.ownership, "cli");
    const restartedDesktop = (
      await restarted.rpc(OFFPEAK_RPC).control({
        action: "client",
        sessionID: desktopSession.id,
      })
    ).client;
    assert.equal(restartedDesktop.session.ownership, "desktop");

    // The supported deletion event cleans ownership, not just process memory.
    await restarted.session.remove({ sessionID: cliSession.id });
    await restarted.session.remove({ sessionID: desktopSession.id });
    await waitFor(
      async () => {
        const after = (
          await restarted.rpc(OFFPEAK_RPC).control({
            action: "client",
            sessionID: cliSession.id,
          })
        ).client;
        return after.session.ownership === "unknown";
      },
      "session deletion did not clean client ownership",
      15000,
    );
    const pluginLog = await readFile(
      path.join(temp, "data", "opencode", "log", "opencode.log"),
      "utf8",
    ).catch(() => "");
    assert.doesNotMatch(pluginLog, /failed to load plugin/);
  } finally {
    await server?.stop();
    await fixture.stop();
    if (process.env.OFFPEAK_KEEP_TEMP !== "1") await rm(temp, { recursive: true, force: true });
  }
});

test(`real OpenCode ${hostVersion} fixture: a peak compaction request is held and admitted once at the boundary`, {
  skip,
  timeout: 240000,
}, async () => {
  const end = await peakWindow();
  if (!end) {
    assert.ok(true, "skipped at the UTC midnight boundary");
    return;
  }
  const { temp, configDir, projectDir } = await fixtureTemp();
  const fixture = createFixtureProvider();
  let server;
  try {
    const baseURL = await fixture.start();
    await writeFile(
      path.join(configDir, "offpeak.json"),
      JSON.stringify(fixtureOffpeakConfig(end)),
    );
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify(fixtureOpencodeConfig(baseURL)),
    );

    server = await startServer(temp, projectDir);
    await waitForPlugin(server.baseUrl);
    const client = OpenCode.make({
      baseUrl: server.baseUrl,
      headers: { authorization: auth },
    });
    const rpc = () => client.rpc(OFFPEAK_RPC);
    const model = { providerID: "fixture", id: "fixture-model" };
    const session = await client.session.create({
      title: "Peak compaction",
      location: { directory: projectDir },
      model,
    });
    await rpc().control({ action: "client-register", client: "cli", sessionID: session.id });

    // One authorized peak prompt gives the session something to summarize.
    await rpc().control({ action: "session-off", sessionID: session.id });
    await client.session.prompt({ sessionID: session.id, text: "compaction-source-request" });
    await waitFor(
      () => fixture.requests.filter((request) => !request.compaction).length === 1,
      "the authorized source prompt was not sent",
      15000,
    );
    await rpc().control({ action: "session-on", sessionID: session.id });

    const status = (
      await rpc().control({
        action: "status",
        providerID: model.providerID,
        modelID: model.id,
        sessionID: session.id,
      })
    ).status;
    assert.equal(status.pricingState, "PEAK");
    assert.equal(status.requestsAllowed, false);
    assert.equal(status.effectiveProtection, "ON");

    // OpenCode 2.3.1 reworked compaction and enabled background summaries by
    // default. Both paths prepare a request through the same `compaction`
    // model hook, so a compact request at peak must stay off the wire.
    await client.session.compact({ sessionID: session.id });
    await new Promise((resolve) => setTimeout(resolve, 2000));
    assert.equal(
      fixture.requests.filter((request) => request.compaction).length,
      0,
      "a compaction summary reached the provider at peak",
    );

    await waitFor(
      () => fixture.requests.filter((request) => request.compaction).length === 1,
      "the held compaction was not admitted at the boundary",
      90000,
    );
    assert.equal(
      fixture.requests.filter((request) => request.compaction).length,
      1,
      "the admitted compaction was sent more than once",
    );
    const pluginLog = await readFile(
      path.join(temp, "data", "opencode", "log", "opencode.log"),
      "utf8",
    ).catch(() => "");
    assert.doesNotMatch(pluginLog, /failed to load plugin/);
  } finally {
    await server?.stop();
    await fixture.stop();
    if (process.env.OFFPEAK_KEEP_TEMP !== "1") await rm(temp, { recursive: true, force: true });
  }
});
