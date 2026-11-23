import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const exec = promisify(execFile);
const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

test("a clean packed install loads both entrypoints and keeps the manifest contract", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-pack-"));
  try {
    const packed = await exec("npm", ["pack", "--json", "--pack-destination", tmp], {
      cwd: root,
    });
    const packedJson = JSON.parse(packed.stdout);
    const entry = Array.isArray(packedJson) ? packedJson[0] : Object.values(packedJson)[0];
    assert.equal(entry.name, "opencode-offpeak");
    assert.equal(entry.version, manifest.version);

    const tarball = path.join(tmp, entry.filename);
    const extract = path.join(tmp, "extract");
    await mkdir(extract, { recursive: true });
    await exec("tar", ["-xzf", tarball, "-C", extract]);

    const packageRoot = path.join(extract, "package");
    const installed = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
    assert.equal(installed.version, manifest.version);
    assert.equal(installed.engines.opencode, ">=2.0.26 <2.5.0");
    assert.equal(installed.engines.node, ">=22");
    assert.equal(installed.main, "./src/server.ts");
    assert.equal(installed.exports["./tui"].bun, "./tui.ts");
    assert.equal(installed.exports["./gui-experimental"], "./dist/gui-experimental.cjs");

    // Load the packed artifacts the way a consumer resolves them, with the
    // package's declared runtime dependency available.
    const consumer = path.join(tmp, "consumer", "node_modules");
    await mkdir(consumer, { recursive: true });
    await exec("cp", ["-R", packageRoot, path.join(consumer, "opencode-offpeak")]);
    await symlink(path.join(root, "node_modules", "@opencode"), path.join(consumer, "@opencode"));
    // Solid is a peer provided by the OpenCode TUI host; mirror that host here.
    await symlink(path.join(root, "node_modules", "solid-js"), path.join(consumer, "solid-js"));

    const server = await import(
      pathToFileURL(path.join(consumer, "opencode-offpeak", "dist", "server.js")).href
    );
    const tui = await import(
      pathToFileURL(path.join(consumer, "opencode-offpeak", "dist", "tui.js")).href
    );
    assert.equal(server.default.id, "opencode-offpeak");
    assert.equal(tui.default.id, "opencode-offpeak");
    assert.equal(typeof server.default.setup, "function");
    assert.equal(typeof tui.default.setup, "function");
    const guiBundle = await readFile(
      path.join(consumer, "opencode-offpeak", "dist", "gui-experimental.cjs"),
      "utf8",
    );
    assert.match(guiBundle, /@opencode\/plugin\/gui/);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
});
