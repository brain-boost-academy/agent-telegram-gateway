// protects=WS auth by token hash (ok / unknown / revoked → 4401), version negotiation (4400), welcome limits+pairing,
//   invalid frames keep the socket, one live socket per connector (4409, R5), R19 owner alert, admin revoke closes the live socket;
// fails_when=a revoked/unknown token gets a welcome, a second connection leaves two live sockets, an invalid frame drops the link,
//   repeated replacement from 2 IPs does not warn the owner (or warns twice within an hour), revoke leaves the socket open;
// no_claim=TLS/ingress behaviour, real network partitions (ping timeout covered only by the 30 s timer code path)
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { WebSocket } from "ws";
import { CloseCode } from "@brain-boost-academy/agent-protocol";
import { runAdmin } from "../../src/admin/commands.ts";
import { ConnectorLink } from "../../src/ws/link.ts";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { FakeConnector, HELLO, makeConnector, OWNER, sleep, startGateway, until, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;

before(async () => {
  db = await freshDb();
  h = await startGateway(db);
});
after(async () => {
  await h?.stop();
  await db?.drop();
});

test("valid token → welcome with limits and pairing info; last_seen_at updated", async () => {
  const { id, token } = await makeConnector(db.repo, "ok", OWNER);
  const c = await FakeConnector.connect(h.wsUrl, token);
  assert.deepEqual(c.welcome, {
    protocol: 1,
    gateway: { kind: "telegram", label: "Telegram", version: "0.1.0" },
    connector_id: id,
    limits: { max_inbound_file_bytes: 20 * 1024 * 1024, max_outbound_file_bytes: 50 * 1024 * 1024 },
    pairing: { paired: true, user_display: "@owner", conversation_id: String(OWNER.id) },
  });
  assert.ok((await db.repo.connectorById(id))?.last_seen_at);
  assert.equal(h.app.gw.registry.get(id)?.name, "ok");
  await c.close();
});

test("unknown or missing token → closed with 4401", async () => {
  const c1 = await FakeConnector.open(h.wsUrl, "nope");
  assert.equal(await c1.closed(), CloseCode.unauthorized);
  const c2 = await FakeConnector.open(h.wsUrl, undefined);
  assert.equal(await c2.closed(), CloseCode.unauthorized);
});

test("revoked token → 4401; admin revoke closes the live socket with 4401", async () => {
  const { token } = await makeConnector(db.repo, "rev");
  const live = await FakeConnector.connect(h.wsUrl, token);
  assert.deepEqual(await runAdmin(["connectors", "revoke", "rev"], db.repo), ["connector rev revoked"]);
  assert.equal(await live.closed(), CloseCode.unauthorized);
  const again = await FakeConnector.open(h.wsUrl, token);
  assert.equal(await again.closed(), CloseCode.unauthorized);
});

test("rotate-token: old token stops working, new one connects", async () => {
  const { token } = await makeConnector(db.repo, "rot");
  const live = await FakeConnector.connect(h.wsUrl, token);
  const out = await runAdmin(["connectors", "rotate-token", "rot"], db.repo);
  const fresh = /token \(shown once\): (\S+)/.exec(out[0]!)![1]!;
  assert.equal(await live.closed(), CloseCode.unauthorized);
  assert.equal(await (await FakeConnector.open(h.wsUrl, token)).closed(), CloseCode.unauthorized);
  const c = await FakeConnector.connect(h.wsUrl, fresh);
  assert.ok(c.welcome);
  await c.close();
});

test("no common protocol version → error unsupported_version + close 4400", async () => {
  const { token } = await makeConnector(db.repo, "v2");
  const c = await FakeConnector.open(h.wsUrl, token);
  c.peer.send("hello", { ...HELLO, protocol: { min: 2, max: 3 } });
  assert.equal(await c.closed(), CloseCode.unsupportedVersion);
  assert.equal((c.received("error")[0]?.payload as { code: string }).code, "unsupported_version");
});

test("invalid frames → error invalid_message, connection stays usable", async () => {
  const { token } = await makeConnector(db.repo, "bad", OWNER);
  const c = await FakeConnector.connect(h.wsUrl, token);
  c.ws.send("not json");
  c.ws.send(JSON.stringify({ v: 1, id: "x1", type: "notify", ts: "t", payload: { notify_id: "n", switched: false } }));
  c.ws.send(JSON.stringify({ v: 1, id: "x2", type: "welcome", ts: "t", payload: {} }));
  await until(() => c.received("error").length >= 3, "3 errors");
  assert.deepEqual(c.received("error").map((e) => (e.payload as { code: string }).code), ["invalid_message", "invalid_message", "invalid_message"]);
  assert.deepEqual(c.received("error").map((e) => e.re), [undefined, "x1", "x2"]);
  const status = await c.request("pairing.status", {});
  assert.equal(status.paired, true);
  await c.close();
});

test("second connection replaces the first with 4409; ≥3 replacements from 2 IPs warn the owner once (R19)", async () => {
  const { id, token } = await makeConnector(db.repo, "dup", OWNER);
  const ip = (a: string) => ({ "x-forwarded-for": a });
  const first = await FakeConnector.connect(h.wsUrl, token, { headers: ip("10.0.0.1") });
  const second = await FakeConnector.connect(h.wsUrl, token, { headers: ip("10.0.0.2") });
  assert.equal(await first.closed(), CloseCode.replaced);
  assert.equal(h.app.gw.registry.get(id)?.ip, "10.0.0.2");
  const alerts = () => h.tg.texts(OWNER.id).filter((t) => t.includes("подключаются из двух мест"));
  assert.equal(alerts().length, 0);
  const third = await FakeConnector.connect(h.wsUrl, token, { headers: ip("10.0.0.1") });
  assert.equal(await second.closed(), CloseCode.replaced);
  const fourth = await FakeConnector.connect(h.wsUrl, token, { headers: ip("10.0.0.2") });
  assert.equal(await third.closed(), CloseCode.replaced);
  await until(() => alerts().length === 1, "owner alert");
  assert.match(alerts()[0]!, /«dup».*10\.0\.0\.1, 10\.0\.0\.2/);
  const fifth = await FakeConnector.connect(h.wsUrl, token, { headers: ip("10.0.0.1") });
  assert.equal(await fourth.closed(), CloseCode.replaced);
  assert.equal(alerts().length, 1, "at most once per hour");
  // the live link is the newest one
  const st = await fifth.request("pairing.status", {});
  assert.equal(st.paired, true);
  await fifth.close();
});

test("non /v1/connect path is rejected", async () => {
  const ws = new WebSocket(h.wsUrl.replace("/v1/connect", "/other"));
  const err = await new Promise<Error>((r) => ws.once("error", r));
  assert.match(err.message, /404/);
});

test("2 missed pongs → gateway drops the link and forgets it", async () => {
  const fast = await startGateway(db, { pingIntervalMs: 60 });
  try {
    const { id, token } = await makeConnector(db.repo, "silent");
    const c = await FakeConnector.connect(fast.wsUrl, token);
    await until(() => fast.app.gw.registry.get(id), "registered");
    // stop reading: pings stay unanswered
    (c.ws as unknown as { _socket: { pause(): void } })._socket.pause();
    await until(() => !fast.app.gw.registry.get(id), "link dropped", 2000);
  } finally {
    await fast.stop();
  }
});

// protects=auth robustness: a database error during the token lookup is "try again" (not 4401, which makes connectors back off 5 min),
//   a socket that died while its token was being looked up never replaces the live link, a token revoked or rotated without the admin
//   NOTIFY (lost notification) is caught before welcome and on the next ping tick;
// fails_when=a Postgres outage closes with 4401, a dead socket closes the live one with 4409 or stays in the registry, a revoked/rotated
//   token keeps a live link until the process restarts;
// no_claim=how the connector itself backs off after 1013 (connector side)
test("database error during the token lookup → close 1013 (try again), not 4401", async () => {
  const { token } = await makeConnector(db.repo, "dberr");
  const orig = h.app.repo.connectorByTokenHash;
  h.app.repo.connectorByTokenHash = async () => {
    throw new Error("connection terminated");
  };
  try {
    const c = await FakeConnector.open(h.wsUrl, token);
    assert.equal(await until(() => c.closeCode, "closed", 2000), 1013);
  } finally {
    h.app.repo.connectorByTokenHash = orig;
  }
});

test("a socket that closes while its token is looked up does not replace the live link", async () => {
  const { id, token } = await makeConnector(db.repo, "slowauth", OWNER);
  const live = await FakeConnector.connect(h.wsUrl, token, { headers: { "x-forwarded-for": "10.1.0.1" } });
  await until(() => h.app.gw.registry.get(id), "live link");
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const orig = h.app.repo.connectorByTokenHash;
  h.app.repo.connectorByTokenHash = async (t) => {
    await gate;
    return orig.call(h.app.repo, t);
  };
  try {
    const dead = await FakeConnector.open(h.wsUrl, token, { "x-forwarded-for": "10.1.0.2" });
    dead.peer.send("hello", HELLO);
    await sleep(30);
    dead.ws.terminate();
    await sleep(50);
  } finally {
    h.app.repo.connectorByTokenHash = orig;
    release();
  }
  await sleep(150);
  assert.equal(live.closeCode, undefined, "live link must stay open");
  assert.equal(h.app.gw.registry.get(id)?.ip, "10.1.0.1");
  await live.close();
});

test("token revoked between the lookup and hello (NOTIFY lost) → no welcome, 4401", async () => {
  const { id, token } = await makeConnector(db.repo, "revrace");
  const orig = h.app.repo.connectorByTokenHash;
  h.app.repo.connectorByTokenHash = async (t) => {
    const row = await orig.call(h.app.repo, t);
    await db.sql`update connectors set revoked_at = now() where id = ${id}`;
    return row;
  };
  try {
    const c = await FakeConnector.open(h.wsUrl, token);
    await sleep(50);
    c.peer.send("hello", HELLO);
    assert.equal(await until(() => c.closeCode, "closed", 2000), CloseCode.unauthorized);
    assert.equal(c.received("welcome").length, 0);
  } finally {
    h.app.repo.connectorByTokenHash = orig;
  }
});

test("revoke or rotate without NOTIFY → the live link is closed with 4401 on the next ping tick", async () => {
  const fast = await startGateway(db, { pingIntervalMs: 60 });
  try {
    const a = await makeConnector(db.repo, "revnotify");
    const b = await makeConnector(db.repo, "rotnotify");
    const ca = await FakeConnector.connect(fast.wsUrl, a.token);
    const cb = await FakeConnector.connect(fast.wsUrl, b.token);
    await db.sql`update connectors set revoked_at = now() where id = ${a.id}`;
    await db.sql`update connectors set token_sha256 = ${Buffer.alloc(32, 7)} where id = ${b.id}`;
    await until(() => ca.closeCode, "revoked link closed", 2000);
    await until(() => cb.closeCode, "rotated link closed", 2000);
    assert.equal(ca.closeCode, CloseCode.unauthorized);
    assert.equal(cb.closeCode, CloseCode.unauthorized);
  } finally {
    await fast.stop();
  }
});

// protects=a failure while setting up an authenticated link (blob temp dir) is a "try again" close, not an unhandled rejection;
// fails_when=mkdtemp throwing leaves the socket open forever or crashes the process;
// no_claim=which filesystem errors occur in production
test("link setup failure (blob temp dir) → close 1013, process keeps running", async () => {
  const { token } = await makeConnector(db.repo, "nodir");
  const orig = ConnectorLink.open;
  ConnectorLink.open = async () => {
    throw new Error("EACCES: permission denied, mkdtemp");
  };
  try {
    const c = await FakeConnector.open(h.wsUrl, token);
    assert.equal(await until(() => c.closeCode, "closed", 2000), 1013);
  } finally {
    ConnectorLink.open = orig;
  }
  const ok = await FakeConnector.connect(h.wsUrl, token);
  assert.ok(ok.welcome);
  await ok.close();
});
