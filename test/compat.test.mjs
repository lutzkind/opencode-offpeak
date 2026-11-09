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

test("supported OpenCode versions match the tested 2.0.26–2.2.x range", () => {
  assert.equal(SUPPORTED_OPENCODE_RANGE, ">=2.0.26 <2.3.0");
  for (const version of [
    "2.0.26",
    "2.0.27",
    "v2.0.26",
    "2.0.26-beta.1",
    "2.0.30+build.5",
    "2.1.0",
    "2.1.3",
    "2.1.4",
    "v2.1.3",
    "2.2.0",
    "2.2.1",
    "2.2.2",
    "2.2.3",
    "2.2.4",
    "2.2.5",
    "2.2.6",
    "v2.2.5",
    "v2.2.6",
  ]) {
    assert.equal(isSupportedOpenCodeVersion(version), true, version);
  }
  for (const version of [
    "2.0.25",
    "2.0.18",
    "1.18.35",
    "2.3.0",
    "2.3.1",
    "3.0.0",
    "not-a-version",
    "",
  ]) {
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
  assert.doesNotThrow(() => assertSupportedOpenCode({ version: "2.1.4" }, "server"));
  assert.doesNotThrow(() => assertSupportedOpenCode({ version: "2.2.6" }, "TUI"));
  assert.throws(
    () => assertSupportedOpenCode({ version: "2.0.25" }, "TUI"),
    /opencode-offpeak requires OpenCode >=2\.0\.26 <2\.3\.0; this TUI host runs 2\.0\.25\. Use an OpenCode release inside that range, or update opencode-offpeak before using a newer host, then restart OpenCode\./,
  );
  assert.throws(
    () => assertSupportedOpenCode({ version: "2.3.0" }, "server"),
    /this server host runs 2\.3\.0/,
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

test("the compatibility error never recommends upgrading a too-new host", () => {
  for (const [version, surface] of [
    ["2.0.25", "TUI"],
    ["2.3.0", "server"],
  ]) {
    assert.throws(
      () => assertSupportedOpenCode({ version }, surface),
      (error) => {
        assert.doesNotMatch(error.message, /opencode upgrade/);
        assert.match(error.message, /Use an OpenCode release inside that range/);
        return true;
      },
    );
  }
});
