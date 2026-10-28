// protects=Flow 7/8 commands: /sessions buttons (title, time, agent, busy badge) → session.attach → preview (+ active_elsewhere warning)
//   and the preview is reply-able into that session; /mode from session.state.modes; /agent from hello.agents; /stop, /new, /verbose, /status;
// fails_when=wrong request payloads (conversation_id), buttons without the session ref, preview not recorded in message_sessions,
//   mode buttons not from the latest session.state, verbose setting not persisted;
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
  await until(() => h.app.gw.state(h.app.gw.registry.all()[0]!.connectorId).conv, "state stored");
  await h.feed(textUpdate(OWNER, "/mode"));
  const btns = h.tg.buttons(/Режим разрешений/);
  assert.deepEqual(btns.map((b) => b.text), ["✓ Manual", "Accept edits"]);
  await h.feed(callbackUpdate(OWNER, btns[1]!.data));
  assert.deepEqual((await c.waitFor("session.set_mode")).payload, { conversation_id: chat, mode_id: "acceptEdits" });
  assert.equal(h.tg.texts(OWNER.id).at(-1), "Режим: <b>Accept edits</b>");
});

test("/agent buttons from hello.agents; /new; /stop; /verbose; /status", async () => {
  await h.feed(textUpdate(OWNER, "/agent"));
  const btns = h.tg.buttons(/Выберите агента/);
  assert.deepEqual(btns.map((b) => b.text), ["✓ Claude Code", "opencode"]);
  await h.feed(callbackUpdate(OWNER, btns[1]!.data));
  assert.deepEqual((await c.waitFor("agent.select")).payload, { conversation_id: chat, agent_id: "opencode" });

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
});

test("request errors from the connector are shown", async () => {
  const { ProtocolError } = await import("@brain-boost-academy/agent-protocol");
  c.handlers["session.new"] = () => new ProtocolError("agent_unavailable", "claude crashed");
  await h.feed(textUpdate(OWNER, "/new"));
  assert.equal(h.tg.texts(OWNER.id).at(-1), "⚠️ Агент недоступен.");
});
