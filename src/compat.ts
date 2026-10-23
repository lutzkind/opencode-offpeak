/**
 * OpenCode host compatibility.
 *
 * The plugin is tested against the OpenCode v2 plugin API shipped with
 * OpenCode 2.0.26 through 2.1.3. Hosts before 2.0.26 activate TUI plugins
 * outside the Solid keymap provider owner, so `context.keymap.layer()` fails
 * with "Keymap.Provider is missing" even though the plugin follows the
 * documented API. OpenCode 2.1 changes the session/compaction payload schema
 * (`providerState` → `native`) but not the plugin hooks this plugin uses
 * (`model.request`, `http.request`, `retry`, session events, RPC); it is
 * covered by the compatibility and coexistence suites. Unsupported hosts must
 * fail with this explicit compatibility error instead of the confusing runtime
 * failure.
 */
export const SUPPORTED_OPENCODE_RANGE = ">=2.0.26 <2.2.0";

const VERSION_PATTERN = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?$/;

/** True when the running OpenCode version is inside the tested support range. */
export function isSupportedOpenCodeVersion(version: string): boolean {
  const match = VERSION_PATTERN.exec(version.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major !== 2) return false;
  if (minor === 0) return patch >= 26;
  return minor === 1;
}

/**
 * Throws a clear compatibility error when the host is outside the tested
 * range or does not report a usable version. Both plugin entrypoints call
 * this before touching any host API that older releases implement
 * incorrectly.
 */
export function assertSupportedOpenCode(
  app: { readonly version?: unknown } | undefined,
  surface: string,
): void {
  const version = typeof app?.version === "string" ? app.version : undefined;
  if (version && isSupportedOpenCodeVersion(version)) return;
  throw new Error(
    `opencode-offpeak requires OpenCode ${SUPPORTED_OPENCODE_RANGE}; this ${surface} host runs ${version ?? "an unknown version"}. Run \`opencode upgrade\` and restart OpenCode before using this plugin.`,
  );
}
