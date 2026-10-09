import type { Rpc } from "@opencode/plugin";

const object = {
  type: "object",
  additionalProperties: true,
} as const;

export const OFFPEAK_RPC = {
  id: "opencode-offpeak",
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
  },
  events: {},
} as const satisfies Rpc.PortableDefinition;

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
}
