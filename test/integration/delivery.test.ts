// protects=protocol 1.2.0 delivery contract on the gateway side: an undeliverable durable is answered `error internal` (transient:
//   Telegram 429/5xx, database) or a terminal code (`not_paired` for a blocked bot / a chat that is no longer the owner's,
//   `invalid_message` for other Bot API 400s); `turn.error` is durable (key turn:<id>); rendered turns missing from `sync.running_turns`
//   are closed as interrupted (a later turn.ended still completes them); answers to requests still in `sync.pending` are re-sent and
//   forms of requests no longer pending are dropped; a failed blob.begin is reported again on blob.end with the original code;
//   slow requests get 120 s; the per-connector pairing cache expires (lost admin NOTIFY);
// fails_when=a transient failure is silently dropped (connector waits 60 s) or acked, a permanent failure is retried forever,
//   a durable for a foreign chat is acked as delivered, turn.error is never acked or shown twice, a turn stays «Работаю» forever after
//   the connector restarted, a lost permission.respond leaves the agent waiting until timeout, blob.end after a too_large begin
//   says invalid_message, conversation.prompt times out after 30 s, an old pairing keeps receiving messages forever;
// no_claim=connector-side retry/backoff (connector tests), real Telegram error texts beyond the ones mirrored here
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InputFile } from "grammy";
import { sendBufferBlob } from "@brain-boost-academy/agent-protocol";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { callbackUpdate, FakeConnector, makeConnector, OWNER, SESSION, sleep, startGateway, textUpdate, until, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;
let token: string;
let cid: string;
let c: FakeConnector;

before(async () => {
  db = await freshDb();
  h = await startGateway(db, { timings: { pairingTtlMs: 150 } });
  const k = await makeConnector(db.repo, "deliv", OWNER);
  token = k.token;
  cid = k.id;
  c = await FakeConnector.connect(h.wsUrl, token);
});
after(async () => {
  await c?.close();
  await h?.stop();
  await db?.drop();
});

const chat = String(OWNER.id);
type Err = { code: string; message: string };
const code = async (conn: FakeConnector, envId: string) =>
  ((await until(() => conn.inbox.find((e) => e.type === "error" && e.re === envId), `error re ${envId}`)).payload as Err).code;

test("Telegram 429 / 5xx while showing a notify → error internal (retry), nothing recorded", async () => {
  h.tg.failNext("sendMessage", 1, 429, "Too Many Requests: retry after 5");
  const e1 = c.send("notify", { notify_id: "t429", text: "a", switched: false });
  assert.equal(await code(c, e1.id), "internal");
  h.tg.failNext("sendMessage", 1, 502, "Bad Gateway");
  const e2 = c.send("notify", { notify_id: "t502", text: "b", switched: false });
  assert.equal(await code(c, e2.id), "internal");
  assert.equal(await db.repo.isDelivered(cid, "notify:t429"), false);
  assert.equal(c.received("delivered", (p: { id: string }) => p.id === "notify:t429").length, 0);
});

test("bot blocked by the user (403) → terminal not_paired; other Bot API 400 → invalid_message", async () => {
  h.tg.failNext("sendMessage", 1, 403, "Forbidden: bot was blocked by the user");
  const e1 = c.send("notify", { notify_id: "t403", text: "a", switched: false });
  assert.equal(await code(c, e1.id), "not_paired");
  h.tg.failNext("sendMessage", 1, 400, "Bad Request: chat not found");
  const e2 = c.send("notify", { notify_id: "t400c", text: "a", switched: false });
  assert.equal(await code(c, e2.id), "not_paired");
  h.tg.failNext("sendMessage", 1, 400, "Bad Request: BUTTON_DATA_INVALID");
  const e3 = c.send("notify", { notify_id: "t400", text: "a", switched: false });
  assert.equal(await code(c, e3.id), "invalid_message");
});

test("database error while checking/recording delivery → error internal", async () => {
  const orig = h.app.repo.isDelivered;
  h.app.repo.isDelivered = async () => {
    throw new Error("connection terminated");
  };
  try {
    const e = c.send("notify", { notify_id: "tdb", text: "db", switched: false });
    assert.equal(await code(c, e.id), "internal");
  } finally {
    h.app.repo.isDelivered = orig;
  }
});

test("durable addressed to a chat that is not the owner's → not_paired, not acked", async () => {
  const e = c.send("notify", { notify_id: "tother", conversation_id: "424242", text: "чужой", switched: false });
  assert.equal(await code(c, e.id), "not_paired");
  await sleep(50);
  assert.equal(await db.repo.isDelivered(cid, "notify:tother"), false);
  assert.equal(c.received("delivered", (p: { id: string }) => p.id === "notify:tother").length, 0);
});

test("turn.error is durable: acked as turn:<id>, a resend is not shown twice", async () => {
  c.send("turn.started", { turn_id: "te", conversation_ids: [chat], session: SESSION });
  await until(() => h.tg.texts(OWNER.id).some((t) => t.includes("Работаю")), "status");
  c.send("turn.error", { turn_id: "te", conversation_ids: [chat], session: SESSION, message: "agent crashed" });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "turn:te");
  const calls = h.tg.calls.length;
  c.send("turn.error", { turn_id: "te", conversation_ids: [chat], session: SESSION, message: "agent crashed" });
  await until(() => c.received("delivered", (p: { id: string }) => p.id === "turn:te").length === 2, "second ack");
  assert.equal(h.tg.calls.length, calls);
});

test("a rendered turn missing from sync.running_turns is closed as interrupted; a later turn.ended still completes it", async () => {
  c.send("turn.started", { turn_id: "ti", conversation_ids: [chat], session: SESSION });
  c.send("session.update", { conversation_ids: [chat], session: SESSION, turn_id: "ti", update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "Частичный ответ" } } });
  await until(() => h.tg.texts(OWNER.id).includes("Частичный ответ"), "partial answer");
  const statusId = h.tg.messageId(/Работаю/);
  const statusSends = h.tg.texts(OWNER.id).filter((t) => t.includes("Работаю")).length;
  await c.close();
  c = await FakeConnector.connect(h.wsUrl, token, { sync: { conversations: [], running_turns: [], pending: [] } });
  const lastStatus = () => String([...h.tg.calls].reverse().find((x) => x.method === "editMessageText" && x.payload.message_id === statusId)?.payload.text);
  await until(() => /прервано/.test(lastStatus()), "status shows interrupted");
  assert.equal(h.tg.texts(OWNER.id).filter((t) => t === "Частичный ответ").length, 1, "answer kept, not re-sent");

  c.send("turn.ended", { turn_id: "ti", conversation_ids: [chat], session: SESSION, stop_reason: "end_turn", duration_ms: 3000, tool_calls: 0, text: "Частичный ответ и конец" });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "turn:ti");
  assert.equal(lastStatus(), "✓ 0 шагов · 3 с");
  assert.ok(h.tg.calls.some((x) => x.method === "editMessageText" && x.payload.text === "Частичный ответ и конец"));
  assert.equal(h.tg.texts(OWNER.id).filter((t) => t.includes("Работаю")).length, statusSends, "no new status message");
});

const permission = (request_id: string) => ({
  request_id,
  conversation_ids: [chat],
  session: SESSION,
  params: { toolCall: { toolCallId: "tc", title: "Bash" }, options: [{ optionId: "allow-once", name: "Yes", kind: "allow_once" }, { optionId: "reject", name: "No", kind: "reject_once" }] },
});
const question = (request_id: string) => ({
  request_id,
  conversation_ids: [chat],
  session: SESSION,
  params: { mode: "form", message: `Вопрос ${request_id}`, requestedSchema: { properties: { q: { type: "string", title: "Цвет", oneOf: [{ const: "Red", title: "Red" }] }, q_custom: { type: "string", title: "Other" } } } },
});

test("answers to requests still pending after a reconnect are re-sent, not re-shown; resolved ones are not", async () => {
  c.send("permission.request", permission("lp1"));
  c.send("elicitation.request", question("le1"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:le1");
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Разрешить\?/)[0]!.data, h.tg.messageId(/Разрешить\?/)));
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Вопрос le1/)[0]!.data, h.tg.messageId(/Вопрос le1/)));
  await c.waitFor("elicitation.respond");
  const shown = h.tg.texts(OWNER.id).length;
  await c.close();
  // the answers were lost: the connector still waits on both
  c = await FakeConnector.connect(h.wsUrl, token, {
    sync: { conversations: [], running_turns: [], pending: [{ kind: "permission", ...permission("lp1") }, { kind: "elicitation", ...question("le1") }] },
  });
  const perm = await c.waitFor("permission.respond");
  assert.deepEqual(perm.payload, { request_id: "lp1", outcome: { outcome: "selected", optionId: "allow-once" } });
  const elic = await c.waitFor("elicitation.respond");
  assert.deepEqual(elic.payload, { request_id: "le1", action: "accept", content: { q: "Red" } });
  assert.equal(h.tg.texts(OWNER.id).length, shown, "nothing shown again");

  c.send("permission.resolved", { request_id: "lp1", by: "user", outcome: { outcome: "selected", optionId: "allow-once" } });
  c.send("elicitation.resolved", { request_id: "le1", by: "user" });
  await sleep(50);
  await c.close();
  c = await FakeConnector.connect(h.wsUrl, token, {
    sync: { conversations: [], running_turns: [], pending: [{ kind: "permission", ...permission("lp1") }] },
  });
  await sleep(100);
  assert.equal(c.received("permission.respond").length, 0, "resolved request is not answered again");
});

test("a form whose request is no longer pending after a reconnect is dropped: armed text becomes a normal prompt", async () => {
  c.send("elicitation.request", question("le2"));
  await c.waitFor("delivered", (p: { id: string }) => p.id === "req:le2");
  await h.feed(callbackUpdate(OWNER, h.tg.buttons(/Вопрос le2/).find((b) => b.text === "✍️ Свой вариант")!.data));
  assert.ok(h.app.gw.arming.get(OWNER.id));
  await c.close();
  c = await FakeConnector.connect(h.wsUrl, token, { sync: { conversations: [], running_turns: [], pending: [] } });
  await until(() => h.app.gw.registry.get(cid) && !h.app.gw.arming.get(OWNER.id), "disarmed by sync");
  await h.feed(textUpdate(OWNER, "обычный текст"));
  await c.waitFor("conversation.prompt", (p: { text: string }) => p.text === "обычный текст");
});

test("blob.begin rejected (too large) → the later blob.end gets the original too_large", async () => {
  const id = randomUUID();
  c.send("blob.begin", { blob_id: id, name: "big.bin", mime: "application/octet-stream", size: 51 * 1024 * 1024, sha256: "0".repeat(64) });
  c.send("blob.chunk", { blob_id: id, index: 0, data: Buffer.from("x").toString("base64") });
  const end = c.send("blob.end", { blob_id: id });
  const err = await until(() => c.inbox.find((e) => e.type === "error" && e.re === end.id), "blob.end error");
  assert.equal((err.payload as Err).code, "too_large");
});

test("conversation.prompt, session.new and session.attach wait 120 s", async () => {
  const link = h.app.gw.registry.get(cid)!;
  const seen: Array<[string, number | undefined]> = [];
  const orig = link.peer.request.bind(link.peer);
  link.peer.request = ((type: never, payload: never, opts?: { timeoutMs?: number }) => {
    seen.push([type, opts?.timeoutMs]);
    return orig(type, payload, opts);
  }) as typeof link.peer.request;
  c.handlers["session.attach"] = (p) => ({ session: p.session });
  await h.feed(textUpdate(OWNER, "привет"));
  await h.feed(textUpdate(OWNER, "/new"));
  await h.feed(textUpdate(OWNER, "/stop"));
  await h.app.gw.buttons.keyboard(cid, [[{ label: "s", kind: "attach", payload: { s: SESSION, t: "" } }]], 60_000);
  const row = await db.sql<{ short_id: string }[]>`select short_id from callbacks where kind = 'attach' order by created_at desc limit 1`;
  await h.feed(callbackUpdate(OWNER, row[0]!.short_id));
  assert.deepEqual(seen, [
    ["conversation.prompt", 120_000],
    ["session.new", 120_000],
    ["session.cancel", undefined],
    ["session.attach", 120_000],
  ]);
});

test("a text message reads the sender's pairing from Postgres at most once (cached next to the connector pairing)", async () => {
  const orig = h.app.repo.pairingByUser;
  let reads = 0;
  h.app.repo.pairingByUser = async (id) => {
    reads++;
    return orig.call(h.app.repo, id);
  };
  try {
    h.app.gw.invalidatePairing(cid);
    await h.feed(textUpdate(OWNER, "раз"));
    await h.feed(textUpdate(OWNER, "два"));
    await c.waitFor("conversation.prompt", (p: { text: string }) => p.text === "два");
    assert.ok(reads <= 1, `pairingByUser read ${reads} times for two messages`);
  } finally {
    h.app.repo.pairingByUser = orig;
  }
});

// protects=notify blobs and partial sends across resends: a resent notify (already delivered, or joining a delivery in flight)
//   still consumes and deletes its blobs; text parts / files Telegram already accepted are not sent again on retry;
// fails_when=blobs of skipped resends pile up until every blob.begin fails (maxOpen) and their files stay on disk, a retry after
//   a failure on the 2nd part or 2nd file duplicates the 1st one in the chat;
// no_claim=a gateway restart between partial sends (progress is in memory; the duplicate is accepted, R9)
test("a resent, already delivered notify still consumes its blobs: 20 resends do not exhaust the receiver", async () => {
  const data = Buffer.from("report body");
  const meta = { name: "report.txt", mime: "text/plain" };
  const first = await sendBufferBlob(c.peer, data, meta);
  c.send("notify", { notify_id: "gblob", text: "Отчёт", files: [first.blob_id], switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:gblob");
  const acks = () => c.received("delivered", (p: { id: string }) => p.id === "notify:gblob").length;
  const ids: string[] = [];
  for (let i = 0; i < 20; i++) {
    const b = await sendBufferBlob(c.peer, data, meta);
    ids.push(b.blob_id);
    c.send("notify", { notify_id: "gblob", text: "Отчёт", files: [b.blob_id], switched: false });
    await until(() => acks() === i + 2, `ack ${i + 2}`);
  }
  const link = h.app.gw.registry.get(cid)!;
  for (const id of ids) assert.equal(link.blobs.take(id), undefined, "blob left in the receiver");
  const dirs = (await readdir(tmpdir())).filter((d) => d.startsWith("gw-blobs-"));
  const files = (await Promise.all(dirs.map((d) => readdir(join(tmpdir(), d)).catch(() => [] as string[])))).flat();
  for (const id of ids) assert.ok(!files.some((f) => f.includes(id)), `blob file ${id} left on disk`);
  assert.equal(h.tg.of("sendDocument").filter((x) => !x.failed && (x.payload.document as InputFile).filename === "report.txt").length, 1);
});

test("notify delivery resumes: parts and files Telegram accepted before a transient failure are not sent again", async () => {
  const text = `${"А".repeat(3000)}\n${"Б".repeat(3000)}`;
  const blobs = async () =>
    [
      (await sendBufferBlob(c.peer, Buffer.from("one"), { name: "d1.txt", mime: "text/plain" })).blob_id,
      (await sendBufferBlob(c.peer, Buffer.from("two"), { name: "d2.txt", mime: "text/plain" })).blob_id,
    ];
  h.tg.failNext("sendMessage", 1, 429, "Too Many Requests: retry after 1", 1);
  const e1 = c.send("notify", { notify_id: "gres", text, files: await blobs(), switched: false });
  assert.equal(await code(c, e1.id), "internal");
  h.tg.failNext("sendDocument", 1, 502, "Bad Gateway", 1);
  const e2 = c.send("notify", { notify_id: "gres", text, files: await blobs(), switched: false });
  assert.equal(await code(c, e2.id), "internal");
  c.send("notify", { notify_id: "gres", text, files: await blobs(), switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:gres");
  const ok = (m: string) => h.tg.of(m, OWNER.id).filter((x) => !x.failed);
  assert.equal(ok("sendMessage").filter((x) => String(x.payload.text).startsWith("А")).length, 1, "part 1 once");
  assert.equal(ok("sendMessage").filter((x) => String(x.payload.text).startsWith("Б")).length, 1, "part 2 once");
  const docs = ok("sendDocument").map((x) => (x.payload.document as InputFile).filename);
  assert.equal(docs.filter((n) => n === "d1.txt").length, 1, "file 1 once");
  assert.equal(docs.filter((n) => n === "d2.txt").length, 1, "file 2 once");
});

// protects=notify retries stay exact: progress survives until `delivered` is recorded, files already shown are recognised by
//   identity (name + size) even when the resend carries fewer files, a notify whose blobs the receiver expired is retried
//   (`internal`) rather than dropped;
// fails_when=a markDelivered failure makes the retry re-send everything, a file that shifted position on the resend is skipped and
//   never shown, an expired blob turns the notify into a terminal invalid_message;
// no_claim=connector-side choice of which files to resend (it omits files that vanished from disk)
test("markDelivered fails once → the retry sends nothing again and acks", async () => {
  const text = `${"В".repeat(3000)}\n${"Г".repeat(3000)}`;
  const orig = h.app.repo.markDelivered;
  let failed = false;
  h.app.repo.markDelivered = async (id, key) => {
    if (!failed && key === "notify:gmark") {
      failed = true;
      throw new Error("connection terminated");
    }
    return orig.call(h.app.repo, id, key);
  };
  try {
    const e1 = c.send("notify", { notify_id: "gmark", text, switched: false });
    assert.equal(await code(c, e1.id), "internal");
    c.send("notify", { notify_id: "gmark", text, switched: false });
    await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:gmark");
  } finally {
    h.app.repo.markDelivered = orig;
  }
  const ok = h.tg.of("sendMessage", OWNER.id).filter((x) => !x.failed);
  assert.equal(ok.filter((x) => String(x.payload.text).startsWith("В")).length, 1, "part 1 once");
  assert.equal(ok.filter((x) => String(x.payload.text).startsWith("Г")).length, 1, "part 2 once");
});

test("resend with fewer files (one vanished) → files are matched by identity, none is skipped", async () => {
  const blob = async (name: string, body: string) => (await sendBufferBlob(c.peer, Buffer.from(body), { name, mime: "text/plain" })).blob_id;
  h.tg.failNext("sendDocument", 1, 502, "Bad Gateway", 1);
  const e1 = c.send("notify", { notify_id: "gid", text: "Три файла", files: [await blob("f1.txt", "one"), await blob("f2.txt", "two!"), await blob("f3.txt", "three")], switched: false });
  assert.equal(await code(c, e1.id), "internal");
  // f1 was shown; on the retry the connector resends only f2 and f3
  c.send("notify", { notify_id: "gid", text: "Три файла", files: [await blob("f2.txt", "two!"), await blob("f3.txt", "three")], switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:gid");
  const docs = h.tg.of("sendDocument", OWNER.id).filter((x) => !x.failed).map((x) => (x.payload.document as InputFile).filename);
  for (const n of ["f1.txt", "f2.txt", "f3.txt"]) assert.equal(docs.filter((d) => d === n).length, 1, `${n} once`);
  assert.equal(h.tg.texts(OWNER.id).filter((t) => t === "Три файла").length, 1);
});

test("notify referencing an expired blob → internal (connector resends fresh blobs); a never-seen id stays invalid_message", async () => {
  const short = await startGateway(db, { blobDoneTtlMs: 50 });
  const owner = { id: 8901, username: "exp" };
  const k = await makeConnector(db.repo, "expiry", owner);
  const cc = await FakeConnector.connect(short.wsUrl, k.token);
  try {
    const stored = await sendBufferBlob(cc.peer, Buffer.from("late"), { name: "late.txt", mime: "text/plain" });
    await sleep(200);
    const e1 = cc.send("notify", { notify_id: "gexp", text: "поздно", files: [stored.blob_id], switched: false });
    assert.equal(await code(cc, e1.id), "internal");
    const e2 = cc.send("notify", { notify_id: "gnever", text: "никогда", files: [randomUUID()], switched: false });
    assert.equal(await code(cc, e2.id), "invalid_message");
  } finally {
    await cc.close();
    await short.stop();
  }
});

test("pairing cache expires: a pairing changed without NOTIFY is picked up after the TTL", async () => {
  const other = { id: 8801, username: "newowner" };
  await db.repo.setPairing({ connector_id: cid, tg_user_id: other.id, tg_chat_id: other.id, user_display: "@newowner" });
  await sleep(250);
  c.send("notify", { notify_id: "ttl1", text: "куда?", switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:ttl1");
  assert.deepEqual(h.tg.texts(other.id), ["куда?"]);
  assert.ok(!h.tg.texts(OWNER.id).includes("куда?"));
});
