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

test("real OpenCode 2.3.0 fixture: CLI and Desktop defaults are independent at peak and both requests match", {
  skip,
  timeout: 240000,
}, async () => {
  const end = nextMinuteWindow();
  if (!end) {
    // A window crossing midnight would not be a short peak window. The test is
    // deterministic for every other minute of the day.
    assert.ok(true, "skipped at the UTC midnight boundary");
    return;
  }
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-integration-"));
  const configDir = path.join(temp, "config");
  const projectDir = path.join(temp, "project");
  for (const dir of [configDir, projectDir]) await mkdir(dir, { recursive: true });
  const fixture = createFixtureProvider();
  let server;
  try {
    const baseURL = await fixture.start();
    const offpeak = {
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
    await writeFile(path.join(configDir, "offpeak.json"), JSON.stringify(offpeak));
    await writeFile(
      path.join(configDir, "opencode.json"),
      JSON.stringify({
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
      }),
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
    assert.match(fixture.requests[1].text, /cli-protected-request/);
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
    await rm(temp, { recursive: true, force: true });
  }
});
