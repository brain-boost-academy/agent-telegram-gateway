// protects=a share with a comment (two Telegram messages within a second) reaches the agent as one conversation.prompt:
//   texts and file captions joined in arrival order, files as attachments; a reply-comment carries the whole collection to
//   the replied session, two different replies stay separate; a pause longer than burstMs gives two prompts; the hold is
//   capped at burstMaxMs; a collection is sent before it passes 256 KB of text / 10 files; a command, voice or click
//   first sends what was collected; App.stop sends collected messages (also ones still queued behind slow work in their
//   chat), waiting at most stopFlushMs and logging what it gave up on;
// fails_when=the comment and the shared item become two prompts, a caption is dropped, differing replies merge, the timer
//   never fires or keeps waiting while messages keep coming, a mass forward becomes one frame over the protocol limit,
//   a command/voice/click overtakes a collected text,
//   a deploy silently drops the last second of messages or hangs on a slow connector;
// no_claim=the gap real Telegram clients leave between the two messages (measured once: same second), the production
//   1 s value (unit test), Kubernetes' SIGTERM grace period
import { after, before, mock, test } from "node:test";
import assert from "node:assert/strict";
import { freshDb, type TestDb } from "../helpers/db.ts";
import {
  callbackUpdate,
  FakeConnector,
  makeConnector,
  OWNER,
  photoUpdate,
  SESSION,
  sleep,
  startGateway,
  textUpdate,
  until,
  voiceUpdate,
  type Harness,
} from "../helpers/harness.ts";
import { log } from "../../src/log.ts";

const BURST = { burstMs: 300, burstMaxMs: 800 };

let db: TestDb;
let h: Harness;
let c: FakeConnector;
let cid: string;

before(async () => {
  db = await freshDb();
  h = await startGateway(db, { timings: BURST });
  const k = await makeConnector(db.repo, "burst", OWNER);
  cid = k.id;
  c = await FakeConnector.connect(h.wsUrl, k.token);
});
after(async () => {
  await c?.close();
  await h?.stop();
  await db?.drop();
});

type Prompt = { text: string; attachments?: string[]; session?: unknown };
const prompts = () => c.received("conversation.prompt").map((e) => e.payload as Prompt);
const waitPrompts = (n: number) => until(() => prompts().length >= n && prompts(), `${n} prompts`);

test("comment + shared link → one prompt, comment first", async () => {
  const n = prompts().length;
  await h.feedBurst(textUpdate(OWNER, "Расскажи подробнее что происходит здесь"), textUpdate(OWNER, "https://www.cve.org/CVERecord?id=CVE-2026-83844"));
  assert.equal(prompts().length, n, "nothing sent before the window closes");
  const ps = await waitPrompts(n + 1);
  await sleep(400);
  assert.equal(prompts().length, n + 1);
  assert.equal(ps.at(-1)!.text, "Расскажи подробнее что происходит здесь\n\nhttps://www.cve.org/CVERecord?id=CVE-2026-83844");
});

test("comment + captioned photo → one prompt with the text, the caption and the attachment", async () => {
  h.tg.files.set("bp1", Buffer.from("img"));
  const n = prompts().length;
  await h.feedBurst(textUpdate(OWNER, "Что это?"), photoUpdate(OWNER, "bp1", { caption: "скрин из MS Paint" }));
  const p = (await waitPrompts(n + 1)).at(-1)!;
  assert.equal(p.text, "Что это?\n\nскрин из MS Paint");
  assert.deepEqual(p.attachments, [(c.received("blob.begin").at(-1)!.payload as { blob_id: string }).blob_id]);
});

test("album with a caption on two items → both captions, all attachments", async () => {
  h.tg.files.set("ba1", Buffer.from("a"));
  h.tg.files.set("ba2", Buffer.from("b"));
  const n = prompts().length;
  await h.feedBurst(photoUpdate(OWNER, "ba1", { group: "bg", caption: "первое" }), photoUpdate(OWNER, "ba2", { group: "bg", caption: "второе" }));
  const p = (await waitPrompts(n + 1)).at(-1)!;
  assert.equal(p.text, "первое\n\nвторое");
  assert.equal(p.attachments?.length, 2);
});

test("a reply-comment + a plain link → one prompt to the replied message's session; two different replies → two prompts", async () => {
  await db.repo.recordMessageSession(OWNER.id, 7001, cid, SESSION);
  const other = { ...SESSION, session_id: "sess-other" };
  await db.repo.recordMessageSession(OWNER.id, 7002, cid, other);
  let n = prompts().length;
  await h.feedBurst(textUpdate(OWNER, "глянь", 7001), textUpdate(OWNER, "https://example.com"));
  const p = (await waitPrompts(n + 1)).at(-1)!;
  assert.equal(p.text, "глянь\n\nhttps://example.com");
  assert.deepEqual(p.session, SESSION);

  n = prompts().length;
  await h.feedBurst(textUpdate(OWNER, "первому", 7001), textUpdate(OWNER, "второму", 7002));
  const ps = await waitPrompts(n + 2);
  assert.deepEqual(
    ps.slice(n).map((x) => [x.text, x.session]),
    [
      ["первому", SESSION],
      ["второму", other],
    ],
  );
});

test("a collection is sent before it would pass 256 KB of text or 10 files", async () => {
  let n = prompts().length;
  const big = "x".repeat(150_000);
  await h.feedBurst(textUpdate(OWNER, big), textUpdate(OWNER, big));
  let ps = await waitPrompts(n + 2);
  assert.deepEqual(ps.slice(n).map((x) => x.text.length), [150_000, 150_000]);

  for (let i = 0; i < 11; i++) h.tg.files.set(`bm${i}`, Buffer.from(`f${i}`));
  n = prompts().length;
  await h.feedBurst(...Array.from({ length: 11 }, (_, i) => photoUpdate(OWNER, `bm${i}`, { group: "bm" })));
  ps = await waitPrompts(n + 2);
  assert.deepEqual(ps.slice(n).map((x) => x.attachments?.length), [10, 1]);
});

test("a pause longer than the window → two prompts", async () => {
  const n = prompts().length;
  await h.feedBurst(textUpdate(OWNER, "раз"));
  await sleep(600);
  await h.feedBurst(textUpdate(OWNER, "два"));
  const ps = await waitPrompts(n + 2);
  assert.deepEqual(ps.slice(n).map((x) => x.text), ["раз", "два"]);
});

test("messages that keep coming are sent burstMaxMs after the first one", async () => {
  const n = prompts().length;
  let firstAt = 0;
  const orig = c.handlers["conversation.prompt"]!;
  c.handlers["conversation.prompt"] = (p) => {
    firstAt ||= Date.now();
    return orig(p);
  };
  const t0 = Date.now();
  const sent: string[] = [];
  let lastFedAt = 0;
  try {
    for (let i = 0; Date.now() - t0 < 1200; i++) {
      sent.push(`m${i}`);
      await h.feedBurst(textUpdate(OWNER, `m${i}`));
      await sleep(50);
    }
    lastFedAt = Date.now();
    await until(() => prompts().slice(n).flatMap((x) => x.text.split("\n\n")).length === sent.length, "every part sent");
  } finally {
    c.handlers["conversation.prompt"] = orig;
  }
  assert.ok(firstAt - t0 >= 750, `first prompt after ${firstAt - t0} ms, expected ≈800`);
  assert.ok(firstAt < lastFedAt, "first prompt before the last part");
  assert.ok(prompts().length - n >= 2);
  assert.deepEqual(prompts().slice(n).flatMap((x) => x.text.split("\n\n")), sent);
});

test("a command, a voice and a click each send the collected text first", async () => {
  const orig = c.handlers["conversation.prompt"]!;
  let seen: { texts: number; cbAnswers: number } | undefined;
  c.handlers["conversation.prompt"] = (p) => {
    if (p.text === "до команды") seen = { texts: h.tg.texts(OWNER.id).length, cbAnswers: h.tg.of("answerCallbackQuery").length };
    return orig(p);
  };
  try {
    // command: the prompt is accepted before /help answers
    await h.feedBurst(textUpdate(OWNER, "до команды"), textUpdate(OWNER, "/help"));
    assert.ok(seen, "prompt sent");
    const helpAt = h.tg.texts(OWNER.id).findLastIndex((t) => t.includes("/new"));
    assert.ok(helpAt >= seen.texts, "help sent after the prompt");

    // voice: two prompts, the text first
    h.tg.files.set("bv1", Buffer.from("OggS"));
    h.asr.reply = { status: 200, text: "голосом" };
    let n = prompts().length;
    await h.feedBurst(textUpdate(OWNER, "текстом"), voiceUpdate(OWNER, "bv1"));
    assert.deepEqual(prompts().slice(n).map((x) => x.text), ["текстом", "голосом"]);

    // click: the prompt goes out before the click is answered
    seen = undefined;
    const cb = h.tg.of("answerCallbackQuery").length;
    await h.feedBurst(textUpdate(OWNER, "до команды"), callbackUpdate(OWNER, "no-such-callback"));
    assert.equal(seen!.cbAnswers, cb, "click not answered yet when the prompt arrived");
    assert.equal(h.tg.of("answerCallbackQuery").length, cb + 1);
    n = prompts().length;
    await sleep(400);
    assert.equal(prompts().length, n, "nothing left to send");
  } finally {
    c.handlers["conversation.prompt"] = orig;
  }
});

test("stop sends collected messages; a slow connector holds stop only for stopFlushMs and is logged", async () => {
  const sdb = await freshDb();
  try {
    // collected text, then stop → delivered
    let g = await startGateway(sdb, { timings: BURST });
    const k = await makeConnector(sdb.repo, "stop", OWNER);
    let sc = await FakeConnector.connect(g.wsUrl, k.token);
    await g.feedBurst(textUpdate(OWNER, "перед деплоем"));
    assert.equal(sc.received("conversation.prompt").length, 0);
    await g.stop();
    assert.deepEqual(
      sc.received("conversation.prompt").map((e) => (e.payload as Prompt).text),
      ["перед деплоем"],
    );
    await sc.close();

    // a text queued behind slow work in its chat (a voice in ASR) is collected after stop began → still delivered
    g = await startGateway(sdb, { timings: BURST });
    sc = await FakeConnector.connect(g.wsUrl, k.token);
    void g.app.gw.chats.run(OWNER.id, () => sleep(200));
    await g.app.bot.handleUpdate(textUpdate(OWNER, "за голосовым"));
    await g.stop();
    assert.deepEqual(
      sc.received("conversation.prompt").map((e) => (e.payload as Prompt).text),
      ["за голосовым"],
    );
    await sc.close();

    // the connector does not answer the prompt in time → stop returns after ≈stopFlushMs and warns
    g = await startGateway(sdb, { timings: { ...BURST, stopFlushMs: 200 } });
    sc = await FakeConnector.connect(g.wsUrl, k.token);
    sc.handlers["conversation.prompt"] = () => new Promise(() => {});
    const warn = mock.method(log, "warn", () => {});
    try {
      await g.feedBurst(textUpdate(OWNER, "не успеет"));
      const t0 = Date.now();
      await g.stop();
      const took = Date.now() - t0;
      assert.ok(took >= 190 && took < 2000, `stop took ${took} ms`);
      assert.equal(sc.received("conversation.prompt").length, 1, "the prompt was sent, just not answered");
      const call = warn.mock.calls.find((x) => x.arguments[0] === "pending messages not delivered on shutdown");
      assert.deepEqual(call?.arguments[1], { chats: 1, parts: 1, queues: 1 });
    } finally {
      warn.mock.restore();
    }
    await sc.close();
  } finally {
    await sdb.drop();
  }
});
