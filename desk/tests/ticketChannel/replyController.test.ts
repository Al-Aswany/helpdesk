import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DRAFT_MAX_AGE_MS,
  ReplyController,
  type ReplyDeps,
  type StoredReply,
} from "../../src/composables/ticketChannel/replyController.ts";

type Row = Record<string, any>;

function row(requestKey: string, state = "Queued", extra: Row = {}) {
  return {
    name: `OUT-${requestKey}`,
    request_key: requestKey,
    state,
    reason: null,
    error_summary: null,
    communication: null,
    body: "kept",
    requested_by: "agent@example.com",
    creation: "2026-10-17 10:00:00",
    queued_at: null,
    sending_started_at: null,
    accepted_at: null,
    completed_at: null,
    ...extra,
  };
}

function reply(requestId: string, state = "Queued", extra: Row = {}) {
  return {
    ok: ["Queued", "Sending", "Accepted"].includes(state),
    state,
    reason: null,
    outbox: `OUT-${requestId}`,
    error: null,
    communication: null,
    request_id: requestId,
    message: "kept",
    ...extra,
  };
}

function harness(
  overrides: Partial<ReplyDeps> = {},
  stored: StoredReply | null = null
) {
  const calls: {
    message: string;
    requestId: string;
    file?: string | null;
  }[] = [];
  const timers: { fn: () => void; ms: number; cleared: boolean }[] = [];
  let id = 0;
  const env = {
    stored,
    rows: [] as Row[] | null,
    changes: 0,
    now: 1_000_000,
    calls,
    timers,
    sendImpl: (args: { message: string; requestId: string }): Promise<any> =>
      Promise.resolve(reply(args.requestId)),
    refreshCalls: 0,
  };
  const deps: ReplyDeps = {
    load: () => env.stored,
    save: (value) => {
      env.stored = value ? JSON.parse(JSON.stringify(value)) : null;
    },
    send: (args) => {
      calls.push(args);
      return env.sendImpl(args);
    },
    refresh: async () => {
      env.refreshCalls += 1;
      return env.rows as any;
    },
    newId: () => `id-${++id}`,
    now: () => env.now,
    onChange: () => {
      env.changes += 1;
    },
    setTimer: (fn, ms) => {
      const timer = { fn, ms, cleared: false };
      timers.push(timer);
      return timer;
    },
    clearTimer: (handle) => {
      (handle as { cleared: boolean }).cleared = true;
    },
    ...overrides,
  };
  return { env, deps, make: () => new ReplyController(deps) };
}

test("submit sends once and keeps the draft until the backend row is visible", async () => {
  const { env, make } = harness();
  const controller = make();
  controller.setDraft("Hello customer");
  env.rows = []; // refresh cannot see the row yet
  const outcome = await controller.submit();
  assert.equal(outcome.kind, "saved");
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0]!.message, "Hello customer");
  let snap = controller.snapshot();
  assert.equal(
    snap.draft,
    "Hello customer",
    "draft kept while the row is not visible"
  );
  assert.equal(snap.phase, "confirming");
  assert.equal(snap.pending?.acknowledged, true);
  assert.equal(snap.notice?.kind, "saved_unconfirmed");

  assert.equal(controller.observe([row("id-1", "Queued")] as any), true);
  snap = controller.snapshot();
  assert.equal(snap.draft, "");
  assert.equal(snap.pending, null);
  assert.equal(snap.phase, "idle");
  assert.equal(env.stored, null, "nothing persisted once settled");
});

test("draft clears when the refreshed rows already show the request", async () => {
  const { env, make } = harness();
  const controller = make();
  controller.setDraft("Hi");
  env.rows = [row("id-1", "Queued")];
  assert.equal((await controller.submit()).kind, "confirmed");
  assert.equal(controller.snapshot().draft, "");
});

test("a double click joins the request in flight", async () => {
  const { env, make } = harness();
  let release: (value: any) => void = () => undefined;
  env.sendImpl = () => new Promise((resolve) => (release = resolve));
  env.rows = [row("id-1")];
  const controller = make();
  controller.setDraft("Once");
  const first = controller.submit();
  const second = controller.submit();
  const third = controller.submit();
  assert.equal(env.calls.length, 1);
  release(reply("id-1"));
  const results = await Promise.all([first, second, third]);
  assert.deepEqual(
    results.map((r) => r.kind),
    ["confirmed", "confirmed", "confirmed"]
  );
  assert.equal(env.calls.length, 1);
});

test("a lost response keeps the id, and the retry reuses it", async () => {
  const { env, make } = harness();
  env.rows = [];
  env.sendImpl = () => Promise.reject(new TypeError("Failed to fetch"));
  const controller = make();
  controller.setDraft("Important");
  assert.equal((await controller.submit()).kind, "unconfirmed");
  let snap = controller.snapshot();
  assert.equal(snap.phase, "unconfirmed");
  assert.equal(snap.draft, "Important");
  assert.equal(snap.pending?.requestId, "id-1");

  env.sendImpl = (args) => Promise.resolve(reply(args.requestId));
  env.rows = [row("id-1")];
  await controller.submit();
  assert.deepEqual(
    env.calls.map((c) => c.requestId),
    ["id-1", "id-1"]
  );
  snap = controller.snapshot();
  assert.equal(snap.pending, null);
  assert.equal(snap.draft, "");
});

test("a timeout is unconfirmed, keeps the id and accepts a late answer", async () => {
  const { env, make } = harness();
  env.rows = [];
  let release: (value: any) => void = () => undefined;
  env.sendImpl = () => new Promise((resolve) => (release = resolve));
  const controller = make();
  controller.setDraft("Slow network");
  const attempt = controller.submit();
  assert.equal(env.timers.length, 1);
  assert.equal(env.timers[0]!.ms, 30_000);
  env.timers[0]!.fn(); // the clock runs out
  assert.equal((await attempt).kind, "unconfirmed");
  assert.equal(controller.snapshot().pending?.requestId, "id-1");
  assert.equal(env.calls.length, 1);

  env.rows = [row("id-1")];
  release(reply("id-1"));
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(controller.snapshot().pending, null);
  assert.equal(controller.snapshot().draft, "");
  assert.equal(
    env.calls.length,
    1,
    "the late answer never causes a second send"
  );
});

test("server errors are unconfirmed; client errors are definite", async () => {
  const { env, make } = harness();
  env.rows = [];
  const controller = make();
  controller.setDraft("Try");
  for (const status of [500, 502, 504, 408]) {
    env.sendImpl = () =>
      Promise.reject(Object.assign(new Error("x"), { status }));
    const outcome = await controller.submit();
    assert.equal(outcome.kind, "unconfirmed", String(status));
    assert.equal(controller.snapshot().pending?.requestId, "id-1");
  }
  assert.deepEqual([...new Set(env.calls.map((c) => c.requestId))], ["id-1"]);

  env.sendImpl = () =>
    Promise.reject(
      Object.assign(new Error("x"), {
        status: 417,
        messages: ["<div>The reply is too long.</div>", "<b>x</b>"],
      })
    );
  assert.equal((await controller.submit()).kind, "rejected");
  const snap = controller.snapshot();
  assert.equal(snap.pending, null);
  assert.equal(snap.draft, "Try");
  assert.deepEqual(snap.notice, {
    kind: "rejected",
    messages: ["The reply is too long.", "x"],
  });

  env.sendImpl = (args) => Promise.resolve(reply(args.requestId));
  env.rows = [row("id-2")];
  await controller.submit();
  assert.equal(
    env.calls.at(-1)!.requestId,
    "id-2",
    "a new logical submission has a new id"
  );
});

test("a blocked reply keeps the draft and the next attempt is a new request", async () => {
  const { env, make } = harness();
  env.rows = [];
  env.sendImpl = (args) =>
    Promise.resolve(
      reply(args.requestId, "Blocked", {
        ok: false,
        reason: "template_required",
      })
    );
  const controller = make();
  controller.setDraft("Outside the window");
  assert.deepEqual(await controller.submit(), {
    kind: "blocked",
    reason: "template_required",
  });
  let snap = controller.snapshot();
  assert.equal(snap.draft, "Outside the window");
  assert.equal(snap.pending, null);
  assert.equal(snap.notice?.kind, "blocked");
  assert.equal(env.stored?.draft, "Outside the window");

  env.sendImpl = (args) => Promise.resolve(reply(args.requestId));
  env.rows = [row("id-2")];
  await controller.submit();
  assert.deepEqual(
    env.calls.map((c) => c.requestId),
    ["id-1", "id-2"]
  );
  snap = controller.snapshot();
  assert.equal(snap.draft, "");
});

test("a conflict keeps the unresolved request id until explicit discard", async () => {
  const { env, make } = harness();
  env.sendImpl = (args) =>
    Promise.resolve(
      reply(args.requestId, "Conflict", {
        ok: false,
        reason: "request_key_conflict",
        message: null,
      })
    );
  const controller = make();
  controller.setDraft("Text");
  assert.equal((await controller.submit()).kind, "conflict");
  const snap = controller.snapshot();
  assert.equal(snap.pending?.requestId, "id-1");
  assert.equal(snap.phase, "unconfirmed");
  assert.equal(snap.draft, "Text");
  assert.equal(snap.notice?.kind, "conflict");
  controller.setDraft("Text!");
  assert.equal((await controller.submit()).kind, "needs_resolution");
  assert.equal(
    env.calls.length,
    1,
    "a conflict never creates a fresh UUID automatically"
  );
  controller.restorePendingText();
  assert.equal(controller.snapshot().draft, "Text");
  await controller.discardPending();
  assert.equal(controller.snapshot().pending, null);
});

test("a mismatched answer is treated as unconfirmed", async () => {
  const { env, make } = harness();
  env.rows = [];
  env.sendImpl = () => Promise.resolve(reply("someone-elses-id"));
  const controller = make();
  controller.setDraft("Text");
  assert.equal((await controller.submit()).kind, "unconfirmed");
  assert.equal(controller.snapshot().draft, "Text");
});

test("remounting never sends, and the unanswered id survives", async () => {
  const first = harness();
  first.env.rows = [];
  first.env.sendImpl = () => Promise.reject(new TypeError("offline"));
  const original = first.make();
  original.setDraft("Persisted");
  await original.submit();
  assert.equal(first.env.calls.length, 1);

  const second = harness({}, first.env.stored);
  second.env.rows = [];
  const remounted = second.make();
  assert.equal(second.env.calls.length, 0, "construction sends nothing");
  let snap = remounted.snapshot();
  assert.equal(snap.draft, "Persisted");
  assert.equal(snap.pending?.requestId, "id-1");
  assert.equal(snap.phase, "unconfirmed");

  assert.equal(remounted.observe([]), false);
  assert.equal(remounted.observe(null), false);
  assert.equal(second.env.calls.length, 0, "polling and observing never send");

  // The backend actually stored it.
  assert.equal(remounted.observe([row("id-1", "Accepted")] as any), true);
  snap = remounted.snapshot();
  assert.equal(snap.pending, null);
  assert.equal(snap.draft, "");
  assert.equal(second.env.calls.length, 0);
});

test("editing an unanswered request cannot start a second message", async () => {
  const { env, make } = harness();
  env.rows = [];
  env.sendImpl = () => Promise.reject(new TypeError("offline"));
  const controller = make();
  controller.setDraft("First wording");
  await controller.submit();
  controller.setDraft("Second wording");
  assert.deepEqual(await controller.submit(), { kind: "needs_resolution" });
  assert.equal(env.calls.length, 1);
  controller.restorePendingText();
  assert.equal(controller.snapshot().draft, "First wording");
});

test("discarding an unanswered request checks the backend first", async () => {
  const stored = harness();
  stored.env.rows = [];
  stored.env.sendImpl = () => Promise.reject(new TypeError("offline"));
  const a = stored.make();
  a.setDraft("Maybe stored");
  await a.submit();

  // The row exists after all: it is settled, not abandoned.
  stored.env.rows = [row("id-1", "Queued")];
  await a.discardPending();
  assert.equal(a.snapshot().pending, null);
  assert.equal(a.snapshot().draft, "", "settled like any accepted request");

  const b = harness();
  b.env.rows = [];
  b.env.sendImpl = () => Promise.reject(new TypeError("offline"));
  const c = b.make();
  c.setDraft("Never arrived");
  await c.submit();
  await c.discardPending();
  assert.equal(c.snapshot().pending, null);
  assert.equal(c.snapshot().draft, "Never arrived");
  assert.equal(b.env.calls.length, 1);
});

test("an acknowledged request is never posted again", async () => {
  const { env, make } = harness();
  env.rows = [];
  const controller = make();
  controller.setDraft("Saved");
  await controller.submit();
  assert.equal(controller.snapshot().phase, "confirming");
  env.rows = [];
  assert.equal((await controller.submit()).kind, "saved");
  assert.equal(env.calls.length, 1);
});

test("an empty media caption is not replaced by the file name", async () => {
  const { env, make } = harness();
  env.rows = [];
  const controller = make();
  const outcome = await controller.submitFile("70d7c1f276", "");
  assert.equal(outcome.kind, "saved");
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0]!.message, "");
  assert.equal(env.calls[0]!.file, "70d7c1f276");
  assert.equal(controller.snapshot().pending?.message, "");
});

test("a media caption is sent exactly, including a hexadecimal string", async () => {
  const { env, make } = harness();
  env.rows = [];
  const controller = make();
  controller.setDraft("70d7c1f276");
  await controller.submitFile("8bf938bf57", "70d7c1f276");
  assert.equal(env.calls[0]!.message, "70d7c1f276");
  assert.equal(env.calls[0]!.file, "8bf938bf57");
});

test("a second media submit joins the in-flight request", async () => {
  const { env, make } = harness();
  env.rows = [];
  let release: (value: ReturnType<typeof reply>) => void = () => undefined;
  env.sendImpl = (args) =>
    new Promise((resolve) => {
      release = () => resolve(reply(args.requestId, "Queued", { message: "" }));
    });
  const controller = make();
  const first = controller.submitFile("70d7c1f276", "");
  const second = controller.submitFile("other-file", "other caption");
  assert.equal(env.calls.length, 1);
  assert.equal(env.calls[0]!.file, "70d7c1f276");
  assert.equal(env.calls[0]!.message, "");
  release(reply("id-1"));
  const [a, b] = await Promise.all([first, second]);
  assert.equal(a.kind, b.kind);
  assert.equal(env.calls.length, 1);
});

test("a lost media response retries the same file and caption", async () => {
  const { env, make } = harness();
  env.rows = [];
  env.sendImpl = () => Promise.reject(new TypeError("offline"));
  const controller = make();
  controller.setDraft("");
  assert.equal(
    (await controller.submitFile("70d7c1f276", "")).kind,
    "unconfirmed"
  );
  assert.equal(env.calls.length, 1);
  env.sendImpl = (args) =>
    Promise.resolve(reply(args.requestId, "Queued", { message: "" }));
  assert.equal((await controller.submit()).kind, "saved");
  assert.equal(env.calls.length, 2);
  assert.equal(env.calls[1]!.requestId, env.calls[0]!.requestId);
  assert.equal(env.calls[1]!.file, "70d7c1f276");
  assert.equal(env.calls[1]!.message, "");
});

test("remounting a media request does not send", async () => {
  const first = harness();
  first.env.rows = [];
  first.env.sendImpl = () => Promise.reject(new TypeError("offline"));
  const original = first.make();
  await original.submitFile("70d7c1f276", "roof");
  const second = harness({}, first.env.stored);
  second.env.rows = [];
  const remounted = second.make();
  assert.equal(second.env.calls.length, 0);
  assert.equal(remounted.snapshot().pending?.file, "70d7c1f276");
  assert.equal(remounted.snapshot().pending?.message, "roof");
  assert.equal(remounted.observe([]), false);
  assert.equal(second.env.calls.length, 0);
});

test("the persisted draft expires and stays scoped by its storage", () => {
  const stale = {
    draft: "old",
    pending: null,
    savedAt: 1_000_000 - DRAFT_MAX_AGE_MS - 1,
  };
  const { env, make } = harness({}, stale);
  const controller = make();
  assert.equal(controller.snapshot().draft, "");
  assert.equal(env.stored, null);

  const fresh = harness(
    {},
    { draft: "mine", pending: null, savedAt: 1_000_000 }
  );
  assert.equal(fresh.make().snapshot().draft, "mine");
});
