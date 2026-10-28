// protects=admin NOTIFY loss window: whenever the LISTEN connection (re)subscribes, the pairing caches are dropped, so an admin-CLI
//   unpair whose NOTIFY was lost during the reconnect stops the old owner at once instead of after the cache TTL;
// fails_when=after a LISTEN reconnect the gateway still routes the old owner's messages from its cached pairing;
// no_claim=notifications sent while LISTEN is down (Postgres drops them; only the cache flush is claimed here)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { FakeConnector, makeConnector, OWNER, startGateway, textUpdate, until, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;

before(async () => {
  db = await freshDb();
  h = await startGateway(db, { timings: { pairingTtlMs: 600_000 } });
});
after(async () => {
  await h?.stop();
  await db?.drop();
});

const listenPids = async () =>
  (await db.sql<{ pid: number }[]>`select pid from pg_stat_activity where datname = ${db.name} and query ilike 'listen%'`).map((r) => r.pid);

test("LISTEN reconnect drops cached pairings: an unpair whose NOTIFY was lost takes effect", async () => {
  const k = await makeConnector(db.repo, "listen", OWNER);
  const c = await FakeConnector.connect(h.wsUrl, k.token);
  await h.feed(textUpdate(OWNER, "первое"));
  await c.waitFor("conversation.prompt", (p: { text: string }) => p.text === "первое");
  // admin unpair while the LISTEN connection is down: the row is gone, the NOTIFY never arrives
  const [pid] = await until(listenPids, "listen backend");
  await db.sql`delete from pairings where connector_id = ${k.id}`;
  await db.sql`select pg_terminate_backend(${pid!})`;
  await until(async () => {
    const pids = await listenPids();
    return pids.length > 0 && !pids.includes(pid!);
  }, "LISTEN re-subscribed", 5000);
  await until(async () => {
    await h.feed(textUpdate(OWNER, "второе"));
    return /подключи телеграм/.test(h.tg.texts(OWNER.id).at(-1) ?? "");
  }, "old owner gets the pairing hint", 2000);
  assert.equal(c.received("conversation.prompt", (p: { text: string }) => p.text === "второе").length, 0);
  await c.close();
});
