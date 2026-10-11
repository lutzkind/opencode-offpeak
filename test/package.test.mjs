import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

test("package root, TUI subpath, and Node build exports match the v2 plugin layout", async () => {
  assert.equal(manifest.main, "./src/server.ts");
  assert.equal(manifest.exports["."].bun, "./src/server.ts");
  assert.equal(manifest.exports["."].import, "./dist/server.js");
  assert.equal(manifest.exports["./tui"].bun, "./tui.ts");
  assert.equal(manifest.exports["./tui"].import, "./dist/tui.js");
  assert.ok(manifest.files.includes("index.ts"));
  assert.ok(manifest.files.includes("tui.ts"));
  assert.equal(manifest.dependencies["@opencode/plugin"], "2.0.26");
  assert.match(await readFile(path.join(root, "index.ts"), "utf8"), /src\/server\.ts/);
  assert.match(await readFile(path.join(root, "tui.ts"), "utf8"), /src\/tui\.ts/);

  const server = await import("../dist/server.js");
  const tui = await import("../dist/tui.js");
  assert.equal(server.default.id, "opencode-offpeak");
  assert.equal(tui.default.id, "opencode-offpeak");
});

test("the package name resolves both v2 entrypoints through its own exports", () => {
  assert.match(import.meta.resolve("opencode-offpeak"), /dist\/server\.js$/);
  assert.match(import.meta.resolve("opencode-offpeak/tui"), /dist\/tui\.js$/);
});

test("both entrypoints expose the documented Plugin.define shape", async () => {
  const server = (await import("../dist/server.js")).default;
  const tui = (await import("../dist/tui.js")).default;
  for (const [surface, plugin] of [
    ["server", server],
    ["tui", tui],
  ]) {
    assert.equal(typeof plugin, "object", surface);
    assert.equal(plugin.id, "opencode-offpeak", surface);
    assert.equal(typeof plugin.setup, "function", surface);
  }
  const tuiSource = await readFile(path.join(root, "src/tui.ts"), "utf8");
  assert.match(tuiSource, /import \{ Plugin \} from "@opencode\/plugin\/tui"/);
  assert.match(tuiSource, /Plugin\.define\(/);
  const serverSource = await readFile(path.join(root, "src/server.ts"), "utf8");
  assert.match(serverSource, /import \{ Plugin \} from "@opencode\/plugin"/);
  assert.match(serverSource, /Plugin\.define\(/);
});

test("server and TUI builds stay separate", async () => {
  const tuiSource = await readFile(path.join(root, "dist/tui.js"), "utf8");
  assert.doesNotMatch(tuiSource, /from "\.\/server\.js"/);
  assert.doesNotMatch(tuiSource, /from "\.\/engine\.js"/);
  assert.doesNotMatch(tuiSource, /from "\.\/store\.js"/);
  const serverSource = await readFile(path.join(root, "dist/server.js"), "utf8");
  assert.doesNotMatch(serverSource, /from "\.\/tui\.js"/);
});

test("no stale tui.json or cli.json plugin workaround ships with the package", async () => {
  assert.ok(!manifest.files.includes("tui.json"));
  assert.ok(!manifest.files.includes("cli.json"));
  for (const file of ["tui.json", "cli.json"]) {
    await assert.rejects(access(path.join(root, file)), undefined, file);
  }
});
