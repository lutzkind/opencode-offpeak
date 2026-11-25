import { Plugin } from "@opencode/plugin";
import { assertSupportedOpenCode } from "./compat.js";
import { ConfigRepository } from "./config.js";
import { type EngineNotification, OffpeakEngine, type SessionDriver } from "./engine.js";
import {
  isRefusedHandshakeUrl,
  isRefusedRequestUrl,
  REFUSED_HANDSHAKE_URL,
  REFUSED_HEADER,
  refusedRequest,
} from "./refused.js";
import {
  OFFPEAK_RPC,
  type OffpeakPricingOutput,
  type OffpeakRpcInput,
  type OffpeakRpcOutput,
} from "./rpc.js";
import { ClientsRepository, RecoveryRepository, SessionOverridesRepository } from "./store.js";

export default Plugin.define({
  id: "opencode-offpeak",
  setup: async (context) => {
    assertSupportedOpenCode(context.app, "server");
    const config = new ConfigRepository(context.options);
    const storage = {
      get: (key: string) => context.storage.get(key),
      set: (key: string, value: unknown) => context.storage.set(key, value as never),
    };
    const recoveries = new RecoveryRepository(storage);
    const sessionOverrides = new SessionOverridesRepository(storage);
    const clients = new ClientsRepository(storage);
    const sessions: SessionDriver = {
      prompt: async (sessionID, text) => {
        await context.session.prompt({ sessionID, text });
      },
      get: async (sessionID) => {
        const session = await context.session.get({ sessionID });
        // A missing session (or a host that returns undefined instead of
        // throwing) is reported explicitly, so state cleanup can distinguish it
        // from a transient error and only reap sessions that no longer exist.
        if (!session) {
          const error = new Error(`Session not found: ${sessionID}`);
          error.name = "SessionNotFoundError";
          Object.assign(error, { _tag: "SessionNotFoundError" });
          throw error;
        }
        // The wire format carries millis; the typed client exposes a DateTime.
        const created = (session.time as { created?: unknown } | undefined)?.created;
        const createdMs = typeof created === "number" ? created : Date.parse(String(created));
        return {
          ...(session.outcome ? { outcome: session.outcome } : {}),
          ...(session.title !== undefined ? { title: session.title } : {}),
          ...(session.parentID ? { parentID: session.parentID } : {}),
          ...(Number.isFinite(createdMs) ? { created: createdMs } : {}),
        };
      },
      // NOTE: OpenCode 2.0.27's plugin host does not expose a title generation
      // call. `context.session.update({ title: "" })` is NOT the HTTP API's
      // "regenerate" trigger: the plugin host renames the session to an empty
      // title instead. The pending-title recovery therefore never mutates the
      // session; it verifies and clears, and OpenCode's own input promotion
      // generates the title (see #deliverTitleRecovery).
      compact: async (sessionID) => {
        // Semantic compaction recovery: admit OpenCode's own compaction
        // again. It is never a replay of the lost request.
        await context.session.compact({ sessionID });
      },
    };
    // Hold/resume notifications travel as plugin RPC events on OpenCode's own
    // event stream; a TUI renders them as toasts, and headless runs simply have
    // no subscriber.
    let publishNotification: ((event: EngineNotification) => Promise<void>) | undefined;
    const engine = new OffpeakEngine({
      recoveries,
      sessionOverrides,
      clients,
      location: context.location?.directory ?? "",
      config,
      sessions,
      notify: (event) => {
        const publish = publishNotification;
        if (!publish) return;
        void publish(event).catch((error) => console.error("[opencode-offpeak]", error));
      },
      onError: (error) => console.error("[opencode-offpeak]", error),
    });
    // A cancelled hold must win over every pricing guard. These run first (hook
    // callbacks run in registration order), so an already-refused request is a
    // placeholder from that moment on: it is never re-evaluated, never held
    // again at the transport boundary, and never sent.
    const refusalHooks = [
      await context.session.hook("http.request", (request) => {
        const consumed = engine.consumeRefusal({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          kind: request.kind,
        });
        if (!consumed) return;
        request.request = refusedRequest();
      }),
      await context.session.hook("experimental.ws.handshake", (request) => {
        const consumed = engine.consumeRefusal({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          kind: request.kind,
        });
        if (!consumed) return;
        request.url = REFUSED_HANDSHAKE_URL;
        request.headers = { [REFUSED_HEADER]: "1" };
      }),
    ];
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
      context.session.hook("http.request", (request) => {
        // A refused placeholder must not be re-evaluated: the cancellation
        // already decided this attempt is not sent.
        if (isRefusedRequestUrl(request.request.url)) return;
        return engine.guardRequest({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          kind: request.kind,
          transport: "http",
        });
      }),
      context.session.hook("experimental.ws.handshake", (request) => {
        if (isRefusedHandshakeUrl(request.url)) return;
        return engine.guardRequest({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          kind: request.kind,
          transport: "websocket",
        });
      }),
      context.session.hook("experimental.ws.send", (request) =>
        engine.guardRequest({
          sessionID: request.sessionID,
          providerID: request.model.providerID,
          modelID: request.model.id,
          kind: request.kind,
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
          if (event.type === "session.execution.started") {
            // Recovery delivery waits while the session is executing:
            // session.outcome only updates at settlement, so a running turn
            // still reports its previous outcome.
            engine.noteExecutionRunning(event.data.sessionID);
            continue;
          }
          if (
            event.type === "session.execution.succeeded" ||
            event.type === "session.execution.failed"
          ) {
            engine.noteExecutionSettled(event.data.sessionID);
            continue;
          }
          if (event.type === "session.execution.interrupted") {
            engine.noteExecutionSettled(event.data.sessionID);
            await engine.noteExecutionInterrupted({
              sessionID: event.data.sessionID,
              reason: event.data.reason,
            });
            continue;
          }
          // OpenCode's supported session-deletion event: an explicit per-session
          // protection setting for a session that no longer exists is reaped
          // here instead of lingering in plugin storage. State for a session
          // that still exists is never removed.
          if (event.type === "session.deleted") {
            await engine.forgetSession(event.data.sessionID);
          }
        }
      } catch (error) {
        if (!eventAbort.signal.aborted) console.error("[opencode-offpeak]", error);
      }
    })();
    const rpc = await context.rpc.register(OFFPEAK_RPC, {
      control: async (rawInput: unknown): Promise<OffpeakRpcOutput> => {
        const input = rawInput as OffpeakRpcInput;
        switch (input.action) {
          // Deprecated automation aliases from v0.4.x. v0.5.0 has no
          // installation-wide enable switch, so they now mean "protect this
          // surface" (CLI by default) instead of "start/stop the queue".
          case "on":
          case "off": {
            const client = input.client?.trim();
            const target = client === "desktop" ? "desktop" : "cli";
            await engine.setClientProtection(target, input.action === "off" ? "off" : "on");
            const sessionID = input.sessionID?.trim();
            return { client: await engine.clientStatus(sessionID ? { sessionID } : {}) };
          }
          case "session-set": {
            const sessionID = input.sessionID?.trim();
            const protection = input.protection?.trim().toLowerCase();
            if (!sessionID) {
              throw new Error(
                "No current OpenCode session is focused. Open a chat before changing its off-peak protection.",
              );
            }
            if (protection !== "on" && protection !== "off" && protection !== "auto") {
              throw new Error("Usage: /offpeak chat on|off|auto");
            }
            const state = await engine.setSessionProtection(sessionID, protection);
            void engine.pruneSessionProtections().catch(() => undefined);
            return { state, client: await engine.clientStatus({ sessionID }) };
          }
          // v0.4.x command aliases. `session-on` used to mean "follow the
          // global"; in v0.5.0 it explicitly forces protection on, which is the
          // behavior users intended when a client global was off.
          case "session-on":
          case "session-off": {
            const sessionID = input.sessionID?.trim();
            if (!sessionID) {
              throw new Error(
                "No current OpenCode session is focused. Open a chat before changing its off-peak protection.",
              );
            }
            const state = await engine.setSessionProtection(
              sessionID,
              input.action === "session-off" ? "off" : "on",
            );
            void engine.pruneSessionProtections().catch(() => undefined);
            return {
              state,
              message:
                state === "OFF"
                  ? "Session off-peak protection disabled. This chat may use verified peak-priced inference."
                  : "Session off-peak protection enabled. Peak-priced requests wait for off-peak.",
              client: await engine.clientStatus({ sessionID }),
            };
          }
          case "client": {
            // Read-only client defaults plus the effective state of the
            // focused session. Never guesses a client from IP, User-Agent, or
            // an environment variable.
            const sessionID = input.sessionID?.trim();
            return {
              client: await engine.clientStatus(sessionID ? { sessionID } : {}),
            };
          }
          case "client-set": {
            const client = input.client?.trim();
            const protection = input.protection?.trim().toLowerCase();
            if (client !== "cli" && client !== "desktop") {
              throw new Error("Usage: /offpeak cli on|off or /offpeak desktop on|off");
            }
            if (protection !== "on" && protection !== "off") {
              throw new Error("Protection must be on or off.");
            }
            await engine.setClientProtection(client, protection);
            void engine.pruneSessionProtections().catch(() => undefined);
            // Return the public state of the same session, when supplied, so
            // the writer sees the effective result instead of guessing it.
            const sessionID = input.sessionID?.trim();
            return { client: await engine.clientStatus(sessionID ? { sessionID } : {}) };
          }
          case "client-register": {
            const client = input.client?.trim();
            const sessionID = input.sessionID?.trim();
            if (client !== "cli" && client !== "desktop") {
              throw new Error("client-register requires client=cli|desktop.");
            }
            if (!sessionID) throw new Error("client-register requires a sessionID.");
            const status = await engine.registerSessionClient(sessionID, client);
            return { client: status };
          }
          case "status":
          case "pricing": {
            const status = await engine.status({
              ...(input.providerID ? { providerID: input.providerID } : {}),
              ...(input.modelID ? { modelID: input.modelID } : {}),
              ...(input.sessionID?.trim() ? { sessionID: input.sessionID.trim() } : {}),
            });
            return { status: status as unknown as Record<string, unknown> };
          }
          default:
            throw new Error(
              "Usage: /offpeak status | /offpeak on | /offpeak off | /offpeak chat on|off|auto | /offpeak cli on|off | /offpeak desktop on|off",
            );
        }
      },
      pricing: async (rawInput: unknown): Promise<OffpeakPricingOutput> => {
        const input = rawInput as { providerID?: unknown; modelID?: unknown };
        const providerID = typeof input.providerID === "string" ? input.providerID.trim() : "";
        const modelID = typeof input.modelID === "string" ? input.modelID.trim() : "";
        if (!providerID || !modelID) {
          throw new Error("pricing requires providerID and modelID.");
        }
        return engine.pricing({ providerID, modelID });
      },
      cancelHold: async (rawInput: unknown): Promise<OffpeakRpcOutput> => {
        const input = rawInput as { sessionID?: string; reason?: string };
        const sessionID = input.sessionID?.trim();
        if (!sessionID) throw new Error("cancelHold requires a sessionID.");
        const result = await engine.cancelHold({
          sessionID,
          ...(input.reason ? { reason: input.reason } : {}),
        });
        return { ...result };
      },
    });

    await engine.start();
    publishNotification = async (event) => {
      if (event.type === "hold") {
        await rpc.events?.emit?.("hold", {
          sessionID: event.sessionID,
          timeZone: event.timeZone,
          ...(event.until !== undefined ? { until: event.until } : {}),
          ...(event.display !== undefined ? { display: event.display } : {}),
        });
        return;
      }
      await rpc.events?.emit?.("resume", {
        sessionID: event.sessionID,
        kind: event.kind,
      });
    };
    return async () => {
      publishNotification = undefined;
      eventAbort.abort();
      await events;
      await engine.dispose();
      await Promise.all([
        ...refusalHooks.map((registration) => registration.dispose()),
        ...hooks.map((registration) => registration.dispose()),
      ]);
      await rpc.dispose();
    };
  },
});
