// protects=Flow 2 text → conversation.prompt (conversation_id = chat id) → streamed answer + live status collapsing to «✓ N шагов · …»,
//   queue position, reply → session of that message, offline connector message, R2/R9 durable delivery (dedupe + ack only after Telegram success);
// fails_when=prompt goes to the wrong conversation, answer is not edited in place, status not collapsed, duplicate turn.ended renders twice,
//   a Telegram failure is acked or recorded in `delivered`, notify for an unpaired connector is not rejected with not_paired;
// no_claim=Telegram rate limiting, real agent output
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { FakeConnector, makeConnector, OWNER, SESSION, sleep, startGateway, textUpdate, until, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;
let c: FakeConnector;
let cid: string;

before(async () => {
  db = await freshDb();
  h = await startGateway(db);
  const k = await makeConnector(db.repo, "af10", OWNER);
  cid = k.id;
  c = await FakeConnector.connect(h.wsUrl, k.token);
});
after(async () => {
  await c?.close();
  await h?.stop();
  await db?.drop();
});

const chat = String(OWNER.id);
const upd = (turn_id: string, update: Record<string, unknown>) =>
  c.send("session.update", { conversation_ids: [chat], session: SESSION, turn_id, update: update as { sessionUpdate: string } });
const ended = (turn_id: string, text: string) => ({ turn_id, conversation_ids: [chat], session: SESSION, stop_reason: "end_turn", duration_ms: 40_000, tool_calls: 2, cost_usd: 0.12, text });
const lastEdit = (messageId: number) =>
  String([...h.tg.calls].reverse().find((x) => (x.method === "editMessageText" && x.payload.message_id === messageId) || x.messageId === messageId)?.payload.text);

test("text → prompt → streamed answer + status → collapse; durable ack after Telegram", async () => {
  await h.feed(textUpdate(OWNER, "что в календаре?"));
  const prompt = await c.waitFor("conversation.prompt");
  assert.deepEqual(prompt.payload, { conversation_id: chat, text: "что в календаре?", origin: "text" });

  c.send("turn.started", { turn_id: "t1", conversation_ids: [chat], session: SESSION, origin: "text" });
  await until(() => h.tg.texts(OWNER.id).some((t) => t.includes("Работаю")), "status message");
  upd("t1", { sessionUpdate: "tool_call", toolCallId: "a", title: "Read calendar.ics", kind: "read", status: "in_progress" });
  upd("t1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Завтра **встреча**" } });
  await until(() => h.tg.texts(OWNER.id).includes("Завтра <b>встреча</b>"), "answer message");
  upd("t1", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " в 10:00." } });
  upd("t1", { sessionUpdate: "tool_call", toolCallId: "b", title: "Bash", kind: "execute", status: "pending" });
  const statusId = h.tg.messageId(/Работаю/);
  const answerId = h.tg.messageId(/Завтра/);
  await until(() => lastEdit(answerId) === "Завтра <b>встреча</b> в 10:00.", "answer edited in place");
  await until(() => /2 шага/.test(lastEdit(statusId)) && /Bash/.test(lastEdit(statusId)), "status shows tool + steps");

  c.send("turn.ended", ended("t1", "Завтра **встреча** в 10:00."));
  const ack = await c.waitFor("delivered");
  assert.deepEqual(ack.payload, { id: "turn:t1" });
  assert.equal(lastEdit(statusId), "✓ 2 шага · 40 с · $0.12");
  assert.equal(h.tg.texts(OWNER.id).filter((t) => t.startsWith("Завтра")).length, 1, "answer is one message");
  assert.ok(await db.repo.isDelivered(cid, "turn:t1"));
  // every agent message is mapped to its session
  assert.deepEqual(await db.repo.messageSession(OWNER.id, answerId), { connector_id: cid, ...SESSION });

  // the same durable message again → no new Telegram call, ack again
  const before = h.tg.calls.length;
  c.send("turn.ended", ended("t1", "Завтра **встреча** в 10:00."));
  await until(() => c.received("delivered").length === 2, "second ack");
  assert.equal(h.tg.calls.length, before);
});

test("queued prompt shows its position; reply to an agent message targets that session", async () => {
  c.handlers["conversation.prompt"] = () => ({ session: SESSION, queued_position: 2 });
  const answerId = h.tg.messageId(/Завтра/);
  await h.feed(textUpdate(OWNER, "и ещё", answerId));
  const p = c.received("conversation.prompt").at(-1)!;
  assert.deepEqual((p.payload as { session?: unknown }).session, SESSION);
  assert.equal(h.tg.texts(OWNER.id).at(-1), "⏳ в очереди: 2");
  c.handlers["conversation.prompt"] = () => ({ session: SESSION, queued_position: 0 });
});

test("prompt queued behind a run outside the connector says the agent works in the background (Flow 9)", async () => {
  c.handlers["conversation.prompt"] = () => ({ session: SESSION, queued_position: 1, waiting_foreign: true });
  await h.feed(textUpdate(OWNER, "что там со сводкой?"));
  await until(() => h.tg.texts(OWNER.id).at(-1) === "⏳ агент ещё работает в фоне, отправлю, когда закончит", "foreign wait text");
  c.handlers["conversation.prompt"] = () => ({ session: SESSION, queued_position: 0 });
});

test("Telegram failure while showing a notify → no delivered row, no ack; the resend is delivered once", async () => {
  h.tg.failNext("sendMessage", 1, 429, "Too Many Requests: retry later");
  c.send("notify", { notify_id: "n1", text: "Утренняя сводка", switched: false });
  await until(() => h.tg.of("sendMessage").some((x) => x.failed), "failed send");
  await sleep(100);
  assert.equal(await db.repo.isDelivered(cid, "notify:n1"), false);
  assert.equal(c.received("delivered", (p: { id: string }) => p.id === "notify:n1").length, 0);

  c.send("notify", { notify_id: "n1", text: "Утренняя сводка", switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:n1");
  assert.ok(await db.repo.isDelivered(cid, "notify:n1"));
  c.send("notify", { notify_id: "n1", text: "Утренняя сводка", switched: false });
  await until(() => c.received("delivered", (p: { id: string }) => p.id === "notify:n1").length === 2, "dedupe ack");
  assert.equal(h.tg.of("sendMessage").filter((x) => x.payload.text === "Утренняя сводка" && !x.failed).length, 1);
});

test("notify with a session is reply-able: reply goes to that session; switched hint shown", async () => {
  const other = { ...SESSION, session_id: "timer-session" };
  c.send("notify", { notify_id: "n2", session: other, text: "Сводка от таймера", switched: true });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:n2");
  const id = h.tg.messageId(/Сводка от таймера/);
  assert.match(h.tg.texts(OWNER.id).find((t) => t.startsWith("Сводка от таймера"))!, /чат переключён/);
  await h.feed(textUpdate(OWNER, "подробнее", id));
  assert.deepEqual((c.received("conversation.prompt").at(-1)!.payload as { session?: unknown }).session, other);
});

test("turn.error is shown in the status message", async () => {
  c.send("turn.started", { turn_id: "t2", conversation_ids: [chat], session: SESSION });
  await until(() => h.tg.texts(OWNER.id).filter((t) => t.includes("Работаю")).length === 2, "status 2");
  c.send("turn.error", { turn_id: "t2", conversation_ids: [chat], session: SESSION, message: "agent crashed" });
  const statusId = h.tg.messageId(/Работаю/);
  await until(() => /❌ ошибка[\s\S]*agent crashed/.test(lastEdit(statusId)), "error status");
});

test("unknown session.update kinds are ignored without breaking the stream", async () => {
  upd("t3", { sessionUpdate: "some_future_kind", foo: 1 });
  upd("t3", { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still works" } });
  await until(() => h.tg.texts(OWNER.id).includes("still works"), "chunk after unknown kind");
});

test("connector offline → «🔌 агент не в сети», nothing sent", async () => {
  const k = await makeConnector(db.repo, "offline-one", { id: 7001, username: "lonely" });
  void k;
  await h.feed(textUpdate({ id: 7001 }, "hello?"));
  assert.equal(h.tg.texts(7001).at(-1), "🔌 агент не в сети");
});

test("durable message while unpaired → error not_paired, nothing recorded", async () => {
  const k = await makeConnector(db.repo, "nobody");
  const c2 = await FakeConnector.connect(h.wsUrl, k.token);
  const env = c2.send("notify", { notify_id: "n9", text: "hi", switched: false });
  const err = await c2.waitFor("error");
  assert.equal(err.re, env.id);
  assert.equal((err.payload as { code: string }).code, "not_paired");
  assert.equal(await db.repo.isDelivered(k.id, "notify:n9"), false);
  await c2.close();
});
