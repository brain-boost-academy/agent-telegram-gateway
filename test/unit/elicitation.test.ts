// protects=ACP form elicitation → one field at a time with the right buttons, and R6 arming rules;
// fails_when=Claude/opencode `_custom` companion is shown as its own question, enum/array/boolean/text get wrong buttons,
//   content keys differ from {question_0:"Red"} / {question_0_custom:"text"}, unarmed text becomes an answer, /command while armed becomes an answer,
//   two armed fields per chat, arming survives the elicitation closing;
// no_claim=exact schema emitted by future adapter versions (M0 facts in PROTOCOL.md)
import { test } from "node:test";
import assert from "node:assert/strict";
import { Arming, Form, parseForm, routeIncoming } from "../../src/telegram/elicitation.ts";
import { isBotCommand } from "../../src/telegram/handlers.ts";
import { visibleLength } from "../../src/telegram/markdown.ts";

// Shape verified in M0 for claude-agent-acp AskUserQuestion (PROTOCOL.md).
const claude = {
  mode: "form",
  message: "Questions",
  requestedSchema: {
    type: "object",
    properties: {
      question_0: {
        type: "string",
        title: "Favourite colour?",
        oneOf: [
          { const: "Red", title: "Red", description: "warm" },
          { const: "Green", title: "Green" },
          { const: "Blue", title: "Blue" },
        ],
      },
      question_0_custom: { type: "string", title: "Other" },
      question_1: { type: "array", title: "Pick toppings", items: { anyOf: [{ const: "Cheese", title: "Cheese" }, { const: "Ham", title: "Ham" }] } },
      question_1_custom: { type: "string", title: "Other" },
      confirm: { type: "boolean", title: "Sure?" },
      age: { type: "integer", title: "Age" },
      note: { type: "string", title: "Note" },
    },
    required: ["question_0"],
  },
};

const labels = (f: Form) => f.buttons().map((r) => r.map((b) => b.label));

test("companion `<key>_custom` fields become «Свой вариант», not separate questions", () => {
  const fields = parseForm(claude);
  assert.deepEqual(fields.map((f) => [f.key, f.kind]), [["question_0", "single"], ["question_1", "multi"], ["confirm", "boolean"], ["age", "integer"], ["note", "text"]]);
  assert.equal(fields[0]!.kind === "single" && fields[0]!.customKey, "question_0_custom");
});

test("3 options → 3 buttons + «Свой вариант» + «Отмена»; option click answers {question_0: const}", () => {
  const f = new Form(claude);
  assert.deepEqual(labels(f), [["Red"], ["Green"], ["Blue"], ["✍️ Свой вариант"], ["Отмена"]]);
  assert.ok(f.apply({ a: "opt", i: 0 }));
  assert.deepEqual(f.content, { question_0: "Red" });
  assert.equal(f.current?.key, "question_1");
});

test("array enum → toggles + «Готово»; boolean → Да/Нет; number/string → «Ответить»", () => {
  const f = new Form(claude);
  f.apply({ a: "opt", i: 1 });
  assert.deepEqual(labels(f), [["▫️ Cheese"], ["▫️ Ham"], ["✍️ Свой вариант", "Готово"], ["Отмена"]]);
  f.apply({ a: "tog", i: 1 });
  f.apply({ a: "tog", i: 0 });
  f.apply({ a: "tog", i: 1 });
  assert.deepEqual(labels(f)[0], ["☑️ Cheese"]);
  f.apply({ a: "done" });
  assert.deepEqual(f.content.question_1, ["Cheese"]);
  assert.deepEqual(labels(f), [["Да", "Нет"], ["Отмена"]]);
  f.apply({ a: "bool", v: false });
  assert.deepEqual(labels(f), [["✍️ Ответить"], ["Отмена"]]);
  assert.deepEqual(f.answerText("abc"), { ok: false, reason: "number" });
  assert.deepEqual(f.answerText("41,0"), { ok: true });
  assert.equal(f.content.age, 41);
  f.answerText("hello");
  assert.ok(f.done);
  assert.deepEqual(f.content, { question_0: "Green", question_1: ["Cheese"], confirm: false, age: 41, note: "hello" });
});

test("free text on a choice field goes to the companion key", () => {
  const f = new Form(claude);
  f.answerText("Purple");
  assert.deepEqual(f.content, { question_0_custom: "Purple" });
  assert.match(f.summaryHtml("✅"), /Favourite colour\?: Purple/);
});

test("opencode-style enum + `<key>_custom`, enum without companion has no «Свой вариант»", () => {
  const f = new Form({
    mode: "form",
    message: "Pick",
    requestedSchema: { properties: { db: { type: "string", enum: ["pg", "sqlite"], enumNames: ["Postgres", "SQLite"] }, db_custom: { type: "string" }, x: { enum: ["a"] } } },
  });
  assert.deepEqual(labels(f), [["Postgres"], ["SQLite"], ["✍️ Свой вариант"], ["Отмена"]]);
  f.apply({ a: "opt", i: 0 });
  assert.deepEqual(labels(f), [["a"], ["Отмена"]]);
  assert.equal(f.content.db, "pg");
});

test("stale action for another field kind does not apply", () => {
  const f = new Form(claude);
  assert.equal(f.apply({ a: "bool", v: true }), false);
  assert.equal(f.apply({ a: "opt", i: 9 }), false);
  assert.equal(f.index, 0);
});

test("R6 arming: one field per chat, re-arm switches, disarm by id, cleared when the request closes", () => {
  const a = new Arming();
  const base = { connectorId: "c", requestId: "r1" };
  assert.equal(a.arm(1, { ...base, armId: "x", fieldKey: "question_0" }), undefined);
  const prev = a.arm(1, { ...base, armId: "y", fieldKey: "question_1" });
  assert.equal(prev?.armId, "x");
  assert.equal(a.get(1)?.fieldKey, "question_1");
  assert.equal(a.disarm(1, "x"), undefined, "stale [Отмена] of the previous arming is ignored");
  assert.equal(a.get(1)?.armId, "y");
  a.arm(2, { ...base, requestId: "r2", armId: "z", fieldKey: "q" });
  assert.deepEqual(a.disarmRequest("r1").map((d) => d.chatId), [1]);
  assert.equal(a.get(1), undefined);
  assert.equal(a.get(2)?.armId, "z");
});

test("R6 routing: /command disarms, armed text answers, unarmed text is a prompt", () => {
  const armed = { armId: "x", connectorId: "c", requestId: "r", fieldKey: "f" };
  assert.equal(routeIncoming(armed, "/stop"), "command");
  assert.equal(routeIncoming(armed, "my answer"), "answer");
  assert.equal(routeIncoming(undefined, "hello"), "prompt");
});

// protects=a form never hits a permanent Bot API 400: ≤ 50 option buttons per field (the rest reachable by typing), button labels
//   non-empty and short, message text ≤ 4096 even with huge descriptions/option lists; armed "/path" text is an answer;
// fails_when=120 options produce 120+ buttons, an empty title gives an empty button, a long message/description/option list exceeds
//   4096, typing an option beyond the cap is rejected or sent as free text under the wrong key, "/tmp/x" while armed is a command;
// no_claim=exact Telegram button text limit (we keep ≤ 64 code units)
test("big forms are capped: ≤ 50 option buttons, non-empty short labels, text ≤ 4096; options beyond the cap by typing", () => {
  const options = Array.from({ length: 120 }, (_, i) => ({ const: `v${i}`, title: i === 3 ? "" : i % 2 ? "😀".repeat(80) : `Вариант ${i} ${"длинно ".repeat(40)}` }));
  const f = new Form({
    mode: "form",
    message: "М".repeat(5000),
    requestedSchema: { properties: { q: { type: "string", title: "Т".repeat(1000), description: "D".repeat(5000), oneOf: options } } },
  });
  const rows = f.buttons();
  const flat = rows.flat();
  assert.ok(flat.filter((b) => b.action.a === "opt").length <= 50);
  assert.ok(flat.some((b) => b.action.a === "custom"), "free-text fallback offered");
  for (const b of flat) {
    assert.ok(b.label.trim().length > 0, "empty label");
    assert.ok(b.label.length <= 64, `label too long: ${b.label.length}`);
    assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(b.label), "lone surrogate in label");
  }
  assert.equal(flat.find((b) => b.action.a === "opt" && b.action.i === 3)!.label, "v3");
  assert.ok(visibleLength(f.html()) <= 4096, `html ${visibleLength(f.html())}`);
  assert.deepEqual(f.answerText("v100"), { ok: true });
  assert.deepEqual(f.content, { q: "v100" });
  assert.ok(visibleLength(f.summaryHtml("✅")) <= 4096);
});

test("summary of a long multi-field form stays ≤ 4096", () => {
  const props = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`f${i}`, { type: "string", title: `Поле ${i} ${"x".repeat(200)}` }]));
  const f = new Form({ mode: "form", message: "M".repeat(3000), requestedSchema: { properties: props } });
  for (let i = 0; i < 39; i++) f.answerText("ответ ".repeat(100));
  assert.ok(visibleLength(f.html()) <= 4096, `html ${visibleLength(f.html())}`);
  f.answerText("last");
  assert.ok(visibleLength(f.summaryHtml("✅ Ответ отправлен")) <= 4096);
});

test("R6 routing: armed text starting with / that is not a bot command is the answer", () => {
  const armed = { armId: "x", connectorId: "c", requestId: "r", fieldKey: "f" };
  const known = (t: string) => isBotCommand(t, "test_gw_bot");
  assert.equal(routeIncoming(armed, "/tmp/report.txt", known), "answer");
  assert.equal(routeIncoming(armed, "/shrug", known), "answer");
  assert.equal(routeIncoming(armed, "/stop", known), "command");
  assert.equal(routeIncoming(armed, "/help@test_gw_bot", known), "command");
  assert.equal(routeIncoming(undefined, "/whatever", known), "command");
});
