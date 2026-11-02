// protects=Flow 7/8 commands: /sessions buttons (title, time, agent, busy badge) → session.attach → preview (+ active_elsewhere warning)
//   and the preview is reply-able into that session; /mode from session.state.modes; /agent from hello.agents; /stop, /new, /verbose, /status;
//   a /mode or /agent pick moves the ✓ in the same menu message (+ toast), a text confirmation when the menu cannot be redrawn;
// fails_when=wrong request payloads (conversation_id), buttons without the session ref, preview not recorded in message_sessions,
//   mode buttons not from the latest session.state, verbose setting not persisted, ✓ left on the old item or a new message
//   per pick, no confirmation when the edit fails, an error shown for a pick that succeeded, ✓ moved after a failed request;
// no_claim=connector-side behaviour of these requests (session/load etc.)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS } from "../../src/telegram/texts.ts";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { callbackUpdate, FakeConnector, makeConnector, OWNER, SESSION, startGateway, textUpdate, until, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;
let c: FakeConnector;
const chat = String(OWNER.id);
const other = { agent_id: "opencode", session_id: "oc-7", cwd: "/home/u/work/vault" };
type Kb = { inline_keyboard: Array<Array<{ text: string }>> };
const conv = () => h.app.gw.state(h.app.gw.registry.all()[0]!.connectorId).conv;
const edits = () => h.tg.of("editMessageReplyMarkup", OWNER.id);
const lastEdit = () => {
  const e = edits().at(-1)!;
  return { messageId: e.payload.message_id, labels: (e.payload.reply_markup as Kb).inline_keyboard.flat().map((b) => b.text) };
};
const lastToast = () => h.tg.of("answerCallbackQuery").at(-1)?.payload.text;

before(async () => {
  db = await freshDb();
  h = await startGateway(db);
  c = await FakeConnector.connect(h.wsUrl, (await makeConnector(db.repo, "af50", OWNER)).token);
  c.handlers["sessions.list"] = () => ({
    items: [
      { session: SESSION, title: "Сводка", updated_at: new Date().toISOString(), busy: "running" },
      { session: other, title: "Старая", updated_at: "2026-01-02T10:00:00Z", busy: "idle" },
    ],
  });
  c.handlers["session.attach"] = (p) => ({ session: p.session, title: "Старая", last_assistant_text: "Итог: **готово**", warning: "active_elsewhere" });
  c.handlers["session.set_mode"] = (p) => ({ mode_id: p.mode_id });
  c.handlers["agent.select"] = (p) => ({ agent_id: p.agent_id });
});
after(async () => {
  await c?.close();
  await h?.stop();
  await db?.drop();
});

test("command list for setMyCommands has all spec commands", () => {
  assert.deepEqual(COMMANDS.map((x) => x.command), ["start", "new", "sessions", "stop", "mode", "agent", "verbose", "status", "unpair", "help"]);
});

test("/sessions → buttons → attach → preview with warning; reply to the preview targets that session", async () => {
  await h.feed(textUpdate(OWNER, "/sessions"));
  assert.deepEqual((await c.waitFor("sessions.list")).payload, { conversation_id: chat, limit: 10 });
  const btns = h.tg.buttons(/Последние сессии/);
  assert.equal(btns.length, 2);
  assert.match(btns[0]!.text, /^⚙️ Сводка · \d\d:\d\d · Claude Code$/);
  assert.equal(btns[1]!.text, "Старая · 02.01 10:00 · opencode");
  await h.feed(callbackUpdate(OWNER, btns[1]!.data));
  assert.deepEqual((await c.waitFor("session.attach")).payload, { conversation_id: chat, session: other });
  const preview = h.tg.texts(OWNER.id).at(-1)!;
  assert.equal(preview, "📂 <b>Старая</b>\n⚠️ Сессия сейчас открыта в другом месте (открыта в cloudcli?)\n\nИтог: <b>готово</b>");
  await h.feed(textUpdate(OWNER, "продолжай", h.tg.messageId(/Старая/)));
  const p = await c.waitFor("conversation.prompt");
  assert.deepEqual((p.payload as { session: unknown }).session, other);
});

test("/mode uses the latest session.state modes; click → session.set_mode", async () => {
  await h.feed(textUpdate(OWNER, "/mode"));
  assert.match(h.tg.texts(OWNER.id).at(-1)!, /Режимы недоступны/);
  c.send("session.state", {
    conversation_id: chat,
    session: SESSION,
    agent_id: "claude",
    title: "Сводка",
    modes: { current: "default", available: [{ id: "default", name: "Manual" }, { id: "acceptEdits", name: "Accept edits" }] },
    busy: false,
    queue_length: 0,
  });
  await until(conv, "state stored");
  await h.feed(textUpdate(OWNER, "/mode"));
  const btns = h.tg.buttons(/Режим разрешений/);
  assert.deepEqual(btns.map((b) => b.text), ["✓ Manual", "Accept edits"]);
  const menuId = h.tg.messageId(/Режим разрешений/);
  const sent = h.tg.texts(OWNER.id).length;
  await h.feed(callbackUpdate(OWNER, btns[1]!.data, menuId));
  assert.deepEqual((await c.waitFor("session.set_mode")).payload, { conversation_id: chat, mode_id: "acceptEdits" });
  assert.deepEqual(lastEdit(), { messageId: menuId, labels: ["Manual", "✓ Accept edits"] });
  assert.equal(h.tg.texts(OWNER.id).length, sent, "no separate «Режим: …» message");
  assert.equal(lastToast(), "Режим: Accept edits");
});

test("/agent buttons from hello.agents; /new; /stop; /verbose; /status", async () => {
  await h.feed(textUpdate(OWNER, "/agent"));
  const btns = h.tg.buttons(/Выберите агента/);
  assert.deepEqual(btns.map((b) => b.text), ["✓ Claude Code", "opencode"]);
  const menuId = h.tg.messageId(/Выберите агента/);
  const sent = h.tg.texts(OWNER.id).length;
  await h.feed(callbackUpdate(OWNER, btns[1]!.data, menuId));
  assert.deepEqual((await c.waitFor("agent.select")).payload, { conversation_id: chat, agent_id: "opencode" });
  assert.deepEqual(lastEdit(), { messageId: menuId, labels: ["Claude Code", "✓ opencode"] });
  assert.equal(h.tg.texts(OWNER.id).length, sent, "no separate «Агент: …» message");
  assert.equal(lastToast(), "Агент: opencode");

  await h.feed(textUpdate(OWNER, "/new"));
  assert.deepEqual((await c.waitFor("session.new")).payload, { conversation_id: chat });
  assert.equal(h.tg.texts(OWNER.id).at(-1), "🆕 Новая сессия · Claude Code");

  await h.feed(textUpdate(OWNER, "/stop"));
  assert.deepEqual((await c.waitFor("session.cancel")).payload, { conversation_id: chat });
  assert.equal(h.tg.texts(OWNER.id).at(-1), "⏹ Останавливаю…");

  await h.feed(textUpdate(OWNER, "/verbose on"));
  assert.equal(await db.repo.verbose(OWNER.id), true);
  await h.feed(textUpdate(OWNER, "/verbose"));
  assert.equal(await db.repo.verbose(OWNER.id), false);

  await h.feed(textUpdate(OWNER, "/status"));
  const st = h.tg.texts(OWNER.id).at(-1)!;
  assert.match(st, /Агент: <b>af50<\/b> — в сети/);
  assert.match(st, /Режим: Accept edits/);
  assert.match(st, /Подробный вывод: выкл/);

  // The connector follows agent.select with session.state; the next /agent shows the new ✓ from it.
  c.send("session.state", { conversation_id: chat, session: null, agent_id: "opencode", busy: false, queue_length: 0 });
  await until(() => conv()?.agent_id === "opencode", "agent switched");
  await h.feed(textUpdate(OWNER, "/agent"));
  assert.deepEqual(h.tg.buttons(/Выберите агента/).map((b) => b.text), ["Claude Code", "✓ opencode"]);
});

test("a pick that cannot be shown in the menu is confirmed with text, never with an error", async () => {
  const agentMenu = h.tg.messageId(/Выберите агента/);
  const claude = h.tg.buttons(/Выберите агента/)[0]!.data;

  // The menu message is gone → text confirmation.
  h.tg.failNext("editMessageReplyMarkup", 1, 400, "Bad Request: message to edit not found");
  await h.feed(callbackUpdate(OWNER, claude, agentMenu));
  assert.equal(h.tg.texts(OWNER.id).at(-1), "Агент: <b>Claude Code</b>");

  // Both the edit and the confirmation fail → only logged, no «⚠️».
  let sent = h.tg.texts(OWNER.id).length;
  h.tg.failNext("editMessageReplyMarkup", 1, 429, "Too Many Requests: retry after 5");
  h.tg.failNext("sendMessage", 1, 429, "Too Many Requests: retry after 5");
  await h.feed(callbackUpdate(OWNER, claude, agentMenu));
  assert.deepEqual(h.tg.texts(OWNER.id).slice(sent), ["Агент: <b>Claude Code</b>"]);

  // An old /mode menu after the session was unbound (no modes in the state) → text, the menu is not touched.
  const modeMenu = h.tg.messageId(/Режим разрешений/);
  const [manual, acceptEdits] = h.tg.buttons(/Режим разрешений/);
  assert.equal(conv()?.modes ?? undefined, undefined);
  let edited = edits().length;
  await h.feed(callbackUpdate(OWNER, manual!.data, modeMenu));
  assert.equal(h.tg.texts(OWNER.id).at(-1), "Режим: <b>Manual</b>");
  assert.equal(edits().length, edited);

  // The picked mode is no longer in the list → text, the menu is not touched.
  c.send("session.state", {
    conversation_id: chat,
    session: SESSION,
    agent_id: "claude",
    modes: { current: "default", available: [{ id: "default", name: "Manual" }] },
    busy: false,
    queue_length: 0,
  });
  await until(() => conv()?.modes?.available.length === 1, "modes without acceptEdits");
  sent = h.tg.texts(OWNER.id).length;
  edited = edits().length;
  await h.feed(callbackUpdate(OWNER, acceptEdits!.data, modeMenu));
  assert.deepEqual(h.tg.texts(OWNER.id).slice(sent), ["Режим: <b>Accept edits</b>"]);
  assert.equal(edits().length, edited);

  // A name that itself starts with «✓ » is not the picked item: still text, the menu is not touched.
  const state = (available: Array<{ id: string; name: string }>) =>
    c.send("session.state", { conversation_id: chat, session: SESSION, agent_id: "claude", modes: { current: "default", available }, busy: false, queue_length: 0 });
  state([{ id: "default", name: "✓ Manual" }, { id: "plan", name: "Plan" }]);
  await until(() => conv()?.modes?.available.length === 2, "modes with plan");
  await h.feed(textUpdate(OWNER, "/mode"));
  const planMenu = h.tg.messageId(/Режим разрешений/);
  const plan = h.tg.buttons(/Режим разрешений/)[1]!.data;
  state([{ id: "default", name: "✓ Manual" }]);
  await until(() => conv()?.modes?.available.length === 1, "plan removed");
  sent = h.tg.texts(OWNER.id).length;
  edited = edits().length;
  await h.feed(callbackUpdate(OWNER, plan, planMenu));
  assert.deepEqual(h.tg.texts(OWNER.id).slice(sent), ["Режим: <b>Plan</b>"]);
  assert.equal(edits().length, edited);
});

test("request errors from the connector are shown", async () => {
  const { ProtocolError } = await import("@brain-boost-academy/agent-protocol");
  const prev = { new: c.handlers["session.new"], select: c.handlers["agent.select"] };
  c.handlers["session.new"] = () => new ProtocolError("agent_unavailable", "claude crashed");
  await h.feed(textUpdate(OWNER, "/new"));
  assert.equal(h.tg.texts(OWNER.id).at(-1), "⚠️ Агент недоступен.");

  // A failed pick shows the error and leaves the ✓ where it was.
  c.handlers["agent.select"] = () => new ProtocolError("agent_unavailable", "opencode crashed");
  await h.feed(textUpdate(OWNER, "/agent"));
  const edited = edits().length;
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Выберите агента/)[1]!.data, h.tg.messageId(/Выберите агента/)));
  assert.equal(h.tg.texts(OWNER.id).at(-1), "⚠️ Агент недоступен.");
  assert.equal(edits().length, edited);
  assert.equal(lastToast(), undefined);
  c.handlers["session.new"] = prev.new;
  c.handlers["agent.select"] = prev.select;
});
