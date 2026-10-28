// protects=Flow 1 end-to-end: code minting, /start <code>, one-time + TTL, owner-approved re-pair (R3b) incl. reject/timeout,
//   «Перепривязать?» for a user owning another connector, strict 1:1, pairing.changed pushes (R16), /unpair, admin unpair, pairings find,
//   unpaired users only get the pairing hint;
// fails_when=a used/expired code pairs, re-pair happens without the current owner's click or after the timeout, a second connector
//   keeps the same tg user, the connector is not told about a pairing change, a stranger's message reaches the connector;
// no_claim=real Telegram deep-link handling (/start payload is simulated)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { runAdmin } from "../../src/admin/commands.ts";
import { freshDb, type TestDb } from "../helpers/db.ts";
import {
  callbackUpdate,
  FakeConnector,
  makeConnector,
  OWNER,
  STRANGER,
  startGateway,
  textUpdate,
  sleep,
  until,
  type Harness,
  type TgUser,
} from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;

before(async () => {
  db = await freshDb();
  h = await startGateway(db, { timings: { approvalMs: 300 } });
});
after(async () => {
  await h?.stop();
  await db?.drop();
});

async function code(c: FakeConnector): Promise<string> {
  const r = await c.request("pairing.request", {});
  assert.match(r.url, /^https:\/\/t\.me\/test_gw_bot\?start=[a-z2-7]{26}$/);
  assert.ok(Date.parse(r.expires_at) - Date.now() > 9 * 60_000);
  return r.code;
}

const changes = (c: FakeConnector) => c.received("pairing.changed").map((e) => e.payload as { paired: boolean; reason: string; user_display?: string; conversation_id?: string });
const lastText = (u: TgUser) => h.tg.texts(u.id).at(-1) ?? "";

test("unpaired user gets only the pairing hint", async () => {
  await h.feed(textUpdate(STRANGER, "hello agent"));
  assert.match(lastText(STRANGER), /подключи телеграм/);
  await h.feed(textUpdate(STRANGER, "/sessions"));
  assert.match(lastText(STRANGER), /подключи телеграм/);
});

test("pair via /start <code>; reuse → «уже использован»; expired → «истёк»; status/revoke", async () => {
  const { id, token } = await makeConnector(db.repo, "af03");
  const c = await FakeConnector.connect(h.wsUrl, token);
  assert.deepEqual(c.welcome?.pairing, { paired: false });
  const k = await code(c);
  await h.feed(textUpdate(OWNER, `/start ${k}`));
  assert.match(lastText(OWNER), /Агент «af03» подключён/);
  await c.waitFor("pairing.changed");
  assert.deepEqual(changes(c), [{ paired: true, user_display: "@owner", conversation_id: String(OWNER.id), reason: "paired" }]);
  assert.deepEqual(await c.request("pairing.status", {}), { paired: true, user_display: "@owner", conversation_id: String(OWNER.id) });

  await h.feed(textUpdate(STRANGER, `/start ${k}`));
  assert.match(lastText(STRANGER), /уже использован/);

  const k2 = await code(c);
  await db.sql`update pairing_codes set expires_at = now() - interval '1 second' where code = ${k2}`;
  await h.feed(textUpdate(STRANGER, `/start ${k2}`));
  assert.match(lastText(STRANGER), /истёк/);

  await h.feed(textUpdate(STRANGER, "/start nonsense"));
  assert.match(lastText(STRANGER), /не найден/);

  assert.deepEqual(await c.request("pairing.revoke", {}), { ok: true });
  assert.equal(await db.repo.pairingByConnector(id), undefined);
  assert.match(lastText(OWNER), /Агент «af03» отвязал этот чат/);
  await c.close();
});

test("re-pair of an owned connector: owner approves → new owner, old owner told, connector gets pairing.changed replaced", async () => {
  const { id, token } = await makeConnector(db.repo, "af04", OWNER);
  const c = await FakeConnector.connect(h.wsUrl, token);
  const newbie: TgUser = { id: 6001, username: "newbie" };
  await h.feed(textUpdate(newbie, `/start ${await code(c)}`));
  assert.match(lastText(newbie), /Ждём подтверждения владельца/);
  assert.match(lastText(OWNER), /@newbie хочет привязаться к агенту «af04»/);
  const [allow] = h.tg.buttons(/хочет привязаться/);
  assert.equal(allow!.text, "Разрешить");
  // the new user cannot approve for the owner
  await h.feed(callbackUpdate(newbie, allow!.data));
  assert.equal((await db.repo.pairingByConnector(id))?.tg_user_id, OWNER.id);
  await h.feed(callbackUpdate(OWNER, allow!.data));
  assert.equal((await db.repo.pairingByConnector(id))?.tg_user_id, newbie.id);
  assert.match(lastText(newbie), /подключён/);
  // the old owner sees exactly one notice: the approval message edited into «you approved, this chat no longer controls the agent»
  assert.equal(h.tg.allTexts(OWNER.id).at(-1), "✅ Вы разрешили привязку: @newbie. Этот чат больше не управляет агентом.");
  assert.ok(!h.tg.allTexts(OWNER.id).some((t) => /больше не привязан к этому чату/.test(t)), "no second «lost» notice");
  await c.waitFor("pairing.changed");
  assert.deepEqual(changes(c).at(-1), { paired: true, user_display: "@newbie", conversation_id: "6001", reason: "replaced" });
  // the old owner is no longer allowed to talk to it
  await h.feed(textUpdate(OWNER, "hi"));
  assert.match(lastText(OWNER), /подключи телеграм/);
  await c.close();
});

test("re-pair rejected by the owner, and timeout = reject", async () => {
  const { id, token } = await makeConnector(db.repo, "af05", OWNER);
  const c = await FakeConnector.connect(h.wsUrl, token);
  const u1: TgUser = { id: 6101, username: "u1" };
  await h.feed(textUpdate(u1, `/start ${await code(c)}`));
  const [, reject] = h.tg.buttons(/@u1 хочет привязаться/);
  await h.feed(callbackUpdate(OWNER, reject!.data));
  assert.match(lastText(u1), /отклонил/);
  assert.equal((await db.repo.pairingByConnector(id))?.tg_user_id, OWNER.id);

  const u2: TgUser = { id: 6102, username: "u2" };
  await h.feed(textUpdate(u2, `/start ${await code(c)}`));
  const [allowLate] = h.tg.buttons(/@u2 хочет привязаться/);
  await until(() => /не ответил за 10 минут/.test(lastText(u2)), "timeout notice", 2000);
  await h.feed(callbackUpdate(OWNER, allowLate!.data));
  assert.equal((await db.repo.pairingByConnector(id))?.tg_user_id, OWNER.id, "late approval ignored");
  assert.deepEqual(changes(c), [], "no pairing change happened");
  await c.close();
});

test("user paired to another connector is asked «Перепривязать?»; yes moves them (strict 1:1)", async () => {
  const a = await makeConnector(db.repo, "agentA");
  const b = await makeConnector(db.repo, "agentB");
  const u: TgUser = { id: 6201, username: "mover" };
  await db.repo.setPairing({ connector_id: a.id, tg_user_id: u.id, tg_chat_id: u.id, user_display: "@mover" });
  const ca = await FakeConnector.connect(h.wsUrl, a.token);
  const cb = await FakeConnector.connect(h.wsUrl, b.token);
  await h.feed(textUpdate(u, `/start ${await code(cb)}`));
  assert.match(lastText(u), /Перепривязать к «agentB»/);
  const [yes] = h.tg.buttons(/Перепривязать/);
  await h.feed(callbackUpdate(u, yes!.data));
  assert.equal((await db.repo.pairingByUser(u.id))?.connector_id, b.id);
  assert.equal(await db.repo.pairingByConnector(a.id), undefined);
  await ca.waitFor("pairing.changed");
  assert.deepEqual(changes(ca), [{ paired: false, reason: "replaced" }]);
  await cb.waitFor("pairing.changed");
  assert.equal(changes(cb)[0]?.reason, "paired");
  await ca.close();
  await cb.close();
});

test("/unpair by the owner and admin unpair push pairing.changed; pairings find locates the connector", async () => {
  const { id, token } = await makeConnector(db.repo, "af06", OWNER);
  const c = await FakeConnector.connect(h.wsUrl, token);
  // OWNER may still be paired to an earlier connector in this file; make af06 the only one
  assert.deepEqual(await runAdmin(["pairings", "find", "--tg", "@owner"], db.repo).then((l) => l.map((x) => x.split("\t")[0])), ["af06"]);
  await h.feed(textUpdate(OWNER, "/unpair"));
  assert.match(lastText(OWNER), /отвязан/);
  await c.waitFor("pairing.changed");
  assert.deepEqual(changes(c), [{ paired: false, reason: "unpaired" }]);

  await db.repo.setPairing({ connector_id: id, tg_user_id: OWNER.id, tg_chat_id: OWNER.id, user_display: "@owner" });
  h.app.gw.invalidatePairing(id);
  const out = await runAdmin(["connectors", "unpair", "af06"], db.repo);
  assert.match(out[0]!, /unpaired from @owner/);
  await until(() => changes(c).length === 2, "admin_unpair push");
  assert.deepEqual(changes(c)[1], { paired: false, reason: "admin_unpair" });
  await until(() => /Администратор отвязал агента «af06»/.test(lastText(OWNER)), "admin notice");
  assert.deepEqual(await runAdmin(["pairings", "find", "--tg", String(OWNER.id)], db.repo), ["no pairing found"]);
  await c.close();
});

// protects=R3b races and the «Перепривязать?» branches: «Нет» and silence leave pairings untouched, an approval pressed by someone
//   who is no longer the owner is stale, every pending approval of a connector dies when its pairing changes, a concurrent claim
//   (unique violation) is explained to the user;
// fails_when=a former owner can still hand the agent over, a late «Да» after the timeout re-pairs, «Нет» changes the pairing or pushes
//   pairing.changed, the requester is left waiting after the flow went stale, a 23505 surfaces as a silent failure;
// no_claim=real concurrent Postgres transactions (the unique violation is injected)
test("«Перепривязать?» → «Нет»: pairings unchanged, no pairing.changed", async () => {
  const a = await makeConnector(db.repo, "noA");
  const b = await makeConnector(db.repo, "noB");
  const u: TgUser = { id: 6301, username: "stayer" };
  await db.repo.setPairing({ connector_id: a.id, tg_user_id: u.id, tg_chat_id: u.id, user_display: "@stayer" });
  const ca = await FakeConnector.connect(h.wsUrl, a.token);
  const cb = await FakeConnector.connect(h.wsUrl, b.token);
  await h.feed(textUpdate(u, `/start ${await code(cb)}`));
  const [, no] = h.tg.buttons(/Перепривязать к «noB»/);
  await h.feed(callbackUpdate(u, no!.data, h.tg.messageId(/Перепривязать к «noB»/)));
  assert.equal(h.tg.allTexts(u.id).at(-1), "Хорошо, привязка не изменилась.");
  assert.equal((await db.repo.pairingByUser(u.id))?.connector_id, a.id);
  assert.equal(await db.repo.pairingByConnector(b.id), undefined);
  await sleep(50);
  assert.deepEqual(changes(ca), []);
  assert.deepEqual(changes(cb), []);
  await ca.close();
  await cb.close();
});

test("«Перепривязать?» unanswered → stale after the timeout; a late «Да» is ignored", async () => {
  const a = await makeConnector(db.repo, "toA");
  const b = await makeConnector(db.repo, "toB");
  const u: TgUser = { id: 6302, username: "slow" };
  await db.repo.setPairing({ connector_id: a.id, tg_user_id: u.id, tg_chat_id: u.id, user_display: "@slow" });
  const cb = await FakeConnector.connect(h.wsUrl, b.token);
  await h.feed(textUpdate(u, `/start ${await code(cb)}`));
  const [yes] = h.tg.buttons(/Перепривязать к «toB»/);
  await until(() => h.tg.allTexts(u.id).at(-1) === "Запрос устарел", "stale edit", 2000);
  await h.feed(callbackUpdate(u, yes!.data));
  assert.equal(h.tg.of("answerCallbackQuery").at(-1)!.payload.text, "Запрос устарел");
  assert.equal((await db.repo.pairingByUser(u.id))?.connector_id, a.id);
  assert.deepEqual(changes(cb), []);
  await cb.close();
});

test("approval pressed by a former owner (pairing changed meanwhile) is stale; the requester is told", async () => {
  const owner: TgUser = { id: 6401, username: "former" };
  const req: TgUser = { id: 6402, username: "asker" };
  const third: TgUser = { id: 6403, username: "third" };
  const { id, token } = await makeConnector(db.repo, "racy", owner);
  const c = await FakeConnector.connect(h.wsUrl, token);
  await h.feed(textUpdate(req, `/start ${await code(c)}`));
  const [allow] = h.tg.buttons(/@asker хочет привязаться/);
  // ownership moved without going through this flow (e.g. another gateway process / admin)
  await db.repo.setPairing({ connector_id: id, tg_user_id: third.id, tg_chat_id: third.id, user_display: "@third" });
  h.app.gw.invalidatePairing(id);
  await h.feed(callbackUpdate(owner, allow!.data, h.tg.messageId(/@asker хочет привязаться/)));
  assert.equal((await db.repo.pairingByConnector(id))?.tg_user_id, third.id, "former owner cannot hand the agent over");
  assert.equal(h.tg.allTexts(owner.id).at(-1), "Запрос устарел");
  assert.match(lastText(req), /устарел/);
  await c.close();
});

test("owner /unpair while an approval is pending → the approval goes stale, requester told, late click ignored", async () => {
  const owner: TgUser = { id: 6501, username: "leaver" };
  const req: TgUser = { id: 6502, username: "waiter" };
  const { id, token } = await makeConnector(db.repo, "leaving", owner);
  const c = await FakeConnector.connect(h.wsUrl, token);
  await h.feed(textUpdate(req, `/start ${await code(c)}`));
  const [allow] = h.tg.buttons(/@waiter хочет привязаться/);
  const approvalId = h.tg.messageId(/@waiter хочет привязаться/);
  await h.feed(textUpdate(owner, "/unpair"));
  await until(() => h.tg.calls.some((x) => x.method === "editMessageText" && x.payload.message_id === approvalId && x.payload.text === "Запрос устарел"), "approval stale");
  assert.match(lastText(req), /устарел/);
  await h.feed(callbackUpdate(owner, allow!.data, approvalId));
  assert.equal(await db.repo.pairingByConnector(id), undefined, "late approval ignored");
  await c.close();
});

test("a concurrent claim (unique violation) tells the user the agent was just taken", async () => {
  const { token } = await makeConnector(db.repo, "contested");
  const c = await FakeConnector.connect(h.wsUrl, token);
  const u: TgUser = { id: 6601, username: "late" };
  const orig = h.app.repo.setPairing;
  h.app.repo.setPairing = async () => {
    throw Object.assign(new Error('duplicate key value violates unique constraint "pairings_pkey"'), { code: "23505" });
  };
  try {
    await h.feed(textUpdate(u, `/start ${await code(c)}`));
  } finally {
    h.app.repo.setPairing = orig;
  }
  assert.match(lastText(u), /только что привязал/);
  await c.close();
});
