// Fake Telegram Bot API for e2e: point the gateway at TELEGRAM_API_ROOT=http://127.0.0.1:<port>.
// Control endpoints: POST /_update {update fields without update_id}, GET /_log, GET /_chat/<id>, POST /_file (raw body -> file_id)
import { createServer } from "node:http";

const PORT = Number(process.env.FAKE_TG_PORT ?? 8443);
const BOT = { id: 7000000001, is_bot: true, first_name: "AgentBot", username: "agent_test_bot" };
let updateId = 1;
let msgId = 100;
const updates = [];
const waiters = [];
const log = [];
const chats = new Map(); // chat_id -> Map(message_id -> message)
const files = new Map(); // file_id -> Buffer

function chatMsgs(chatId) {
  if (!chats.has(String(chatId))) chats.set(String(chatId), new Map());
  return chats.get(String(chatId));
}

function pushUpdate(u) {
  updates.push({ update_id: updateId++, ...u });
  while (waiters.length) waiters.shift()();
}

async function readBody(req) {
  const parts = [];
  for await (const c of req) parts.push(c);
  return Buffer.concat(parts);
}

function parseMultipart(buf, ctype) {
  const boundary = /boundary=(.+)$/.exec(ctype)?.[1];
  const out = {};
  if (!boundary) return out;
  const sep = Buffer.from(`--${boundary}`);
  let start = buf.indexOf(sep) + sep.length;
  for (;;) {
    const next = buf.indexOf(sep, start);
    if (next < 0) break;
    const part = buf.subarray(start + 2, next - 2);
    const headEnd = part.indexOf("\r\n\r\n");
    const head = part.subarray(0, headEnd).toString();
    const body = part.subarray(headEnd + 4);
    const name = /name="([^"]+)"/.exec(head)?.[1];
    const filename = /filename="([^"]*)"/.exec(head)?.[1];
    if (name) out[name] = filename !== undefined ? { filename, size: body.length, data: body } : body.toString();
    start = next + sep.length;
  }
  return out;
}

function message(chatId, extra) {
  const m = { message_id: ++msgId, date: Math.floor(Date.now() / 1000), chat: { id: Number(chatId), type: "private" }, from: BOT, ...extra };
  chatMsgs(chatId).set(m.message_id, m);
  return m;
}

const handlers = {
  getMe: () => BOT,
  setMyCommands: () => true,
  deleteWebhook: () => true,
  getUpdates: async (p) => {
    const offset = Number(p.offset ?? 0);
    while (updates.length && updates[0].update_id < offset) updates.shift();
    if (!updates.length) await new Promise((r) => { waiters.push(r); setTimeout(r, Math.min(Number(p.timeout ?? 0), 2) * 1000); });
    return updates.filter((u) => u.update_id >= offset);
  },
  sendMessage: (p) => message(p.chat_id, { text: p.text, parse_mode: p.parse_mode, reply_markup: parseJson(p.reply_markup), reply_to_message_id: replyTo(p) }),
  sendMessageDraft: () => true,
  editMessageText: (p) => {
    const m = chatMsgs(p.chat_id).get(Number(p.message_id));
    if (!m) throw Object.assign(new Error("Bad Request: message to edit not found"), { code: 400 });
    if (m.text === p.text && JSON.stringify(m.reply_markup ?? null) === JSON.stringify(parseJson(p.reply_markup) ?? null)) throw Object.assign(new Error("Bad Request: message is not modified"), { code: 400 });
    m.text = p.text;
    m.reply_markup = parseJson(p.reply_markup);
    m.edits = (m.edits ?? 0) + 1;
    return m;
  },
  editMessageReplyMarkup: (p) => {
    const m = chatMsgs(p.chat_id).get(Number(p.message_id));
    if (m) m.reply_markup = parseJson(p.reply_markup);
    return m ?? true;
  },
  deleteMessage: (p) => chatMsgs(p.chat_id).delete(Number(p.message_id)) || true,
  answerCallbackQuery: () => true,
  sendChatAction: () => true,
  sendDocument: (p) => message(p.chat_id, { document: { file_id: "doc" + msgId, file_name: p.document?.filename, file_size: p.document?.size }, caption: p.caption }),
  sendPhoto: (p) => message(p.chat_id, { photo: [{ file_id: "ph" + msgId, file_size: p.photo?.size }], caption: p.caption }),
  getFile: (p) => ({ file_id: p.file_id, file_unique_id: p.file_id, file_size: files.get(p.file_id)?.length ?? 0, file_path: `files/${p.file_id}` }),
};

function parseJson(v) {
  if (v === undefined) return undefined;
  if (typeof v !== "string") return v;
  try { return JSON.parse(v); } catch { return v; }
}
function replyTo(p) {
  const rp = parseJson(p.reply_parameters);
  return rp?.message_id ?? (p.reply_to_message_id ? Number(p.reply_to_message_id) : undefined);
}

createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const send = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
  try {
    if (url.pathname === "/_update") return send(200, pushUpdate(JSON.parse((await readBody(req)).toString())) ?? { ok: true });
    if (url.pathname === "/_log") return send(200, log);
    if (url.pathname.startsWith("/_chat/")) return send(200, [...chatMsgs(url.pathname.slice(7)).values()]);
    if (url.pathname === "/_file") { const id = "f" + Date.now(); files.set(id, await readBody(req)); return send(200, { file_id: id }); }
    const fm = /^\/file\/bot[^/]+\/files\/(.+)$/.exec(url.pathname);
    if (fm) { const b = files.get(fm[1]); res.writeHead(b ? 200 : 404); return res.end(b ?? ""); }
    const m = /^\/bot[^/]+\/(\w+)$/.exec(url.pathname);
    if (!m) return send(404, { ok: false, error_code: 404, description: "Not Found" });
    const method = m[1];
    const body = await readBody(req);
    const ctype = req.headers["content-type"] ?? "";
    const params = ctype.includes("multipart") ? parseMultipart(body, ctype) : body.length ? JSON.parse(body.toString()) : Object.fromEntries(url.searchParams);
    const h = handlers[method];
    if (method !== "getUpdates") log.push({ method, params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, v?.data ? { filename: v.filename, size: v.size } : v])), at: Date.now() });
    if (!h) return send(200, { ok: true, result: true });
    try {
      send(200, { ok: true, result: await h(params) });
    } catch (e) {
      send(200, { ok: false, error_code: e.code ?? 400, description: e.message });
    }
  } catch (e) {
    send(500, { ok: false, error_code: 500, description: String(e) });
  }
}).listen(PORT, "127.0.0.1", () => console.log(`fake bot api on ${PORT}`));
