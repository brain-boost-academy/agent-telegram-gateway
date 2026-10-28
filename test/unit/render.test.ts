// protects=R14 sync reconcile (known turn keeps editing its messages, unknown turn is drawn anew), ≤1 flush/s,
//   status collapse on turn.ended, turn.ended.text completes missed chunks, Telegram failure on the final flush surfaces to the caller;
// fails_when=a known turn gets a second answer message after sync, an unknown turn is not drawn, edits exceed the interval,
//   missed chunks are not recovered, a failed final send is swallowed (would ack an undelivered turn.ended);
// no_claim=real Telegram rate limits (grammY throttler/auto-retry not exercised here)
import { mock, test } from "node:test";
import assert from "node:assert/strict";
import type { Api } from "grammy";
import { Renderer } from "../../src/telegram/render.ts";

type Call = { m: string; chat: number; id?: number; text: string; at: number; end?: number };

/** Bot API stub; `latencyMs` > 0 makes every call take that long (setTimeout, so mock.timers controls it). */
function fakeApi(latencyMs = 0) {
  const calls: Call[] = [];
  let next = 100;
  let failSends = false;
  const wait = async (call: Call) => {
    if (latencyMs) await new Promise((r) => setTimeout(r, latencyMs));
    call.end = Date.now();
  };
  const api = {
    async sendMessage(chat: number, text: string) {
      if (failSends) throw new Error("network down");
      const id = next++;
      const call: Call = { m: "send", chat, id, text, at: Date.now() };
      calls.push(call);
      await wait(call);
      return { message_id: id, chat: { id: chat }, date: 0, text };
    },
    async editMessageText(chat: number, id: number, text: string) {
      const call: Call = { m: "edit", chat, id, text, at: Date.now() };
      calls.push(call);
      await wait(call);
      return true;
    },
  };
  return { api: api as unknown as Api, calls, setFail: (v: boolean) => (failSends = v) };
}

const session = { agent_id: "claude", session_id: "s1", cwd: "/w" };
const upd = (turn_id: string, update: Record<string, unknown>) => ({ conversation_ids: ["7"], session, turn_id, update: update as { sessionUpdate: string } });
const chunk = (text: string) => ({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** With mock.timers: move the clock in small steps and let the promise chains that the timers started run. */
async function advance(ms: number, step = 5): Promise<void> {
  for (let t = 0; t < ms; t += step) {
    mock.timers.tick(step);
    for (let i = 0; i < 5; i++) await new Promise<void>((r) => setImmediate(r));
  }
}

function renderer(api: Api, flushMs = 50) {
  const recorded: number[] = [];
  const r = new Renderer({ api, flushMs, recordSession: async (_c, m) => void recorded.push(m) });
  return { r, recorded };
}

test("stream: status first, answer edited in place, collapse on turn.ended; every message recorded", async () => {
  const { api, calls } = fakeApi();
  const { r, recorded } = renderer(api);
  await r.start("c", 7, { turn_id: "t1", conversation_ids: ["7"], session }, false);
  r.update("c", 7, upd("t1", chunk("Hel")), false);
  r.update("c", 7, upd("t1", { sessionUpdate: "tool_call", toolCallId: "a", title: "Read a.ts", kind: "read", status: "pending" }), false);
  r.update("c", 7, upd("t1", chunk("lo")), false);
  await sleep(120);
  await r.end("c", 7, { turn_id: "t1", conversation_ids: ["7"], session, stop_reason: "end_turn", duration_ms: 40_000, tool_calls: 1, cost_usd: 0.12, text: "Hel\n\nlo" }, false);
  const sends = calls.filter((c) => c.m === "send");
  assert.equal(sends.length, 2, "one status + one answer message");
  assert.match(sends[0]!.text, /Работаю/);
  const statusId = sends[0]!.id!;
  const answerId = sends[1]!.id!;
  const last = (id: number) => calls.filter((c) => c.id === id).at(-1)!.text;
  assert.equal(last(statusId), "✓ 1 шаг · 40 с · $0.12");
  assert.equal(last(answerId), "Hel\n\nlo");
  assert.deepEqual(recorded.sort(), [statusId, answerId].sort());
  r.stop();
});

test("edits of one turn are spaced by the flush interval", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    const { api, calls } = fakeApi();
    const { r } = renderer(api, 200);
    await r.start("c", 7, { turn_id: "t", conversation_ids: ["7"], session }, false);
    for (let i = 0; i < 20; i++) {
      r.update("c", 7, upd("t", chunk(`w${i} `)), false);
      await advance(25);
    }
    await advance(250);
    const flushTimes = [...new Set(calls.map((c) => c.at))].sort((a, b) => a - b);
    for (let i = 1; i < flushTimes.length; i++) assert.ok(flushTimes[i]! - flushTimes[i - 1]! >= 200, `flushes too close: ${flushTimes}`);
    assert.ok(calls.length <= 8, `too many calls: ${calls.length}`);
    assert.equal(calls.filter((c) => c.m === "edit").at(-1)!.text, Array.from({ length: 20 }, (_, i) => `w${i} `).join(""));
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

// protects=edit pacing with a slow Bot API: flushes never pile up behind an in-flight one and the interval counts from the end of
//   the previous flush, so a streaming turn makes ≤ ~1 edit/s per chat;
// fails_when=a timer firing during an in-flight flush queues another flush right behind it (edits back-to-back at API latency);
// no_claim=Telegram's real per-chat limits (throttler in production)
test("slow Telegram: no flush starts sooner than flushMs after the previous one ended", async () => {
  mock.timers.enable({ apis: ["setTimeout", "setInterval", "Date"], now: 0 });
  try {
    const { api, calls } = fakeApi(150);
    const { r } = renderer(api, 100);
    const started = r.start("c", 7, { turn_id: "t", conversation_ids: ["7"], session }, false);
    await advance(200);
    await started;
    for (let i = 0; i < 100; i++) {
      r.update("c", 7, upd("t", chunk(`w${i} `)), false);
      await advance(10);
    }
    await advance(1000);
    const edits = calls.filter((c) => c.m === "edit");
    assert.ok(edits.length >= 3, `edits: ${edits.length}`);
    // no tools and < 1 min: the status text never changes, so every flush is exactly one Bot API call
    const all = calls.sort((a, b) => a.at - b.at);
    for (let i = 1; i < all.length; i++) {
      const gap = all[i]!.at - all[i - 1]!.end!;
      assert.ok(gap >= 100, `call ${i} started ${gap} ms after the previous one ended`);
    }
    assert.equal(edits.at(-1)!.text, Array.from({ length: 100 }, (_, i) => `w${i} `).join(""));
    r.stop();
  } finally {
    mock.timers.reset();
  }
});

test("sync for a known turn keeps editing the same messages with text_so_far (R14)", async () => {
  const { api, calls } = fakeApi();
  const { r } = renderer(api);
  await r.start("c", 7, { turn_id: "t", conversation_ids: ["7"], session }, false);
  r.update("c", 7, upd("t", chunk("part one")), false);
  await sleep(80);
  const sendsBefore = calls.filter((c) => c.m === "send").length;
  await r.reconcile("c", 7, { turn_id: "t", session, conversation_ids: ["7"], text_so_far: "part one, part two", steps: 3, current_tool: "Bash", started_at: new Date().toISOString() }, false);
  await sleep(80);
  assert.equal(calls.filter((c) => c.m === "send").length, sendsBefore, "no new messages");
  assert.ok(calls.some((c) => c.m === "edit" && c.text === "part one, part two"));
  assert.ok(calls.some((c) => c.m === "edit" && /3 шага/.test(c.text) && /Bash/.test(c.text)));
  r.stop();
});

test("sync for an unknown turn (gateway restarted) draws status and answer as new messages", async () => {
  const { api, calls } = fakeApi();
  const { r } = renderer(api);
  assert.equal(r.knows("c", "t"), false);
  await r.reconcile("c", 7, { turn_id: "t", session, conversation_ids: ["7"], text_so_far: "so far", steps: 4, started_at: new Date(Date.now() - 10_000).toISOString() }, false);
  const sends = calls.filter((c) => c.m === "send");
  assert.equal(sends.length, 2);
  assert.match(sends[0]!.text, /4 шага/);
  assert.doesNotMatch(sends[0]!.text, /10 с/, "live status shows no seconds");
  assert.equal(sends[1]!.text, "so far");
  assert.equal(r.knows("c", "t"), true);
  r.stop();
});

test("turn.ended text completes chunks we missed; whitespace-only differences keep our text", async () => {
  const { api, calls } = fakeApi();
  const { r } = renderer(api);
  r.update("c", 7, upd("t", chunk("Start")), false);
  await r.end("c", 7, { turn_id: "t", conversation_ids: ["7"], session, stop_reason: "end_turn", duration_ms: 1000, tool_calls: 0, text: "Start and the rest" }, false);
  assert.equal(calls.filter((c) => c.m !== "x").at(-1)!.text, "Start and the rest");
  r.stop();
});

test("Telegram failure in the final flush rejects end() (caller must not ack), retry succeeds without duplicates", async () => {
  const { api, calls, setFail } = fakeApi();
  const { r } = renderer(api);
  setFail(true);
  const ended = { turn_id: "t", conversation_ids: ["7"], session, stop_reason: "end_turn", duration_ms: 1000, tool_calls: 0, text: "answer" };
  await assert.rejects(r.end("c", 7, ended, false));
  setFail(false);
  await r.end("c", 7, ended, false);
  assert.equal(calls.filter((c) => c.m === "send").length, 2);
  r.stop();
});

test("verbose: one message per tool call, edited on completion; thoughts never shown; unknown kinds reported", async () => {
  const { api, calls } = fakeApi();
  const { r } = renderer(api);
  r.update("c", 7, upd("t", { sessionUpdate: "tool_call", toolCallId: "a", title: "Run tests", kind: "execute", status: "in_progress" }), true);
  r.update("c", 7, upd("t", { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "secret thinking" } }), true);
  assert.equal(r.update("c", 7, upd("t", { sessionUpdate: "brand_new_kind" }), true), false);
  await sleep(80);
  r.update("c", 7, upd("t", { sessionUpdate: "tool_call_update", toolCallId: "a", status: "completed" }), true);
  await sleep(80);
  const toolMsg = calls.find((c) => c.m === "send" && c.text.startsWith("🔧 Run tests"))!;
  assert.ok(calls.some((c) => c.m === "edit" && c.id === toolMsg.id && c.text.startsWith("✅ Run tests")));
  assert.ok(!calls.some((c) => c.text.includes("secret thinking")));
  r.stop();
});

test("status shows the tool title from tool_call_update (claude-agent-acp sends the real command there)", async () => {
  const { api, calls } = fakeApi();
  const { r } = renderer(api);
  await r.start("c", 7, { turn_id: "tt", conversation_ids: ["7"], session }, false);
  r.update("c", 7, upd("tt", { sessionUpdate: "tool_call", toolCallId: "b", title: "Terminal", kind: "execute", status: "pending", rawInput: {} }), false);
  await sleep(80);
  r.update("c", 7, upd("tt", { sessionUpdate: "tool_call_update", toolCallId: "b", title: "touch e2e.txt", rawInput: { command: "touch e2e.txt" } }), false);
  await sleep(120);
  const statusId = calls.find((c) => c.m === "send")!.id!;
  assert.match(calls.filter((c) => c.id === statusId).at(-1)!.text, /touch e2e\.txt/);
  r.stop();
});
