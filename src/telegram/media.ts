import { sendBufferBlob } from "@brain-boost-academy/agent-protocol";
import type { Message } from "grammy/types";
import type { Gateway } from "../gateway.ts";
import { log } from "../log.ts";
import { download, TG_DOWNLOAD_LIMIT, TooLargeError } from "./files.ts";
import { errorText, ownerLink, sendPrompt } from "./inbound.ts";
import { escapeHtml } from "./markdown.ts";
import { T } from "./texts.ts";
import { sendHtml } from "./tg.ts";

type FileItem = { fileId: string; size?: number; name: string; mime: string };
type Album = { chatId: number; userId: number; items: FileItem[]; caption?: string; replyTo?: number; timer: NodeJS.Timeout };

function stamp(d: number): string {
  return new Date(d * 1000).toISOString().slice(0, 19).replace(/[:T]/g, "-");
}

/** The file of a photo/document/video message, or undefined for other messages. */
export function fileOf(m: Message): FileItem | undefined {
  if (m.photo?.length) {
    const p = m.photo[m.photo.length - 1]!;
    return { fileId: p.file_id, size: p.file_size, name: `photo_${stamp(m.date)}_${p.file_unique_id}.jpg`, mime: "image/jpeg" };
  }
  if (m.document) {
    const d = m.document;
    return { fileId: d.file_id, size: d.file_size, name: d.file_name || `file_${d.file_unique_id}`, mime: d.mime_type || "application/octet-stream" };
  }
  if (m.video) {
    const v = m.video;
    return { fileId: v.file_id, size: v.file_size, name: v.file_name || `video_${stamp(m.date)}.mp4`, mime: v.mime_type || "video/mp4" };
  }
  return undefined;
}

/** The audio of a voice/audio/video_note message (Flow 3). */
export function audioOf(m: Message): FileItem | undefined {
  if (m.voice) return { fileId: m.voice.file_id, size: m.voice.file_size, name: "voice.oga", mime: m.voice.mime_type || "audio/ogg" };
  if (m.audio) return { fileId: m.audio.file_id, size: m.audio.file_size, name: m.audio.file_name || "audio", mime: m.audio.mime_type || "audio/mpeg" };
  if (m.video_note) return { fileId: m.video_note.file_id, size: m.video_note.file_size, name: "video_note.mp4", mime: "video/mp4" };
  return undefined;
}

export class Media {
  #gw: Gateway;
  #albums = new Map<string, Album>();

  constructor(gw: Gateway) {
    this.#gw = gw;
  }

  stop(): void {
    for (const a of this.#albums.values()) clearTimeout(a.timer);
    this.#albums.clear();
  }

  async #fetch(f: FileItem): Promise<Buffer> {
    if (f.size !== undefined && f.size > TG_DOWNLOAD_LIMIT) throw new TooLargeError("too large");
    const file = await this.#gw.api.getFile(f.fileId);
    if (!file.file_path) throw new Error("Telegram returned no file_path");
    return download(this.#gw.fileUrl(file.file_path), this.#gw.agent);
  }

  /** Voice → ASR → «🎤 text» → prompt (or the armed answer). ASR failure → no prompt. */
  async voice(chatId: number, userId: number, m: Message): Promise<void> {
    const f = audioOf(m)!;
    const say = (html: string, replyTo?: number) =>
      sendHtml(this.#gw.api, chatId, html, replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {});
    const o = await ownerLink(this.#gw, chatId, userId);
    if (!o) return;
    if (!this.#gw.asr) return void (await say(T.asrOff));
    let text: string;
    try {
      const data = await this.#fetch(f);
      text = await this.#gw.asr.transcribe(data, f.name, f.mime);
    } catch (err) {
      log.warn("voice transcription failed", { err });
      await say(err instanceof TooLargeError ? T.tooBigDownload : T.asrFailed, m.message_id);
      return;
    }
    if (!text) return void (await say(T.asrFailed, m.message_id));
    await say(`🎤 ${escapeHtml(text)}`, m.message_id);
    if (this.#gw.arming.get(chatId)) return this.#gw.interactions.answerArmed(chatId, text);
    await sendPrompt(this.#gw, o, chatId, text, "voice", { replyTo: m.reply_to_message?.message_id });
  }

  /** Photo/document. Albums (media_group_id) are collected for `albumMs` after the last item (Flow 4). */
  async file(chatId: number, userId: number, m: Message): Promise<void> {
    const f = fileOf(m)!;
    if (!m.media_group_id) return this.#upload(chatId, userId, [f], m.caption, m.reply_to_message?.message_id);
    const key = `${chatId}:${m.media_group_id}`;
    const album = this.#albums.get(key);
    if (album) {
      clearTimeout(album.timer);
      album.items.push(f);
      album.caption ??= m.caption;
      album.replyTo ??= m.reply_to_message?.message_id;
    }
    const a: Album = album ?? { chatId, userId, items: [f], caption: m.caption, replyTo: m.reply_to_message?.message_id, timer: undefined as never };
    a.timer = setTimeout(() => {
      this.#albums.delete(key);
      void this.#gw.chats.run(chatId, () => this.#upload(a.chatId, a.userId, a.items, a.caption, a.replyTo));
    }, this.#gw.timings.albumMs);
    this.#albums.set(key, a);
  }

  async #upload(chatId: number, userId: number, items: FileItem[], caption: string | undefined, replyTo: number | undefined): Promise<void> {
    const o = await ownerLink(this.#gw, chatId, userId);
    if (!o) return;
    const blobIds: string[] = [];
    for (const f of items) {
      try {
        const data = await this.#fetch(f);
        const stored = await sendBufferBlob(o.link.peer, data, { name: f.name, mime: f.mime });
        blobIds.push(stored.blob_id);
      } catch (err) {
        log.warn("file upload to connector failed", { name: f.name, err });
        await sendHtml(this.#gw.api, chatId, err instanceof TooLargeError ? T.tooBigDownload : `${T.uploadFailed} ${errorText(err)}`);
        return;
      }
    }
    await sendPrompt(this.#gw, o, chatId, caption ?? "", "text", { replyTo, attachments: blobIds });
  }
}
