import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

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

async function tmux(socket, args, options = {}) {
  return exec("tmux", ["-L", socket, ...args], options);
}

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
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  assert.fail(`${message} (last: ${last})`);
}

const opencodeBin = process.env.OPENCODE_OFFPEAK_OPENCODE_BIN ?? "opencode";
const available = (await hasBinary(opencodeBin)) && (await hasBinary("tmux"));
const skip = available ? false : `requires the OpenCode v2 CLI (${opencodeBin}) and tmux on PATH`;

test("the real OpenCode v2 TUI loads the packed plugin without keymap errors and runs /offpeak status", {
  skip,
  timeout: 240000,
}, async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-tui-smoke-"));
  const socket = `offpeak-smoke-${process.pid}`;
  const session = "smoke";
  const configDir = path.join(tmp, "config");
  const dataDir = path.join(tmp, "data");
  const cacheDir = path.join(tmp, "cache");
  const stateDir = path.join(tmp, "state");
  const xdgConfigDir = path.join(tmp, "xdg-config");
  const projectDir = path.join(tmp, "project");
  try {
    for (const dir of [configDir, dataDir, cacheDir, stateDir, xdgConfigDir, projectDir]) {
      await mkdir(dir, { recursive: true });
    }

    const packed = await exec("npm", ["pack", "--json", "--pack-destination", tmp], {
      cwd: root,
    });
    const packedJson = JSON.parse(packed.stdout);
    const entry = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
    const extract = path.join(tmp, "extract");
    await mkdir(extract, { recursive: true });
    await exec("tar", ["-xzf", path.join(tmp, entry.filename), "-C", extract]);
    const packageDir = path.join(extract, "package");

    await writeFile(
      path.join(configDir, "opencode.json"),
      `${JSON.stringify(
        { $schema: "https://opencode.ai/config.json", plugins: [packageDir] },
        null,
        2,
      )}\n`,
    );

    const env = [
      `XDG_CONFIG_HOME=${xdgConfigDir}`,
      `XDG_DATA_HOME=${dataDir}`,
      `XDG_CACHE_HOME=${cacheDir}`,
      `XDG_STATE_HOME=${stateDir}`,
      `OPENCODE_CONFIG_DIR=${configDir}`,
      "OPENCODE_DISABLE_AUTOUPDATE=true",
    ].join(" ");
    await tmux(socket, [
      "new-session",
      "-d",
      "-s",
      session,
      "-x",
      "140",
      "-y",
      "42",
      "-c",
      projectDir,
      `${env} ${opencodeBin} --standalone`,
    ]);

    const logPath = path.join(dataDir, "opencode", "log", "opencode.log");
    const log = async () => {
      try {
        return await readFile(logPath, "utf8");
      } catch {
        return "";
      }
    };
    const pane = async () => {
      const captured = await tmux(socket, ["capture-pane", "-t", session, "-p"]);
      return captured.stdout;
    };

    await waitFor(
      async () => (await log()).includes("plugin reconciliation completed"),
      "TUI plugin reconciliation did not complete",
    );
    await waitFor(
      async () => (await pane()).includes("Ask anything"),
      "the OpenCode TUI did not finish starting",
    );

    const loaded = await log();
    assert.ok(
      loaded.includes(`loading plugin`) && loaded.includes(packageDir),
      "the packed package did not load as a server plugin",
    );
    assert.doesNotMatch(loaded, /Keymap\.Provider is missing/);
    assert.doesNotMatch(loaded, /plugin operation failed/);

    await tmux(socket, ["send-keys", "-t", session, "-l", "/offpeak status"]);
    await new Promise((resolve) => setTimeout(resolve, 1500));
    await tmux(socket, ["send-keys", "-t", session, "Enter"]);
    await waitFor(
      async () => (await pane()).includes("Plugin: ENABLED"),
      "/offpeak status did not produce a status toast in the real TUI",
    );
    assert.doesNotMatch(await log(), /Keymap\.Provider is missing/);
  } finally {
    await tmux(socket, ["kill-session", "-t", session]).catch(() => undefined);
    await exec("tmux", ["-L", socket, "kill-server"]).catch(() => undefined);
    await rm(tmp, { recursive: true, force: true });
  }
});
