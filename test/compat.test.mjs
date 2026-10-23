import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import {
  assertSupportedOpenCode,
  isSupportedOpenCodeVersion,
  SUPPORTED_OPENCODE_RANGE,
} from "../dist/index.js";

const root = path.resolve(import.meta.dirname, "..");

test("supported OpenCode versions match the tested 2.0.26–2.1.x range", () => {
  assert.equal(SUPPORTED_OPENCODE_RANGE, ">=2.0.26 <2.2.0");
  for (const version of [
    "2.0.26",
    "2.0.27",
    "v2.0.26",
    "2.0.26-beta.1",
    "2.0.30+build.5",
    "2.1.0",
    "2.1.3",
    "v2.1.3",
  ]) {
    assert.equal(isSupportedOpenCodeVersion(version), true, version);
  }
  for (const version of ["2.0.25", "2.0.18", "1.18.35", "2.2.0", "3.0.0", "not-a-version", ""]) {
    assert.equal(isSupportedOpenCodeVersion(version), false, version);
  }
});

test("the package manifest declares the same tested OpenCode engine range", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  assert.equal(manifest.engines.opencode, SUPPORTED_OPENCODE_RANGE);
  assert.equal(manifest.engines.node, ">=22");
});

test("compatibility guard passes inside the range and fails clearly outside it", () => {
  assert.doesNotThrow(() => assertSupportedOpenCode({ version: "2.0.26" }, "TUI"));
  assert.throws(
    () => assertSupportedOpenCode({ version: "2.0.25" }, "TUI"),
    /opencode-offpeak requires OpenCode >=2\.0\.26 <2\.2\.0; this TUI host runs 2\.0\.25\. Run `opencode upgrade` and restart OpenCode before using this plugin\./,
  );
  assert.throws(
    () => assertSupportedOpenCode(undefined, "server"),
    /this server host runs an unknown version/,
  );
  assert.throws(
    () => assertSupportedOpenCode({ version: 26 }, "server"),
    /this server host runs an unknown version/,
  );
});
