// Drive the fake Bot API as a Telegram user.
// node tg.mjs say <text> [replyToMsgId] | click <msgId> <button text substring> | show [n] | voice <file> | doc <file> [caption] | wait <regex> [sec]
import { readFileSync } from "node:fs";
import { basename } from "node:path";

const B = "http://127.0.0.1:18443";
const USER = { id: 555001, is_bot: false, first_name: "Роман", username: "owner_test" };
const CHAT = { id: 555001, type: "private", first_name: "Роман", username: "owner_test" };
let mid = Number(process.env.MID ?? Date.now() % 100000);

const post = (path, body, raw) => fetch(B + path, { method: "POST", body: raw ?? JSON.stringify(body) }).then((r) => r.json());
const chat = () => fetch(`${B}/_chat/${CHAT.id}`).then((r) => r.json());
const base = () => ({ message_id: ++mid, date: Math.floor(Date.now() / 1000), chat: CHAT, from: USER });

function fmt(m) {
  const kb = m.reply_markup?.inline_keyboard?.map((row) => row.map((b) => `[${b.text}]`).join(" ")).join(" ");
  const body = m.text ?? (m.document ? `📎 ${m.document.file_name} (${m.document.file_size} B)` : JSON.stringify(m));
  return `#${m.message_id}${m.edits ? ` (edited ×${m.edits})` : ""}${m.reply_to_message_id ? ` ↩${m.reply_to_message_id}` : ""}: ${body}${kb ? `\n    ${kb}` : ""}`;
}

const [cmd, ...a] = process.argv.slice(2);
if (cmd === "say") {
  const m = { ...base(), text: a[0] };
  if (a[0].startsWith("/")) m.entities = [{ type: "bot_command", offset: 0, length: a[0].split(" ")[0].length }];
  if (a[1]) m.reply_to_message = { message_id: Number(a[1]), date: 0, chat: CHAT, from: { id: 7000000001, is_bot: true, first_name: "AgentBot" }, text: "" };
  console.log(await post("/_update", { message: m }));
} else if (cmd === "click") {
  const m = (await chat()).find((x) => x.message_id === Number(a[0]));
  const btn = m?.reply_markup?.inline_keyboard?.flat().find((b) => b.text.includes(a[1]));
  if (!btn) throw new Error(`no button "${a[1]}" on #${a[0]}`);
  console.log(await post("/_update", { callback_query: { id: String(Date.now()), from: USER, chat_instance: "1", data: btn.callback_data, message: { ...m, from: { id: 7000000001, is_bot: true, first_name: "AgentBot" } } } }));
} else if (cmd === "show") {
  const all = await chat();
  for (const m of all.slice(-Number(a[0] ?? 8))) console.log(fmt(m));
} else if (cmd === "voice" || cmd === "doc") {
  const data = readFileSync(a[0]);
  const { file_id } = await post("/_file", null, data);
  const m = base();
  if (cmd === "voice") m.voice = { file_id, file_unique_id: file_id, duration: 6, mime_type: "audio/ogg", file_size: data.length };
  else { m.document = { file_id, file_unique_id: file_id, file_name: basename(a[0]), mime_type: "application/octet-stream", file_size: data.length }; if (a[1]) m.caption = a[1]; }
  console.log(await post("/_update", { message: m }));
} else if (cmd === "wait") {
  const re = new RegExp(a[0]);
  const until = Date.now() + Number(a[1] ?? 120) * 1000;
  for (;;) {
    const all = await chat();
    const hit = all.filter((m) => re.test(fmt(m)));
    if (hit.length) { console.log(fmt(hit.at(-1))); break; }
    if (Date.now() > until) { console.log("TIMEOUT"); for (const m of all.slice(-5)) console.log(fmt(m)); process.exit(1); }
    await new Promise((r) => setTimeout(r, 700));
  }
}
