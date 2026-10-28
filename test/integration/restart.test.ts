// protects=AC13 / R2 / R14 / R15: gateway restart mid-turn → sync redraws the running turn as new messages, pending permission and
//   elicitation are not shown again but their old buttons still work, an unfinished form resumes at its first unanswered field,
//   an already delivered notify/turn.ended resent by the connector is not shown twice; a reconnect WITHOUT restart keeps editing
//   the same messages;
// fails_when=any durable message appears twice, old buttons are dead after restart, a reconnect without restart duplicates the answer,
//   the form answer after restart misses or duplicates fields;
// no_claim=a crash exactly between the Telegram send and the `delivered` insert (accepted duplicate, R9)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, type TestDb } from "../helpers/db.ts";
import {
  callbackUpdate,
  FakeConnector,
  FakeTelegram,
  makeConnector,
  OWNER,
  SESSION,
  startGateway,
  until,
  type Harness,
} from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;
const tg = new FakeTelegram();
let token: string;

before(async () => {
  db = await freshDb();
  h = await startGateway(db, { tg });
  token = (await makeConnector(db.repo, "af30", OWNER)).token;
});
after(async () => {
  await h?.stop();
  await db?.drop();
});

const chat = String(OWNER.id);
const permission = {
  request_id: "p1",
  conversation_ids: [chat],
  session: SESSION,
  params: {
    toolCall: { toolCallId: "tc", title: "Bash" },
    options: [
      { optionId: "allow-once", name: "Yes", kind: "allow_once" },
      { optionId: "reject", name: "No", kind: "reject_once" },
    ],
  },
};
const opts = (xs: string[]) => xs.map((x) => ({ const: x, title: x }));
const elicitation = {
  request_id: "e1",
  conversation_ids: [chat],
  session: SESSION,
  params: {
    mode: "form",
    message: "Два вопроса",
    requestedSchema: {
      properties: {
        question_0: { type: "string", title: "Цвет", oneOf: opts(["Red", "Blue"]) },
        question_1: { type: "string", title: "Размер", oneOf: opts(["S", "L"]) },
      },
    },
  },
};
const sends = (re: RegExp) => tg.of("sendMessage").filter((c) => !c.failed && re.test(String(c.payload.text))).length;
const chunk = (c: FakeConnector, text: string) =>
  c.send("session.update", { conversation_ids: [chat], session: SESSION, turn_id: "t1", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });

test("reconnect without restart: sync for a known turn keeps editing the same messages (R14)", async () => {
  const c = await FakeConnector.connect(h.wsUrl, token);
  c.send("turn.started", { turn_id: "t0", conversation_ids: [chat], session: SESSION });
  c.send("session.update", { conversation_ids: [chat], session: SESSION, turn_id: "t0", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Первая часть" } } });
  await until(() => sends(/^Первая часть$/) === 1, "answer");
  await c.close();
  const c2 = await FakeConnector.connect(h.wsUrl, token, {
    sync: {
      conversations: [],
      running_turns: [{ turn_id: "t0", session: SESSION, conversation_ids: [chat], text_so_far: "Первая часть и вторая", steps: 1, started_at: new Date().toISOString() }],
      pending: [],
    },
  });
  await until(() => tg.of("editMessageText").some((x) => x.payload.text === "Первая часть и вторая"), "edit with text_so_far");
  assert.equal(sends(/Первая часть/), 1, "no second answer message");
  assert.equal(sends(/Работаю/), 1, "no second status message");
  c2.send("turn.ended", { turn_id: "t0", conversation_ids: [chat], session: SESSION, stop_reason: "end_turn", duration_ms: 1000, tool_calls: 1, text: "Первая часть и вторая" });
  await c2.waitFor("delivered");
  await c2.close();
});

test("gateway restart mid-turn (AC13)", async () => {
  // counts below start at this mark, so the test does not depend on what earlier tests sent
  const mark = tg.calls.length;
  const sendsHere = (re: RegExp) => tg.calls.slice(mark).filter((x) => x.method === "sendMessage" && !x.failed && re.test(String(x.payload.text))).length;
  // ---- before the restart ----
  let c = await FakeConnector.connect(h.wsUrl, token);
  c.send("turn.started", { turn_id: "t1", conversation_ids: [chat], session: SESSION });
  chunk(c, "Начало ответа");
  c.send("permission.request", permission);
  c.send("elicitation.request", elicitation);
  c.send("notify", { notify_id: "n1", text: "Уведомление", switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:n1");
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e1");
  await until(() => sendsHere(/^Начало ответа$/) === 1, "answer before restart");
  const permButtons = tg.buttons(/Разрешить\?/);
  const field0 = tg.buttons(/Два вопроса/);
  // answer field 0 → the message now shows field 1
  await h.feed(callbackUpdate(OWNER, field0[0]!.data, tg.messageId(/Два вопроса/)));
  const field1 = tg.buttons(/Размер/);
  assert.deepEqual(field1.map((b) => b.text), ["S", "L", "Отмена"]);

  // ---- restart ----
  await h.stop();
  await c.closed();
  h = await startGateway(db, { tg });
  const callsAtRestart = tg.calls.length;
  c = await FakeConnector.connect(h.wsUrl, token, {
    sync: {
      conversations: [{ conversation_id: chat, session: SESSION, agent_id: "claude", busy: true, queue_length: 0 }],
      running_turns: [{ turn_id: "t1", session: SESSION, conversation_ids: [chat], text_so_far: "Начало ответа, продолжение", steps: 2, current_tool: "Bash", started_at: new Date(Date.now() - 5000).toISOString() }],
      pending: [{ kind: "permission", ...permission }, { kind: "elicitation", ...elicitation }],
    },
  });
  // the connector also resends durable messages it has no ack for (here: ack lost) → deduped
  c.send("permission.request", permission);
  c.send("notify", { notify_id: "n1", text: "Уведомление", switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:n1");
  await until(() => c.received("delivered", (p: { id: string }) => p.id === "req:p1").length >= 1, "pending acked");

  // the running turn is redrawn as new messages from the snapshot
  await until(() => sendsHere(/^Начало ответа, продолжение$/) === 1, "answer redrawn");
  assert.equal(sendsHere(/Работаю/), 2, "t1 before restart + t1 redrawn");
  // durable messages were not shown again
  assert.equal(sendsHere(/Разрешить\?/), 1);
  assert.equal(sendsHere(/Два вопроса/), 1);
  assert.equal(sendsHere(/^Уведомление$/), 1);

  // old permission button works through the new process
  await h.feed(callbackUpdate(OWNER, permButtons[0]!.data, tg.messageId(/Разрешить\?/)));
  const resp = await c.waitFor("permission.respond");
  assert.deepEqual(resp.payload, { request_id: "p1", outcome: { outcome: "selected", optionId: "allow-once" } });

  // form progress was in memory: an old field-1 button brings the form back to its first unanswered field
  const formMsg = tg.messageId(/Два вопроса/);
  await h.feed(callbackUpdate(OWNER, field1[1]!.data, formMsg));
  assert.match(String(tg.of("answerCallbackQuery").at(-1)!.payload.text), /первого неотвеченного/);
  const again0 = tg.buttons(/Цвет/);
  assert.deepEqual(again0.map((b) => b.text), ["Red", "Blue", "Отмена"]);
  await h.feed(callbackUpdate(OWNER, again0[1]!.data, formMsg));
  await h.feed(callbackUpdate(OWNER, tg.buttons(/Размер/)[1]!.data, formMsg));
  const r = await c.waitFor("elicitation.respond");
  assert.deepEqual(r.payload, { request_id: "e1", action: "accept", content: { question_0: "Blue", question_1: "L" } });

  // the turn finishes in the redrawn messages
  chunk(c, ". Конец.");
  c.send("turn.ended", { turn_id: "t1", conversation_ids: [chat], session: SESSION, stop_reason: "end_turn", duration_ms: 9000, tool_calls: 3, text: "Начало ответа, продолжение. Конец." });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "turn:t1");
  const after = tg.calls.slice(callsAtRestart);
  assert.ok(after.some((x) => x.method === "editMessageText" && x.payload.text === "✓ 3 шага · 9 с"));
  assert.ok(after.some((x) => x.payload.text === "Начало ответа, продолжение. Конец."));
  await c.close();
});
