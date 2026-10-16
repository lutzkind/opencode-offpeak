import type { Rpc } from "@opencode/plugin";

const object = {
  type: "object",
  additionalProperties: true,
} as const;

export const OFFPEAK_RPC_ID = "opencode-offpeak" as const;

export const OFFPEAK_RPC = {
  id: OFFPEAK_RPC_ID,
  methods: {
    control: {
      input: {
        type: "object",
        properties: {
          action: { type: "string" },
          prompt: { type: "string" },
          id: { type: "string" },
          cwd: { type: "string" },
          providerID: { type: "string" },
          modelID: { type: "string" },
        },
        required: ["action"],
        additionalProperties: false,
      },
      output: object,
    },
    /**
     * Cancel a request this plugin is holding for the session, without
     * interrupting the session. Generic infrastructure for any caller that
     * decides a parked request is obsolete: the request is refused at the
     * transport boundary (never sent) and OpenCode's own retry machinery
     * decides what happens next.
     *
     * The result is authoritative: `cancelled: true` means the hold lost the
     * race and the request will be refused; `state: "committed"` means the
     * dispatch decision had already been taken and the caller must wait for the
     * next safe boundary instead.
     */
    cancelHold: {
      input: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          reason: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
      output: object,
    },
  },
  /**
   * Server-to-TUI notifications. They are published on OpenCode's event stream
   * as `rpc.opencode-offpeak.<name>` and rendered by the TUI entrypoint as
   * non-chat toasts; they never touch the session, the model context, or
   * headless output.
   */
  events: {
    hold: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          until: { type: "number" },
          timeZone: { type: "string" },
          display: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
    resume: {
      schema: {
        type: "object",
        properties: {
          sessionID: { type: "string" },
          kind: { type: "string" },
        },
        required: ["sessionID"],
        additionalProperties: false,
      },
    },
  },
} as const satisfies Rpc.PortableDefinition;

export type OffpeakEventName = keyof typeof OFFPEAK_RPC.events;

/** Full event-stream type string, for example `rpc.opencode-offpeak.hold`. */
export function offpeakEventType<Name extends OffpeakEventName>(
  name: Name,
): `rpc.${typeof OFFPEAK_RPC_ID}.${Name}` {
  return `rpc.${OFFPEAK_RPC_ID}.${name}`;
}

export interface OffpeakHoldEvent {
  sessionID: string;
  until?: number;
  timeZone?: string;
  display?: string;
}

export interface OffpeakResumeEvent {
  sessionID: string;
  kind?: "release" | "continuation";
}

export interface OffpeakRpcInput {
  action: string;
  prompt?: string;
  id?: string;
  cwd?: string;
  providerID?: string;
  modelID?: string;
}

export interface OffpeakRpcOutput {
  message?: string;
  status?: Record<string, unknown>;
  tasks?: unknown[];
  /** `cancelHold` result: whether the hold lost the race, and how it settled. */
  cancelled?: boolean;
  state?: string;
  model?: string;
}
