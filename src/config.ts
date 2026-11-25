import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import {
  BUILTIN_POLICIES,
  type PricingPolicy,
  validatePolicy,
  validateTimeZone,
} from "./policy.js";

/**
 * Pricing configuration only. Peak-price protection itself is controlled per
 * chat and per client; there is no installation-wide enable switch and no
 * queue/guard execution mode.
 */
export interface OffpeakConfig {
  schemaVersion: 1;
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
  const displayTimeZone = options.displayTimeZone ?? defaultDisplayTimeZone();
  if (typeof displayTimeZone !== "string") {
    throw new Error("Plugin option 'displayTimeZone' must be a time zone string.");
  }
  const extra = options.policies ?? [];
  if (!Array.isArray(extra)) throw new Error("Plugin option 'policies' must be an array.");
  return {
    schemaVersion: 1,
    displayTimeZone,
    policies: [...structuredClone(BUILTIN_POLICIES), ...(extra as PricingPolicy[])],
  };
}

export function validateConfig(value: unknown, fallback: OffpeakConfig): OffpeakConfig {
  if (!isRecord(value)) throw new Error("Configuration must be a JSON object.");
  if (value.schemaVersion !== 1)
    throw new Error("Unsupported offpeak configuration schemaVersion.");
  // `enabled` and `mode` were removed in v0.5.0. They are accepted and ignored
  // so an existing offpeak.json keeps working without an edit; the next write
  // (if any) drops them.
  const displayTimeZone = value.displayTimeZone ?? fallback.displayTimeZone;
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
    displayTimeZone,
    policies: structuredClone(adoptBuiltinDefaults(configuredPolicies, fallback.policies)),
  };
}

/**
 * A stored policies array that is an unmodified copy of a built-in policy
 * adopts the built-in vendor data (the yearly full-day OFF_PEAK holiday
 * calendars, and the documented flat all-hours model list) without touching
 * any customized schedule. A policy that differs in provider, model, time
 * zone, multiplier, or weekly windows is preserved exactly as stored, and an
 * explicit holiday list or flat model list always wins.
 *
 * When every stored policy is an unmodified copy of a built-in policy — that
 * is, the stored file is only a cached copy of the shipped defaults — newly
 * shipped built-in policies are appended too, so an existing installation
 * gains a policy for a newly supported provider without editing the file. As
 * soon as anything is customized, the stored set is authoritative and nothing
 * is added or removed.
 */
function adoptBuiltinDefaults(stored: PricingPolicy[], builtin: PricingPolicy[]): PricingPolicy[] {
  const adopted = stored.map((policy) => {
    const reference = builtin.find((candidate) => candidate.id === policy.id);
    if (!reference) return policy;
    if (!sameWeeklySchedule(policy, reference)) return policy;
    return {
      ...policy,
      ...(policy.holidays === undefined && reference.holidays?.length
        ? { holidays: structuredClone(reference.holidays) }
        : {}),
      ...(policy.flatModels === undefined && reference.flatModels?.length
        ? { flatModels: structuredClone(reference.flatModels) }
        : {}),
    };
  });
  const allBuiltinCopies = stored.every((policy) => {
    const reference = builtin.find((candidate) => candidate.id === policy.id);
    return reference !== undefined && sameWeeklySchedule(policy, reference);
  });
  if (!allBuiltinCopies) return adopted;
  for (const reference of builtin) {
    if (!adopted.some((policy) => policy.id === reference.id)) {
      adopted.push(structuredClone(reference));
    }
  }
  return adopted;
}

function sameWeeklySchedule(left: PricingPolicy, right: PricingPolicy): boolean {
  const normalize = (policy: PricingPolicy) => ({
    providers: [...policy.providers].sort(),
    models: [...policy.models].sort(),
    timeZone: policy.timeZone,
    multiplier: policy.multiplier,
    blocked: policy.blocked
      .map((window) => ({ ...window, days: [...window.days].sort() }))
      .sort((leftWindow, rightWindow) =>
        `${leftWindow.start}-${leftWindow.end}`.localeCompare(
          `${rightWindow.start}-${rightWindow.end}`,
        ),
      ),
  });
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
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
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
