// protects=Flow 5 permission buttons round-trip (ACP outcome back to the connector, message edited into the outcome, permission.resolved
//   from elsewhere), Flow 6/R6 elicitation: option buttons, «Свой вариант» arming → next text/voice is the answer, /command disarms,
//   unarmed text stays a prompt, «Отмена» → cancel, elicitation.resolved clears the form; callback_data ≤ 64 bytes (R15);
// fails_when=wrong optionId/outcome is sent, buttons keep working after the request closed, the custom answer is sent under the wrong key,
//   an unarmed message is taken as an answer, a /command while armed becomes the answer;
// no_claim=how real adapters map the answers back to tool results (connector side)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { callbackUpdate, FakeConnector, makeConnector, OWNER, SESSION, startGateway, textUpdate, until, voiceUpdate, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;
let c: FakeConnector;

before(async () => {
  db = await freshDb();
  h = await startGateway(db);
  const k = await makeConnector(db.repo, "af20", OWNER);
  c = await FakeConnector.connect(h.wsUrl, k.token);
});
after(async () => {
  await c?.close();
  await h?.stop();
  await db?.drop();
});

const chat = String(OWNER.id);
const OPTIONS = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-always", name: "Always", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
];
const permission = (request_id: string) => ({
  request_id,
  conversation_ids: [chat],
  session: SESSION,
  params: { sessionId: "sess-1", toolCall: { toolCallId: "tc", title: "Bash", rawInput: { command: "rm -rf build" } }, options: OPTIONS },
});
export const QUESTION = {
  mode: "form",
  message: "Какой цвет?",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: { type: "string", title: "Цвет", oneOf: [{ const: "Red", title: "Red" }, { const: "Green", title: "Green" }, { const: "Blue", title: "Blue" }] },
      question_0_custom: { type: "string", title: "Other" },
    },
  },
};
const elicitation = (request_id: string, params: Record<string, unknown> = QUESTION) => ({ request_id, conversation_ids: [chat], session: SESSION, params: params as { mode: string; message: string } });
const lastText = () => h.tg.allTexts(OWNER.id).at(-1);

test("permission: buttons from ACP options; «Всегда» → permission.respond with that optionId; message edited; old button then closed", async () => {
  c.send("permission.request", permission("p1"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:p1");
  const btns = h.tg.buttons(/Разрешить\?/);
  assert.deepEqual(btns.map((b) => b.text), ["Разрешить", "Всегда", "Запретить"]);
  for (const b of btns) assert.ok(Buffer.byteLength(b.data) <= 64);
  assert.match(h.tg.texts(OWNER.id).at(-1)!, /<pre>rm -rf build<\/pre>/);
  await h.feed(callbackUpdate(OWNER, btns[1]!.data, h.tg.messageId(/Разрешить\?/)));
  const resp = await c.waitFor("permission.respond");
  assert.deepEqual(resp.payload, { request_id: "p1", outcome: { outcome: "selected", optionId: "allow-always" } });
  assert.equal(lastText(), "🔐 <b>Bash</b>\n✅ Разрешено всегда");
  // pressing again: request is closed, no second respond
  await h.feed(callbackUpdate(OWNER, btns[0]!.data));
  assert.equal(c.received("permission.respond").length, 1);
  assert.equal(h.tg.of("answerCallbackQuery").at(-1)!.payload.text, "Запрос уже закрыт");
});

test("permission.resolved elsewhere / by timeout edits the message", async () => {
  c.send("permission.request", permission("p2"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:p2");
  c.send("permission.resolved", { request_id: "p2", by: "user", outcome: { outcome: "selected", optionId: "reject" } });
  await until(() => lastText() === "🔐 <b>Bash</b>\n❌ Запрещено (в другом окне)", "resolved edit");
  c.send("permission.request", permission("p3"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:p3");
  c.send("permission.resolved", { request_id: "p3", by: "timeout" });
  await until(() => lastText() === "🔐 <b>Bash</b>\n⌛ Время ожидания истекло", "timeout edit");
});

test("elicitation: 3 options → 3 buttons; option click → accept {question_0: 'Green'}; message becomes the summary", async () => {
  c.send("elicitation.request", elicitation("e1"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e1");
  const btns = h.tg.buttons(/Какой цвет/);
  assert.deepEqual(btns.map((b) => b.text), ["Red", "Green", "Blue", "✍️ Свой вариант", "Отмена"]);
  await h.feed(callbackUpdate(OWNER, btns[1]!.data, h.tg.messageId(/Какой цвет/)));
  const r = await c.waitFor("elicitation.respond", (p: { request_id: string }) => p.request_id === "e1");
  assert.deepEqual(r.payload, { request_id: "e1", action: "accept", content: { question_0: "Green" } });
  assert.equal(lastText(), "❓ Какой цвет?\n• Цвет: Green\n✅ Ответ отправлен");
});

test("«Свой вариант»: click arms, the next text is the answer under question_0_custom", async () => {
  c.send("elicitation.request", elicitation("e2"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e2");
  const custom = h.tg.buttons(/Какой цвет/).find((b) => b.text === "✍️ Свой вариант")!;
  await h.feed(callbackUpdate(OWNER, custom.data));
  assert.match(lastText()!, /Напишите ответ одним сообщением/);
  await h.feed(textUpdate(OWNER, "Фиолетовый"));
  const r = await c.waitFor("elicitation.respond", (p: { request_id: string }) => p.request_id === "e2");
  assert.deepEqual(r.payload, { request_id: "e2", action: "accept", content: { question_0_custom: "Фиолетовый" } });
  assert.equal(c.received("conversation.prompt").length, 0, "the answer is not a prompt");
  assert.equal(h.app.gw.arming.get(OWNER.id), undefined);
});

test("armed + /command → disarmed, command runs; next text is a normal prompt", async () => {
  c.send("elicitation.request", elicitation("e3"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e3");
  const custom = h.tg.buttons(/Какой цвет/).find((b) => b.text === "✍️ Свой вариант")!;
  await h.feed(callbackUpdate(OWNER, custom.data));
  assert.ok(h.app.gw.arming.get(OWNER.id));
  await h.feed(textUpdate(OWNER, "/help"));
  assert.equal(h.app.gw.arming.get(OWNER.id), undefined);
  assert.match(h.tg.texts(OWNER.id).at(-1)!, /Команды/);
  await h.feed(textUpdate(OWNER, "просто сообщение"));
  await c.waitFor("conversation.prompt", (p: { text: string }) => p.text === "просто сообщение");
  assert.equal(c.received("elicitation.respond", (p: { request_id: string }) => p.request_id === "e3").length, 0);
});

test("armed voice message is transcribed and used as the answer; «Отмена» on the question → cancel", async () => {
  const custom = h.tg.buttons(/Какой цвет/).find((b) => b.text === "✍️ Свой вариант")!;
  await h.feed(callbackUpdate(OWNER, custom.data));
  h.tg.files.set("v1", Buffer.from("OggS fake voice"));
  h.asr.reply = { status: 200, text: "оранжевый" };
  await h.feed(voiceUpdate(OWNER, "v1"));
  const r = await c.waitFor("elicitation.respond", (p: { request_id: string }) => p.request_id === "e3");
  assert.deepEqual((r.payload as { content: unknown }).content, { question_0_custom: "оранжевый" });

  c.send("elicitation.request", elicitation("e4"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e4");
  const cancel = h.tg.buttons(/Какой цвет/).find((b) => b.text === "Отмена")!;
  await h.feed(callbackUpdate(OWNER, cancel.data));
  const r4 = await c.waitFor("elicitation.respond", (p: { request_id: string }) => p.request_id === "e4");
  assert.deepEqual(r4.payload, { request_id: "e4", action: "cancel" });
});

test("elicitation.resolved (cancelled by /stop) closes the form and disarms", async () => {
  c.send("elicitation.request", elicitation("e5"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e5");
  const custom = h.tg.buttons(/Какой цвет/).find((b) => b.text === "✍️ Свой вариант")!;
  await h.feed(callbackUpdate(OWNER, custom.data));
  c.send("elicitation.resolved", { request_id: "e5", by: "cancelled" });
  await until(() => /Вопрос отменён/.test(lastText() ?? ""), "form closed");
  assert.equal(h.app.gw.arming.get(OWNER.id), undefined);
});

test("multi-field form goes field by field", async () => {
  c.send(
    "elicitation.request",
    elicitation("e6", {
      mode: "form",
      message: "Настройки",
      requestedSchema: { properties: { ok: { type: "boolean", title: "Продолжить?" }, n: { type: "integer", title: "Сколько?" } } },
    }),
  );
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e6");
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Продолжить\?/).find((b) => b.text === "Да")!.data));
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Сколько\?/).find((b) => b.text === "✍️ Ответить")!.data));
  await h.feed(textUpdate(OWNER, "много"));
  assert.match(h.tg.texts(OWNER.id).at(-1)!, /Нужно число/);
  await h.feed(textUpdate(OWNER, "3"));
  const r = await c.waitFor("elicitation.respond", (p: { request_id: string }) => p.request_id === "e6");
  assert.deepEqual((r.payload as { content: unknown }).content, { ok: true, n: 3 });
});

// protects=R6 details: «Отмена» on the «Напишите ответ…» prompt disarms and the next text is a prompt again; while armed, a text
//   starting with "/" that is not a bot command (a path, «/shrug») is the answer; form re-renders reuse their callback rows;
// fails_when=the arming prompt's «Отмена» leaves the chat armed, "/tmp/x" is swallowed (dropped and disarmed), every toggle of a
//   multi-select inserts a fresh set of 30-day callback rows;
// no_claim=Telegram client behaviour for /-prefixed text
test("«Отмена» on the arming prompt disarms; the next text is a normal prompt", async () => {
  c.send("elicitation.request", elicitation("e7"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e7");
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Какой цвет/).find((b) => b.text === "✍️ Свой вариант")!.data));
  const prompt = h.tg.messageId(/Напишите ответ одним сообщением/);
  const [cancel] = h.tg.buttons(/Напишите ответ одним сообщением/);
  assert.equal(cancel!.text, "Отмена");
  await h.feed(callbackUpdate(OWNER, cancel!.data, prompt));
  assert.equal(h.app.gw.arming.get(OWNER.id), undefined);
  assert.ok(h.tg.calls.some((x) => x.method === "editMessageText" && x.payload.message_id === prompt && x.payload.text === "Ответ отменён."));
  await h.feed(textUpdate(OWNER, "это уже не ответ"));
  await c.waitFor("conversation.prompt", (p: { text: string }) => p.text === "это уже не ответ");
  assert.equal(c.received("elicitation.respond", (p: { request_id: string }) => p.request_id === "e7").length, 0);
});

test("armed: «/tmp/report.txt» (not a bot command) is the answer", async () => {
  c.send("elicitation.request", elicitation("e8"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e8");
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Какой цвет/).find((b) => b.text === "✍️ Свой вариант")!.data));
  await h.feed(textUpdate(OWNER, "/tmp/report.txt"));
  const r = await c.waitFor("elicitation.respond", (p: { request_id: string }) => p.request_id === "e8");
  assert.deepEqual((r.payload as { content: unknown }).content, { question_0_custom: "/tmp/report.txt" });
});

test("re-rendering a form (multi-select toggles) does not insert new callback rows", async () => {
  c.send(
    "elicitation.request",
    elicitation("e9", {
      mode: "form",
      message: "Начинка",
      requestedSchema: { properties: { q: { type: "array", title: "Что добавить?", items: { anyOf: [{ const: "a", title: "Сыр" }, { const: "b", title: "Ветчина" }] } } } },
    }),
  );
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:e9");
  const count = async () => Number((await db.sql<{ n: string }[]>`select count(*)::text as n from callbacks`)[0]!.n);
  const msg = h.tg.messageId(/Начинка/);
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Начинка/)[0]!.data, msg));
  const afterFirst = await count();
  for (let i = 0; i < 3; i++) await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Начинка/)[1]!.data, msg));
  assert.equal(await count(), afterFirst);
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Начинка/).find((b) => b.text === "Готово")!.data, msg));
  const r = await c.waitFor("elicitation.respond", (p: { request_id: string }) => p.request_id === "e9");
  assert.deepEqual((r.payload as { content: unknown }).content, { q: ["a", "b"] }, "b toggled 3 times stays selected");
});
