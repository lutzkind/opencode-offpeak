/**
 * Cancellation of a parked interactive request.
 *
 * A caller may decide a held request is obsolete. `cancelHold` then has to
 * settle the race between cancellation and release with one authoritative
 * answer, and a cancelled request must be refused at the transport boundary
 * instead of being sent or re-held.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  ConfigRepository,
  OffpeakEngine,
  QueueRepository,
  RecoveryRepository,
} from "../dist/index.js";

class MemoryStorage {
  values = new Map();
  async get(key) {
    return structuredClone(this.values.get(key));
  }
  async set(key, value) {
    this.values.set(key, structuredClone(value));
  }
}

class ManualClock {
  constructor(now) {
    this.value = Date.parse(now);
    this.timers = new Set();
    this.sequence = 0;
  }
  now = () => this.value;
  setTimeout = (callback, milliseconds) => {
    const timer = { id: ++this.sequence, at: this.value + Math.max(0, milliseconds), callback };
    this.timers.add(timer);
    return timer;
  };
  clearTimeout = (timer) => {
    this.timers.delete(timer);
  };
  async advanceTo(value) {
    this.value = Date.parse(value);
    for (let round = 0; round < 200; round += 1) {
      const due = [...this.timers].filter((timer) => timer.at <= this.value);
      if (!due.length) return;
      for (const timer of due) {
        this.timers.delete(timer);
        timer.callback();
      }
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    throw new Error("ManualClock did not settle");
  }
}

class FakeSessions {
  created = [];
  prompts = [];
  async create(input) {
    const id = `session-${this.created.length + 1}`;
    this.created.push({ id, ...input });
    return id;
  }
  async prompt(sessionID, text) {
    this.prompts.push({ sessionID, text });
  }
  async wait() {}
  async get() {
    return {};
  }
  async interrupt() {}
}

async function until(predicate, message = "condition was not reached") {
  const end = Date.now() + 5000;
  while (Date.now() < end) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail(message);
}

const selectedModel = { providerID: "opencode-go", modelID: "deepseek-v4.1-flash" };

function isPeak(clock) {
  // The default policy blocks 01:00-04:00 UTC on weekdays.
  const hour = new Date(clock.now()).getUTCHours();
  return hour >= 1 && hour < 4;
}

async function harness(now = "2026-10-12T02:00:00Z", options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "opencode-offpeak-cancel-"));
  const clock = options.clock ?? new ManualClock(now);
  const storage = options.storage ?? new MemoryStorage();
  const sessions = options.sessions ?? new FakeSessions();
  const config = new ConfigRepository({ configPath: path.join(root, "offpeak.json") });
  const engine = new OffpeakEngine({
    repository: new QueueRepository(storage),
    recoveries: new RecoveryRepository(storage),
    location: "test-location",
    config,
    sessions,
    clock,
  });
  await engine.start();
  return {
    root,
    clock,
    sessions,
    engine,
    async close() {
      await engine.dispose();
      await rm(root, { recursive: true, force: true });
    },
  };
}

/** Park an interactive request and keep its promise so the outcome is observable. */
function park(engine, sessionID, kind = "primary") {
  const outcome = { released: 0, rejected: 0, error: undefined };
  const settled = engine
    .guardModelRequest({ sessionID, ...selectedModel, kind, transport: "model" })
    .then(
      () => {
        outcome.released += 1;
      },
      (error) => {
        outcome.rejected += 1;
        outcome.error = error;
      },
    );
  return { outcome, settled };
}

test("cancelling a parked request refuses it at the transport boundary instead of sending it", async () => {
  const clock = new ManualClock("2026-10-12T02:00:00Z");
  assert.ok(isPeak(clock), "fixture must start inside a peak window");
  const h = await harness("2026-10-12T02:00:00Z", { clock });
  try {
    const { outcome, settled } = park(h.engine, "cancel-1");
    await until(async () => (await h.engine.status(selectedModel)).interactiveHolds === 1);

    const result = await h.engine.cancelHold({ sessionID: "cancel-1", reason: "test" });
    assert.deepEqual(result, {
      cancelled: true,
      state: "refused",
      model: "opencode-go/deepseek-v4.1-flash",
    });

    // The hold loop returns, so the request proceeds to the boundary...
    await until(async () => outcome.released === 1);
    assert.equal(outcome.rejected, 0);
    // ...where the armed refusal is consumed exactly once, for that request.
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "cancel-1",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        kind: "primary",
      }),
      true,
    );
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "cancel-1",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        kind: "primary",
      }),
      false,
      "a refusal is one-shot",
    );
    const status = await h.engine.status(selectedModel);
    assert.equal(status.interactiveHolds, 0);
    assert.equal(status.armedRefusals, 0);
    assert.equal(status.cancelledHolds, 1);
    assert.equal(status.refusedRequests, 1);
    await settled;
  } finally {
    await h.close();
  }
});

test("a refusal never leaks onto a different request", async () => {
  const clock = new ManualClock("2026-10-12T02:00:00Z");
  const h = await harness("2026-10-12T02:00:00Z", { clock });
  try {
    const { settled } = park(h.engine, "cancel-2");
    await until(async () => (await h.engine.status(selectedModel)).interactiveHolds === 1);
    await h.engine.cancelHold({ sessionID: "cancel-2" });
    await settled;

    // Wrong kind, wrong model, wrong session: none of them consume it.
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "cancel-2",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        kind: "title",
      }),
      false,
    );
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "cancel-2",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-pro",
        kind: "primary",
      }),
      false,
    );
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "other-session",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        kind: "primary",
      }),
      false,
    );
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "cancel-2",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        kind: "primary",
      }),
      true,
    );
  } finally {
    await h.close();
  }
});

test("a stale refusal expires and a new hold supersedes it", async () => {
  const clock = new ManualClock("2026-10-12T02:00:00Z");
  const h = await harness("2026-10-12T02:00:00Z", { clock });
  try {
    const first = park(h.engine, "cancel-3");
    await until(async () => (await h.engine.status(selectedModel)).interactiveHolds === 1);
    await h.engine.cancelHold({ sessionID: "cancel-3" });
    await first.settled;
    assert.equal((await h.engine.status(selectedModel)).armedRefusals, 1);

    // The refusal expires: a boundary that arrives later must not refuse.
    await clock.advanceTo("2026-10-12T02:02:00Z");
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "cancel-3",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        kind: "primary",
      }),
      false,
    );

    // And starting a fresh hold drops an un-consumed refusal outright.
    const second = park(h.engine, "cancel-3");
    await until(async () => (await h.engine.status(selectedModel)).interactiveHolds === 1);
    assert.equal((await h.engine.status(selectedModel)).armedRefusals, 0);
    await h.engine.cancelHold({ sessionID: "cancel-3" });
    await second.settled;
  } finally {
    await h.close();
  }
});

test("cancellation reports the truth when the release already won the race", async () => {
  const clock = new ManualClock("2026-10-12T02:00:00Z");
  const h = await harness("2026-10-12T02:00:00Z", { clock });
  try {
    const { outcome, settled } = park(h.engine, "cancel-4");
    await until(async () => (await h.engine.status(selectedModel)).interactiveHolds === 1);

    // Release the request by moving past the peak window, then cancel.
    await clock.advanceTo("2026-10-12T04:00:01Z");
    await until(async () => outcome.released === 1);
    await settled;

    const late = await h.engine.cancelHold({ sessionID: "cancel-4" });
    assert.equal(late.cancelled, false);
    assert.equal(late.state, "committed", "the dispatch decision is reported, not a fake cancel");
    const status = await h.engine.status(selectedModel);
    assert.equal(status.interactiveHolds, 0);
    assert.equal(status.cancelledHolds, 0);
  } finally {
    await h.close();
  }
});

test("cancelling a session with no parked request is a no-op", async () => {
  const h = await harness();
  try {
    const result = await h.engine.cancelHold({ sessionID: "nothing-here" });
    assert.deepEqual(result, { cancelled: false, state: "none" });
  } finally {
    await h.close();
  }
});

test("a queue-owned hold is not cancellable by another plugin", async () => {
  const clock = new ManualClock("2026-10-12T02:00:00Z");
  const h = await harness("2026-10-12T02:00:00Z", { clock });
  try {
    const task = await h.engine.queue({
      prompt: "queue work",
      cwd: "/project",
      model: selectedModel,
    });
    await until(async () => {
      const tasks = await h.engine.list();
      return tasks.some((entry) => entry.id === task.id && entry.state === "WAITING_OFFPEAK");
    });
    const result = await h.engine.cancelHold({ sessionID: "queue-session" });
    assert.equal(result.cancelled, false);
    assert.notEqual(result.state, "refused");
  } finally {
    await h.close();
  }
});

test("a consumed refusal keeps offpeak's own retry recovery out of the way", async () => {
  const clock = new ManualClock("2026-10-12T02:00:00Z");
  const h = await harness("2026-10-12T02:00:00Z", { clock });
  try {
    const { settled } = park(h.engine, "cancel-5");
    await until(async () => (await h.engine.status(selectedModel)).interactiveHolds === 1);
    await h.engine.cancelHold({ sessionID: "cancel-5" });
    await settled;
    assert.equal(
      h.engine.consumeRefusal({
        sessionID: "cancel-5",
        providerID: "opencode-go",
        modelID: "deepseek-v4.1-flash",
        kind: "primary",
      }),
      true,
    );
    // The refused attempt then fails as a transport error during peak. Offpeak
    // must not convert it into its own recovery continuation: the caller that
    // asked for the cancellation owns what happens next.
    const outcome = await h.engine.noteRetryFailure({
      sessionID: "cancel-5",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal(outcome, "pass");
    assert.equal((await h.engine.status(selectedModel)).recoveryWaiting, 0);

    // A genuine provider failure during peak still takes the recovery path.
    const genuine = await h.engine.noteRetryFailure({
      sessionID: "genuine-failure",
      providerID: "opencode-go",
      modelID: "deepseek-v4.1-flash",
      errorType: "provider.transport",
      willRetry: true,
    });
    assert.equal(genuine, "hold");
  } finally {
    await h.close();
  }
});
