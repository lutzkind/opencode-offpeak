import assert from "node:assert/strict";
import test from "node:test";
import { formatOffpeakResult, planOffpeakCommand, runOffpeakCommand } from "../dist/commands.js";

const cli = {
  surface: "cli",
  sessionID: "ses_chat_a",
  providerID: "opencode-go",
  modelID: "deepseek-v4.1-flash",
};
const desktop = { ...cli, surface: "desktop" };

function plan(input, context = cli) {
  return planOffpeakCommand(input, context);
}

test("on and off change only the calling surface's global", () => {
  const cliOff = plan("/offpeak off");
  assert.equal(cliOff.kind, "client-global");
  assert.deepEqual(cliOff.request, {
    action: "client-set",
    client: "cli",
    protection: "off",
    sessionID: "ses_chat_a",
  });

  const desktopOn = plan("on", desktop);
  assert.equal(desktopOn.kind, "client-global");
  assert.deepEqual(desktopOn.request, {
    action: "client-set",
    client: "desktop",
    protection: "on",
    sessionID: "ses_chat_a",
  });
});

test("explicit client forms change only the named global", () => {
  assert.deepEqual(plan("/offpeak cli off").request, {
    action: "client-set",
    client: "cli",
    protection: "off",
    sessionID: "ses_chat_a",
  });
  assert.deepEqual(plan("desktop on", desktop).request, {
    action: "client-set",
    client: "desktop",
    protection: "on",
    sessionID: "ses_chat_a",
  });
  assert.throws(() => plan("/offpeak cli sometimes"), /Usage: \/offpeak cli on\|off/);
});

test("chat on, off, and auto set that chat only", () => {
  assert.deepEqual(plan("/offpeak chat off").request, {
    action: "session-set",
    sessionID: "ses_chat_a",
    protection: "off",
  });
  assert.deepEqual(plan("chat on", desktop).request, {
    action: "session-set",
    sessionID: "ses_chat_a",
    protection: "on",
  });
  assert.deepEqual(plan("chat auto").request, {
    action: "session-set",
    sessionID: "ses_chat_a",
    protection: "auto",
  });
  assert.throws(
    () => plan("/offpeak chat off", { ...cli, sessionID: undefined }),
    /Open this chat/,
  );
  assert.throws(() => plan("/offpeak chat sometimes"), /Usage: \/offpeak chat on\|off\|auto/);
});

test("the v0.4.x protection forms remain hidden aliases over the same state", () => {
  assert.deepEqual(plan("/offpeak protection global off").request, {
    action: "client-set",
    client: "cli",
    protection: "off",
    sessionID: "ses_chat_a",
  });
  assert.deepEqual(plan("/offpeak protection chat off").request, {
    action: "session-set",
    sessionID: "ses_chat_a",
    protection: "off",
  });
  assert.deepEqual(plan("/offpeak session on").request, {
    action: "session-set",
    sessionID: "ses_chat_a",
    protection: "on",
  });
});

test("status sends only the status request and formats the simplified model", async () => {
  const calls = [];
  const result = await runOffpeakCommand(
    {
      control: async (input) => {
        calls.push(input);
        return {
          status: {
            clientDefaults: { cli: "ON", desktop: "OFF" },
            client: {
              ownership: "desktop",
              protection: "ON",
              source: "session-override",
              override: "on",
            },
            effectiveProtection: "ON",
            pricingState: "PEAK",
            requestsAllowed: false,
            nextTransition: 1795586400000,
            displayTimeZone: "UTC",
            interactiveWaiting: 0,
          },
        };
      },
    },
    "/offpeak status",
    cli,
  );
  assert.deepEqual(calls, [
    {
      action: "status",
      sessionID: "ses_chat_a",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    },
  ]);
  assert.match(result.text, /CLI protection: ON/);
  assert.match(result.text, /Desktop protection: OFF/);
  assert.match(result.text, /This chat: always protect \(explicit\)/);
  assert.match(result.text, /Requests: BLOCKED/);
  assert.doesNotMatch(result.text, /Queue|Mode:|Plugin:/);
});

test("status reports a chat that follows its client global", async () => {
  const result = await runOffpeakCommand(
    {
      control: async () => ({
        status: {
          clientDefaults: { cli: "OFF", desktop: "ON" },
          client: {
            ownership: "cli",
            protection: "OFF",
            source: "client-default",
          },
          pricingState: "PEAK",
          requestsAllowed: true,
          displayTimeZone: "UTC",
        },
      }),
    },
    "status",
    cli,
  );
  assert.match(result.text, /This chat: follows the CLI global \(OFF\)/);
  assert.match(result.text, /Requests: ALLOWED/);
});

test("global feedback names the changed client and leaves the other alone", () => {
  const output = { client: { defaults: { cli: "OFF", desktop: "ON" } } };
  const text = formatOffpeakResult(plan("/offpeak off"), output, cli);
  assert.match(text, /^CLI protection: OFF$/m);
  assert.match(text, /Desktop protection: ON \(not modified\)/);
});

test("chat feedback shows explicit settings and the effective state", () => {
  const output = {
    client: {
      defaults: { cli: "ON", desktop: "ON" },
      session: {
        sessionID: "ses_chat_a",
        ownership: "cli",
        protection: "OFF",
        source: "session-override",
        override: "off",
      },
    },
  };
  const text = formatOffpeakResult(plan("chat off"), output, cli);
  assert.match(text, /This chat: allow peak \(explicit\)/);
  assert.match(text, /Effective protection: OFF/);
  assert.match(text, /CLI protection: ON \(unchanged\)/);
});
