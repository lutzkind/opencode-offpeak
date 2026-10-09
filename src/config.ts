import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  DEEPSEEK_OPENCODE_GO,
  type PricingPolicy,
  validatePolicy,
  validateTimeZone,
} from "./policy.js";

export type RunMode = "auto" | "queue" | "guard";

export interface OffpeakConfig {
  schemaVersion: 1;
  enabled: boolean;
  mode: RunMode;
  displayTimeZone: string;
  policies: PricingPolicy[];
}

export interface ConfigRead {
  config?: OffpeakConfig;
  error?: string;
  path: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultDisplayTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

export function defaultConfig(options: Record<string, unknown> = {}): OffpeakConfig {
  const mode = options.mode ?? "auto";
  if (mode !== "auto" && mode !== "queue" && mode !== "guard") {
    throw new Error("Plugin option 'mode' must be auto, queue, or guard.");
  }
  const enabled = options.enabled ?? true;
  if (typeof enabled !== "boolean") throw new Error("Plugin option 'enabled' must be boolean.");
  const displayTimeZone = options.displayTimeZone ?? defaultDisplayTimeZone();
  if (typeof displayTimeZone !== "string") {
    throw new Error("Plugin option 'displayTimeZone' must be a time zone string.");
  }
  const extra = options.policies ?? [];
  if (!Array.isArray(extra)) throw new Error("Plugin option 'policies' must be an array.");
  return {
    schemaVersion: 1,
    enabled,
    mode,
    displayTimeZone,
    policies: [DEEPSEEK_OPENCODE_GO, ...(extra as PricingPolicy[])],
  };
}

export function validateConfig(value: unknown, fallback: OffpeakConfig): OffpeakConfig {
  if (!isRecord(value)) throw new Error("Configuration must be a JSON object.");
  if (value.schemaVersion !== 1)
    throw new Error("Unsupported offpeak configuration schemaVersion.");
  if (typeof value.enabled !== "boolean")
    throw new Error("Configuration field 'enabled' must be boolean.");
  if (value.mode !== "auto" && value.mode !== "queue" && value.mode !== "guard") {
    throw new Error("Configuration field 'mode' must be auto, queue, or guard.");
  }
  const displayTimeZone = value.displayTimeZone;
  if (typeof displayTimeZone !== "string") {
    throw new Error("Configuration field 'displayTimeZone' must be a time zone string.");
  }
  validateTimeZone(displayTimeZone);
  if (value.policies !== undefined && !Array.isArray(value.policies)) {
    throw new Error("Configuration field 'policies' must be an array.");
  }
  const configuredPolicies = (value.policies ?? fallback.policies) as PricingPolicy[];
  if (!configuredPolicies.length)
    throw new Error("At least one pricing policy must be configured.");
  for (const policy of configuredPolicies) {
    if (!isRecord(policy)) throw new Error("Each pricing policy must be a JSON object.");
    validatePolicy(policy as unknown as PricingPolicy);
  }
  const ids = configuredPolicies.map((policy) => policy.id);
  if (new Set(ids).size !== ids.length) throw new Error("Pricing policy IDs must be unique.");
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    mode: value.mode,
    displayTimeZone,
    policies: structuredClone(configuredPolicies),
  };
}

export class ConfigRepository {
  readonly path: string;
  readonly #fallback: OffpeakConfig;
  readonly #optionsError: string | undefined;

  constructor(options: Record<string, unknown> = {}, env: NodeJS.ProcessEnv = process.env) {
    const configDirectory =
      env.OPENCODE_CONFIG_DIR ??
      path.join(env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
    const configuredPath = typeof options.configPath === "string" ? options.configPath : undefined;
    const envPath = env.OPENCODE_OFFPEAK_CONFIG;
    this.path = path.resolve(
      configuredPath ?? envPath ?? path.join(configDirectory, "offpeak.json"),
    );
    try {
      this.#fallback = defaultConfig(options);
      validateConfig(this.#fallback, this.#fallback);
      this.#optionsError = undefined;
    } catch (error) {
      this.#fallback = defaultConfig();
      this.#optionsError = error instanceof Error ? error.message : "Invalid plugin options.";
    }
  }

  async read(): Promise<ConfigRead> {
    try {
      const contents = await readFile(this.path, "utf8");
      return {
        config: validateConfig(JSON.parse(contents) as unknown, this.#fallback),
        path: this.path,
      };
    } catch (error) {
      if (isNodeError(error) && error.code === "ENOENT") {
        if (this.#optionsError) return { error: this.#optionsError, path: this.path };
        try {
          return { config: validateConfig(this.#fallback, this.#fallback), path: this.path };
        } catch (fallbackError) {
          return {
            error:
              fallbackError instanceof Error ? fallbackError.message : "Invalid plugin options.",
            path: this.path,
          };
        }
      }
      return {
        error: error instanceof Error ? error.message : "Could not load offpeak configuration.",
        path: this.path,
      };
    }
  }

  async write(config: OffpeakConfig): Promise<void> {
    const validated = validateConfig(config, this.#fallback);
    await mkdir(path.dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${crypto.randomUUID()}.tmp`;
    await writeFile(temporary, `${JSON.stringify(validated, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    try {
      await rename(temporary, this.path);
    } catch (error) {
      await import("node:fs/promises")
        .then(({ unlink }) => unlink(temporary))
        .catch(() => undefined);
      throw error;
    }
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
