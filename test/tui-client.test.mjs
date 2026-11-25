import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { defaultConfig } from "../dist/index.js";
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
const skip =
  (await hasBinary("opencode")) && (await hasBinary("tmux"))
    ? false
    : "requires the OpenCode v2 CLI (opencode) and tmux on PATH";
const password = `tui-${process.pid}-${Math.random().toString(16).slice(2)}`;
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
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  assert.fail(`${message} (last: ${last})`);
}

test("real CLI TUI registers its session, shows the CLI default, and releases only after CLI is switched off", {
  skip,
  timeout: 240000,
}, async () => {
  const temp = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-tui-client-"));
  const configDir = path.join(temp, "config");
  const projectDir = path.join(temp, "project");
  const socket = `offpeak-tui-client-${process.pid}`;
  for (const dir of [configDir, projectDir]) await mkdir(dir, { recursive: true });
  const fixture = createFixtureProvider();
  let server;
  let tmuxStarted = false;
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
          blocked: [{ days: [0, 1, 2, 3, 4, 5, 6], start: "00:00", end: "23:59" }],
          source: "fixture",
          verifiedAt: "2026-01-01",
        },
      ],
    };
    await writeFile(path.join(configDir, "offpeak.json"), JSON.stringify(offpeak));
    const opencodeConfig = {
      $schema: "https://opencode.ai/config.json",
      model: "fixture/fixture-model",
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
    await writeFile(path.join(configDir, "opencode.json"), JSON.stringify(opencodeConfig));
    await writeFile(path.join(configDir, "cli.json"), JSON.stringify({ plugins: [root] }));
    const env = {
      ...process.env,
      OPENCODE_CONFIG_DIR: configDir,
      XDG_CONFIG_HOME: path.join(temp, "xdg"),
      XDG_DATA_HOME: path.join(temp, "data"),
      XDG_CACHE_HOME: path.join(temp, "cache"),
      XDG_STATE_HOME: path.join(temp, "state"),
      OPENCODE_DISABLE_AUTOUPDATE: "true",
      OPENCODE_OFFPEAK_CONFIG: path.join(configDir, "offpeak.json"),
      OPENCODE_SERVER_PASSWORD: password,
    };

    const child = spawn("opencode", ["serve", "--port", "0", "--print-logs"], {
      cwd: projectDir,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      output += chunk.toString();
    });
    server = {
      child,
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
    const serverURL = await waitFor(
      () => output.match(/server listening on (http:\/\/127\.0\.0\.1:\d+)/)?.[1],
      "the isolated OpenCode server did not start",
    );
    await waitFor(async () => {
      const response = await fetch(`${serverURL}/api/plugin`, {
        headers: { authorization: auth },
      });
      if (!response.ok) return undefined;
      const body = await response.json();
      const plugin = body.data?.find((entry) => entry.id === "opencode-offpeak");
      return plugin?.state?.status === "active" ? plugin : undefined;
    }, "opencode-offpeak did not become active in the isolated server");
    await exec("tmux", [
      "-L",
      socket,
      "new-session",
      "-d",
      "-s",
      "tui",
      "-x",
      "140",
      "-y",
      "42",
      "-c",
      projectDir,
    ]);
    tmuxStarted = true;
    const envPrefix = Object.entries(env)
      .filter(([key]) => key.startsWith("OPENCODE_") || key.startsWith("XDG_"))
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(" ");
    await exec("tmux", [
      "-L",
      socket,
      "send-keys",
      "-t",
      "tui",
      "-l",
      `${envPrefix} opencode --server ${serverURL}`,
    ]);
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "Enter"]);
    const pane = async () => {
      const captured = await exec("tmux", ["-L", socket, "capture-pane", "-t", "tui", "-p"]);
      return captured.stdout;
    };
    await waitFor(async () => {
      const screen = await pane();
      return screen.includes("Ask anything") || screen.includes("CLI registration smoke");
    }, "the TUI did not finish starting against the isolated server");

    // Send the first prompt at verified peak. CLI protection is ON, so no
    // provider request is allowed until its session's client is switched off.
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "-l", "tui-cli-protected"]);
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "Enter"]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.equal(fixture.requests.length, 0, "the TUI request reached the provider at peak");

    // The TUI extension registered this session before the prompt; the status
    // command reports CLI ownership and the client defaults.
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "-l", "/offpeak status"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "Enter"]);
    await waitFor(
      async () => (await pane()).includes("CLI protection: ON"),
      "the TUI client status did not render",
    );
    assert.match(await pane(), /This chat: follows the CLI global \(ON\)/);
    assert.match(await pane(), /Desktop protection: ON/);

    // Turning Desktop off must not release a CLI-owned request.
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "-l", "/offpeak desktop off"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "Enter"]);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(fixture.requests.length, 0, "Desktop's setting changed the CLI session");

    // Switching the CLI default off releases the same held request exactly once.
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "-l", "/offpeak cli off"]);
    await new Promise((resolve) => setTimeout(resolve, 500));
    await exec("tmux", ["-L", socket, "send-keys", "-t", "tui", "Enter"]);
    await waitFor(
      () => fixture.requests.some((request) => /tui-cli-protected/.test(request.text)),
      "the CLI request was not released after switching CLI protection off",
      15000,
    );
    // A new untitled session also releases its automatic title request, so at
    // most two held requests are admitted: one title and one primary. Every
    // one carries this prompt, and none is re-sent on later wake-ups.
    assert.ok(fixture.requests.length <= 2, JSON.stringify(fixture.requests));
    assert.ok(
      fixture.requests.every((request) => /tui-cli-protected/.test(request.text)),
      JSON.stringify(fixture.requests),
    );
    await new Promise((resolve) => setTimeout(resolve, 1500));
    assert.ok(fixture.requests.length <= 2, "a released request was duplicated");
    const log = await readFile(
      path.join(temp, "data", "opencode", "log", "opencode.log"),
      "utf8",
    ).catch(() => "");
    assert.doesNotMatch(log, /failed to load plugin/);
    assert.doesNotMatch(log, /plugin operation failed/);
  } finally {
    if (tmuxStarted) {
      await exec("tmux", ["-L", socket, "kill-server"]).catch(() => undefined);
    }
    await server?.stop();
    await fixture.stop();
    await rm(temp, { recursive: true, force: true });
  }
});
