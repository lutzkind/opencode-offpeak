import { Plugin } from "@opencode/plugin";
import { assertSupportedOpenCode } from "./compat.js";
import { ConfigRepository } from "./config.js";
import { OffpeakEngine, type SessionDriver } from "./engine.js";
import { OFFPEAK_RPC, type OffpeakRpcInput, type OffpeakRpcOutput } from "./rpc.js";
import { QueueRepository, RecoveryRepository } from "./store.js";

export default Plugin.define({
  id: "opencode-offpeak",
  setup: async (context) => {
    assertSupportedOpenCode(context.app, "server");
    const config = new ConfigRepository(context.options);
    const storage = {
      get: (key: string) => context.storage.get(key),
      set: (key: string, value: unknown) => context.storage.set(key, value as never),
    };
    const repository = new QueueRepository(storage);
    const recoveries = new RecoveryRepository(storage);
    const sessions: SessionDriver = {
      create: async ({ cwd, model, taskID }) => {
        const session = await context.session.create({
          title: `Offpeak ${taskID}`,
          location: { directory: cwd },
          model: { providerID: model.providerID, id: model.modelID },
          metadata: { "opencode-offpeak.taskID": taskID },
        });
        return session.id;
      },
      prompt: async (sessionID, text) => {
        await context.session.prompt({ sessionID, text });
      },
      wait: async (sessionID) => context.session.wait({ sessionID }),
      get: async (sessionID) => {
        const session = await context.session.get({ sessionID });
        return session.outcome ? { outcome: session.outcome } : {};
      },
      interrupt: async (sessionID) => {
        await context.session.interrupt({ sessionID });
      },
    };
    const engine = new OffpeakEngine({
      repository,
      recoveries,
      location: context.location?.directory ?? "",
      config,
      sessions,
      onError: (error) => console.error("[opencode-offpeak]", error),
    });
    const hooks = await Promise.all([
      // Pre-model pricing guard: runs before any provider attempt (and before
      // OpenCode's response-header timeout clock) exists, so a request that must
      // wait for OFF_PEAK holds no provider attempt open. Primary requests of
      // interactive sessions persist a deferral so a reload or restart can
      // deliver the same-session continuation.
      context.session.hook("model.request", (request) =>
        engine.guardModelRequest({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          kind: request.kind,
          transport: "model",
        }),
      ),
      context.session.hook("http.request", (request) =>
        engine.guardRequest({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          transport: "http",
        }),
      ),
      context.session.hook("experimental.ws.handshake", (request) =>
        engine.guardRequest({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          transport: "websocket",
        }),
      ),
      context.session.hook("experimental.ws.send", (request) =>
        engine.guardRequest({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          transport: "websocket",
        }),
      ),
      // Peak-aware retry recovery: a retryable provider failure while pricing is
      // blocked must not retry into the provider or fail the turn terminally.
      context.session.hook("retry", async (event) => {
        const outcome = await engine.noteRetryFailure({
          sessionID: event.sessionID,
          providerID: event.model.providerID,
          modelID: event.model.id,
          errorType: event.error?.type ?? "unknown",
          willRetry: event.decision?.retry === true,
        });
        if (outcome === "hold" && event.decision?.retry === true) {
          event.decision = { retry: false };
        }
      }),
    ]);
    // Holds fail closed the moment OpenCode interrupts the session (user cancel,
    // inactivity sweep, supersede). A deferred primary request keeps its
    // same-session continuation; a user cancel clears it. The subscription lives
    // with the plugin scope.
    const eventAbort = new AbortController();
    const events = (async () => {
      try {
        for await (const event of context.event.subscribe({ signal: eventAbort.signal })) {
          if (eventAbort.signal.aborted) break;
          if (event.type === "session.execution.interrupted") {
            await engine.noteExecutionInterrupted({
              sessionID: event.data.sessionID,
              reason: event.data.reason,
            });
          }
        }
      } catch (error) {
        if (!eventAbort.signal.aborted) console.error("[opencode-offpeak]", error);
      }
    })();
    const rpc = await context.rpc.register(OFFPEAK_RPC, {
      control: async (rawInput: unknown): Promise<OffpeakRpcOutput> => {
        const input = rawInput as OffpeakRpcInput;
        const id = input.id?.trim();
        switch (input.action) {
          case "on":
            await engine.setEnabled(true);
            return {
              message: "OpenCode Offpeak is ON. Queue processing and automatic resume are active.",
            };
          case "off":
            await engine.setEnabled(false);
            return {
              message:
                "OpenCode Offpeak is OFF. Automation is paused; queued tasks and session IDs are preserved. Peak pricing is still blocked.",
            };
          case "queue": {
            if (!input.prompt) throw new Error("Usage: /offpeak queue <task>");
            if (!input.providerID || !input.modelID) {
              throw new Error("Select a provider/model in OpenCode before queueing a task.");
            }
            const task = await engine.queue({
              prompt: input.prompt,
              cwd: input.cwd ?? context.location.directory,
              model: { providerID: input.providerID, modelID: input.modelID },
            });
            return { message: `Queued ${task.id} (${task.policyID}).`, tasks: [task] };
          }
          case "status":
          case "pricing": {
            const status = await engine.status({
              ...(input.providerID ? { providerID: input.providerID } : {}),
              ...(input.modelID ? { modelID: input.modelID } : {}),
            });
            return { status: status as unknown as Record<string, unknown> };
          }
          case "list":
            return { tasks: await engine.list() };
          case "cancel":
            if (!id) throw new Error("Usage: /offpeak cancel <task-id>");
            await engine.cancel(id);
            return { message: `Cancelled ${id}. Its OpenCode session is preserved.` };
          case "remove":
            if (!id) throw new Error("Usage: /offpeak remove <task-id>");
            await engine.remove(id);
            return {
              message: `Removed ${id} from the queue. Its OpenCode session is preserved.`,
            };
          case "retry":
            if (!id) throw new Error("Usage: /offpeak retry <task-id>");
            await engine.retry(id);
            return {
              message: `Retry requested for ${id}; the same session will be continued when allowed.`,
            };
          case "resume":
            if (!id) throw new Error("Usage: /offpeak resume <task-id>");
            await engine.resume(id);
            return { message: `Resume requested for ${id}; pricing rules still apply.` };
          case "run-now":
            if (!id) throw new Error("Usage: /offpeak run-now <task-id>");
            await engine.runNow(id);
            return { message: `Explicit 15-minute peak-price override active for ${id}.` };
          default:
            throw new Error(
              "Usage: /offpeak on|off|status|pricing|queue|list|cancel|remove|retry|resume|run-now",
            );
        }
      },
    });

    await engine.start();
    return async () => {
      eventAbort.abort();
      await events;
      await engine.dispose();
      await Promise.all(hooks.map((registration) => registration.dispose()));
      await rpc.dispose();
    };
  },
});
