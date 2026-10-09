import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));

test("package root, TUI subpath, and Node build exports match the v2 plugin layout", async () => {
  assert.equal(manifest.main, "./src/server.ts");
  assert.equal(manifest.exports["."].bun, "./src/server.ts");
  assert.equal(manifest.exports["."].import, "./dist/server.js");
  assert.equal(manifest.exports["./tui"].bun, "./src/tui.ts");
  assert.equal(manifest.exports["./tui"].import, "./dist/tui.js");
  assert.equal(manifest.dependencies["@opencode/plugin"], "2.0.26");

  const server = await import("../dist/server.js");
  const tui = await import("../dist/tui.js");
  assert.equal(server.default.id, "opencode-offpeak");
  assert.equal(tui.default.id, "opencode-offpeak");
});
