// protects=migration runner (idempotent, recorded in schema_migrations), callbacks lookup by short id with expiry (R15, ≤64 bytes),
//   one-time pairing codes under concurrent use, hourly cleanup thresholds (codes >1 d, message_sessions >30 d, delivered >7 d,
//   expired callbacks), admin CLI create/list (token shown once, only sha256 stored);
// fails_when=a migration runs twice, an expired callback resolves, two concurrent /start with one code both succeed,
//   cleanup deletes fresh rows or keeps stale ones, the plaintext token is stored;
// no_claim=Postgres versions other than 17
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { runAdmin, UsageError } from "../../src/admin/commands.ts";
import { migrate } from "../../src/db/migrate.ts";
import { Buttons } from "../../src/telegram/buttons.ts";
import { hashToken } from "../../src/ws/tokens.ts";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { makeConnector, SESSION } from "../helpers/harness.ts";

let db: TestDb;
before(async () => {
  db = await freshDb();
});
after(async () => {
  await db?.drop();
});

test("migrations are applied once", async () => {
  assert.deepEqual(await migrate(db.sql), []);
  const rows = await db.sql`select version from schema_migrations`;
  assert.deepEqual(rows.map((r) => r.version), ["001_init.sql"]);
});

test("callbacks: short ids ≤ 64 bytes, lookup returns payload, expired ids do not resolve", async () => {
  const { id } = await makeConnector(db.repo, "cb");
  const b = new Buttons(db.repo);
  const kb = await b.keyboard(id, [[{ label: "A", kind: "perm", payload: { r: "x".repeat(40), o: "allow-once" } }]], 60_000);
  const data = kb.inline_keyboard[0]![0]! as { callback_data: string };
  assert.ok(Buffer.byteLength(data.callback_data) <= 64);
  const row = await db.repo.callback(data.callback_data);
  assert.deepEqual([row?.kind, row?.payload], ["perm", { r: "x".repeat(40), o: "allow-once" }]);
  const short = await b.keyboard(id, [[{ label: "B", kind: "mode", payload: {} }]], 1);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(await db.repo.callback((short.inline_keyboard[0]![0]! as { callback_data: string }).callback_data), undefined);
});

test("pairing code is one-time even under concurrent consumption", async () => {
  const { id } = await makeConnector(db.repo, "codes");
  await db.repo.insertCode("abc", id, new Date(Date.now() + 60_000));
  const results = await Promise.all(Array.from({ length: 5 }, () => db.repo.consumeCode("abc")));
  assert.deepEqual(results.map((r) => r.status).sort(), ["ok", "used", "used", "used", "used"]);
});

test("cleanup removes only stale rows", async () => {
  const { id } = await makeConnector(db.repo, "clean");
  await db.repo.insertCode("old", id, new Date(Date.now() - 2 * 86400_000));
  await db.repo.insertCode("fresh", id, new Date(Date.now() - 3600_000));
  await db.repo.recordMessageSession(1, 1, id, SESSION);
  await db.repo.recordMessageSession(1, 2, id, SESSION);
  await db.sql`update message_sessions set created_at = now() - interval '31 days' where tg_message_id = 1`;
  await db.repo.markDelivered(id, "old");
  await db.repo.markDelivered(id, "fresh");
  await db.sql`update delivered set created_at = now() - interval '8 days' where msg_id = 'old'`;
  await db.repo.insertCallbacks([
    { short_id: "dead", connector_id: id, kind: "x", payload: {}, ttlMs: -1000 },
    { short_id: "live", connector_id: id, kind: "x", payload: {}, ttlMs: 60_000 },
  ]);
  const before = await db.repo.cleanup();
  assert.ok(before.pairing_codes >= 1 && before.message_sessions >= 1 && before.delivered >= 1 && before.callbacks >= 1);
  assert.deepEqual((await db.sql`select code from pairing_codes where connector_id = ${id}`).map((r) => r.code), ["fresh"]);
  assert.deepEqual((await db.sql`select tg_message_id from message_sessions where connector_id = ${id}`).map((r) => r.tg_message_id), [2]);
  assert.deepEqual((await db.sql`select msg_id from delivered where connector_id = ${id}`).map((r) => r.msg_id), ["fresh"]);
  assert.deepEqual((await db.sql`select short_id from callbacks where connector_id = ${id}`).map((r) => r.short_id), ["live"]);
});

test("admin CLI: create prints the token once and stores only its sha256; list; usage errors", async () => {
  const out = await runAdmin(["connectors", "create", "af99"], db.repo);
  const token = /token \(shown once\): (\S+)/.exec(out[1]!)![1]!;
  assert.equal(Buffer.from(token, "base64url").length, 32);
  const row = await db.repo.connectorByTokenHash(hashToken(token));
  assert.equal(row?.name, "af99");
  const stored = await db.sql`select token_sha256 from connectors where name = 'af99'`;
  assert.notEqual(stored[0]!.token_sha256.toString(), token);
  assert.match((await runAdmin(["connectors", "list"], db.repo)).find((l) => l.startsWith("af99"))!, /^af99\tactive\tunpaired\tlast seen never$/);
  await assert.rejects(runAdmin(["connectors", "create", "af99"], db.repo), UsageError);
  await assert.rejects(runAdmin(["connectors", "revoke", "nope"], db.repo), UsageError);
  await assert.rejects(runAdmin(["bogus"], db.repo), UsageError);
});
