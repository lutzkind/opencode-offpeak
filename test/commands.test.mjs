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

test("protection global is interface-scoped and never writes the other interface", () => {
  const cliOff = plan("/offpeak protection global off");
  assert.equal(cliOff.kind, "protection-global");
  assert.deepEqual(cliOff.request, {
    action: "client-set",
    client: "cli",
    protection: "off",
    sessionID: "ses_chat_a",
  });

  const desktopOn = plan("protection global on", desktop);
  assert.equal(desktopOn.kind, "protection-global");
  assert.deepEqual(desktopOn.request, {
    action: "client-set",
    client: "desktop",
    protection: "on",
    sessionID: "ses_chat_a",
  });
  assert.notEqual(desktopOn.request.client, "cli");
});

test("protection chat maps to the explicit session override for this session only", () => {
  assert.deepEqual(plan("/offpeak protection chat off").request, {
    action: "session-off",
    sessionID: "ses_chat_a",
  });
  assert.deepEqual(plan("protection chat on", desktop).request, {
    action: "session-on",
    sessionID: "ses_chat_a",
  });
  assert.throws(
    () => plan("/offpeak protection chat off", { ...cli, sessionID: undefined }),
    /No current OpenCode session is focused/,
  );
});

test("protection commands reject incomplete or unknown forms with canonical usage", () => {
  assert.throws(() => plan("/offpeak protection global sometimes"), /Usage: \/offpeak protection/);
  assert.throws(() => plan("/offpeak protection chat"), /Usage: \/offpeak protection/);
  assert.throws(() => plan("/offpeak protection elsewhere on"), /Usage: \/offpeak protection/);
});

test("status carries the focused chat and formats both global defaults and queue state", async () => {
  const calls = [];
  const result = await runOffpeakCommand(
    {
      control: async (input) => {
        calls.push(input);
        return {
          status: {
            enabled: true,
            mode: "auto",
            automaticExecution: "ACTIVE",
            automaticResume: "ACTIVE",
            pricingState: "PEAK",
            clientDefaults: { cli: "ON", desktop: "OFF" },
            client: {
              ownership: "cli",
              protection: "OFF",
              source: "session-override",
            },
            sessionProtection: "OFF",
            effectiveProtection: "OFF",
            requestsAllowed: true,
            queued: 2,
            waiting: 1,
            failed: 0,
          },
        };
      },
    },
    "/offpeak status",
    cli,
  );
  const text = result.text;
  assert.deepEqual(calls, [
    {
      action: "status",
      sessionID: "ses_chat_a",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
    },
  ]);
  assert.match(text, /CLI global protection: ON/);
  assert.match(text, /Desktop global protection: OFF/);
  assert.match(text, /Protection for this chat: OFF \(explicit override/);
  assert.match(text, /Effective protection: OFF/);
  assert.match(text, /Queue: 2 queued, 1 waiting, 0 failed/);
});

test("global protection feedback states what changed and confirms the other interface", () => {
  const output = {
    client: { defaults: { cli: "OFF", desktop: "ON" } },
  };
  const text = formatOffpeakResult(plan("/offpeak protection global off"), output, cli);
  assert.match(text, /^CLI global protection: OFF$/m);
  assert.match(text, /Desktop global protection: ON \(not modified\)/);
  assert.match(text, /Applies to CLI sessions/);

  const desktopText = formatOffpeakResult(
    plan("protection global off", desktop),
    { client: { defaults: { cli: "ON", desktop: "OFF" } } },
    desktop,
  );
  assert.match(desktopText, /^Desktop global protection: OFF$/m);
  assert.match(desktopText, /CLI global protection: ON \(not modified\)/);
});

test("chat feedback shows the override or the followed interface global", () => {
  const off = formatOffpeakResult(
    plan("/offpeak protection chat off"),
    {
      message: "Session off-peak protection disabled.",
      client: {
        defaults: { cli: "ON", desktop: "ON" },
        session: {
          sessionID: "ses_chat_a",
          ownership: "cli",
          protection: "OFF",
          source: "session-override",
        },
      },
    },
    cli,
  );
  assert.match(off, /Protection for this chat: OFF \(explicit override/);
  assert.match(off, /CLI global protection: ON \(not modified\)/);
  assert.match(off, /Desktop global protection: ON \(not modified\)/);

  const on = formatOffpeakResult(
    plan("/offpeak protection chat on"),
    {
      message: "Session off-peak protection enabled.",
      client: {
        defaults: { cli: "ON", desktop: "ON" },
        session: {
          sessionID: "ses_chat_a",
          ownership: "cli",
          protection: "ON",
          source: "client-default",
        },
      },
    },
    cli,
  );
  assert.match(on, /Protection for this chat: follows the CLI global \(ON\)/);
  assert.match(on, /Effective protection: ON/);
});

test("chat on follows a globally OFF interface without inventing an ON override", () => {
  const text = formatOffpeakResult(
    plan("/offpeak protection chat on"),
    {
      client: {
        defaults: { cli: "OFF", desktop: "ON" },
        session: {
          sessionID: "ses_chat_a",
          ownership: "cli",
          protection: "OFF",
          source: "client-default",
        },
      },
    },
    cli,
  );
  assert.match(text, /Protection for this chat: follows the CLI global \(OFF\)/);
  assert.match(text, /Effective protection: OFF/);
});

test("legacy /offpeak client and /offpeak session retain their original server actions", () => {
  assert.deepEqual(plan("/offpeak client").request, {
    action: "client",
    sessionID: "ses_chat_a",
  });
  assert.deepEqual(plan("/offpeak client desktop off").request, {
    action: "client-set",
    client: "desktop",
    protection: "off",
    sessionID: "ses_chat_a",
  });
  assert.deepEqual(plan("/offpeak session off").request, {
    action: "session-off",
    sessionID: "ses_chat_a",
  });
  assert.throws(() => plan("/offpeak session sometimes"), /Usage: \/offpeak session on\|off/);
});
