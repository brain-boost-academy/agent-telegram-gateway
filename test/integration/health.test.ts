// protects=/healthz (process) and /readyz (DB + getMe) endpoints;
// fails_when=readyz is 200 while the database is unreachable, or the paths change;
// no_claim=real Telegram reachability (getMe answered by the fake Bot API)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { startGateway, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;
let base: string;

before(async () => {
  db = await freshDb();
  h = await startGateway(db);
  base = `http://127.0.0.1:${await h.app.listenHealth(0)}`;
});
after(async () => {
  await h?.stop();
  await db?.drop();
});

test("healthz and readyz", async () => {
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  const r = await fetch(`${base}/readyz`);
  assert.equal(r.status, 200);
  assert.ok(h.tg.of("getMe").length >= 1);
  assert.equal((await fetch(`${base}/nope`)).status, 404);
});

test("readyz fails when the database is gone", async () => {
  await db.sql.end({ timeout: 1 });
  assert.equal(await h.app.ready(true), false);
});
