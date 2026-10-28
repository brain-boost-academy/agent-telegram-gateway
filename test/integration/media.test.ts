// protects=Flow 3 voice → download (Bot API file URL) → ASR (multipart + Bearer) → «🎤 text» reply → prompt origin voice;
//   ASR error → «Не удалось распознать» and no prompt; Flow 4 photo album (media_group_id debounce) → blob upload with sendBufferBlob,
//   one prompt with all attachments + caption; outbound notify.files via BlobReceiver → sendDocument; >50 MB blob → too_large;
// fails_when=a prompt is sent after an ASR failure, album items become separate prompts, attachments reference blobs the connector
//   did not store, a notify file is not sent as a document, an oversize blob is accepted;
// no_claim=giga-runner's real decoding of ogg/opus (spike d, manual), Telegram's 20 MB download limit enforcement on its side
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { InputFile } from "grammy";
import { BLOB_CHUNK_BYTES } from "@brain-boost-academy/agent-protocol";
import { freshDb, type TestDb } from "../helpers/db.ts";
import { FakeConnector, makeConnector, OWNER, photoUpdate, startGateway, until, voiceUpdate, type Harness } from "../helpers/harness.ts";

let db: TestDb;
let h: Harness;
let c: FakeConnector;

before(async () => {
  db = await freshDb();
  h = await startGateway(db);
  c = await FakeConnector.connect(h.wsUrl, (await makeConnector(db.repo, "af40", OWNER)).token);
});
after(async () => {
  await c?.close();
  await h?.stop();
  await db?.drop();
});

test("voice → ASR → «🎤 text» → prompt with origin voice", async () => {
  h.tg.files.set("voice1", Buffer.from("OggS\0voice-bytes"));
  h.asr.reply = { status: 200, text: "покажи календарь" };
  await h.feed(voiceUpdate(OWNER, "voice1"));
  assert.equal(h.asr.requests.at(-1)?.auth, "Bearer asr-key");
  assert.equal(h.asr.requests.at(-1)?.filename, "voice.oga");
  const reply = h.tg.of("sendMessage", OWNER.id).at(-1)!;
  assert.equal(reply.payload.text, "🎤 покажи календарь");
  assert.ok((reply.payload.reply_parameters as { message_id: number }).message_id > 0, "reply to the voice message");
  const p = await c.waitFor("conversation.prompt");
  assert.deepEqual(p.payload, { conversation_id: String(OWNER.id), text: "покажи календарь", origin: "voice" });
});

test("ASR failure (429) → «Не удалось распознать», no prompt", async () => {
  const prompts = c.received("conversation.prompt").length;
  h.tg.files.set("voice2", Buffer.from("OggS"));
  h.asr.reply = { status: 429, text: "" };
  await h.feed(voiceUpdate(OWNER, "voice2"));
  assert.equal(h.tg.texts(OWNER.id).at(-1), "Не удалось распознать");
  assert.equal(c.received("conversation.prompt").length, prompts);
  // >20 MB never downloaded
  await h.feed(voiceUpdate(OWNER, "voice3", 21 * 1024 * 1024));
  assert.match(h.tg.texts(OWNER.id).at(-1)!, /больше 20 МБ/);
});

test("photo album → two blobs stored by the connector → one prompt with both attachments and the caption", async () => {
  const a = Buffer.alloc(BLOB_CHUNK_BYTES + 10, 1);
  const b = Buffer.from("second image");
  h.tg.files.set("ph1", a);
  h.tg.files.set("ph2", b);
  const before = c.received("conversation.prompt").length;
  await h.feed(photoUpdate(OWNER, "ph1", { group: "g1", caption: "Что на фото?" }));
  await h.feed(photoUpdate(OWNER, "ph2", { group: "g1" }));
  const p = await c.waitFor("conversation.prompt", (x: { attachments?: string[] }) => (x.attachments?.length ?? 0) === 2);
  assert.equal(c.received("conversation.prompt").length, before + 1);
  const payload = p.payload as { text: string; attachments: string[]; origin: string };
  assert.equal(payload.text, "Что на фото?");
  const begins = c.received("blob.begin").map((e) => e.payload as { blob_id: string; sha256: string; mime: string; name: string });
  assert.deepEqual(payload.attachments, begins.slice(-2).map((x) => x.blob_id));
  assert.equal(begins.at(-2)!.sha256, createHash("sha256").update(a).digest("hex"));
  assert.equal(begins.at(-2)!.mime, "image/jpeg");
  assert.match(begins.at(-2)!.name, /^photo_.*\.jpg$/);
});

test("notify with a file: blob → sendDocument; delivered after both", async () => {
  const data = Buffer.from("%PDF-1.4 report");
  const stored = await import("@brain-boost-academy/agent-protocol").then((m) => m.sendBufferBlob(c.peer, data, { name: "report.pdf", mime: "application/pdf" }));
  c.send("notify", { notify_id: "nf", text: "Отчёт готов", files: [stored.blob_id], switched: false });
  await c.waitFor("delivered", (p: { id: string }) => p.id === "notify:nf");
  const doc = h.tg.of("sendDocument", OWNER.id).at(-1)!;
  const file = doc.payload.document as InputFile;
  assert.ok(file instanceof InputFile);
  assert.equal(file.filename, "report.pdf");
  assert.equal(h.tg.texts(OWNER.id).at(-1), "Отчёт готов");
  // the gateway removed its temporary copy after sending
  assert.throws(() => readFileSync(String((file as unknown as { fileData: string }).fileData)));
});

test("notify referencing a blob that never arrived → error, no ack; blob over 50 MB → too_large", async () => {
  const env = c.send("notify", { notify_id: "nx", text: "x", files: ["missing-blob"], switched: false });
  const err = await c.waitFor("error", (p: { code: string }) => p.code === "invalid_message");
  assert.equal(err.re, env.id);
  assert.equal(await db.repo.isDelivered(h.app.gw.registry.all()[0]!.connectorId, "notify:nx"), false);
  const big = c.send("blob.begin", { blob_id: randomUUID(), name: "big.bin", mime: "application/octet-stream", size: 51 * 1024 * 1024, sha256: "0".repeat(64) });
  const tooLarge = await c.waitFor("error", (p: { code: string }) => p.code === "too_large");
  assert.equal(tooLarge.re, big.id);
});

test("upload refused by the connector → user told, no prompt", async () => {
  h.tg.files.set("doc1", Buffer.from("data"));
  const before = c.received("conversation.prompt").length;
  const orig = c.blobs.end.bind(c.blobs);
  c.blobs.end = async () => {
    throw new (await import("@brain-boost-academy/agent-protocol")).ProtocolError("too_large", "disk full");
  };
  await h.feed({
    update_id: 99_001,
    message: {
      message_id: 99_001,
      date: 0,
      chat: { id: OWNER.id, type: "private", first_name: "O" },
      from: { id: OWNER.id, is_bot: false, first_name: "O" },
      document: { file_id: "doc1", file_unique_id: "d1", file_name: "a.txt", mime_type: "text/plain", file_size: 4 },
    },
  } as never);
  c.blobs.end = orig;
  await until(() => /Не удалось передать файл агенту/.test(h.tg.texts(OWNER.id).at(-1) ?? ""), "upload error");
  assert.equal(c.received("conversation.prompt").length, before);
});
