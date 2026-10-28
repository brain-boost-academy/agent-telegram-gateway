import { randomBytes } from "node:crypto";
import type { PayloadOf } from "@brain-boost-academy/agent-protocol";
import type { Gateway } from "../gateway.ts";
import type { CallbackRow, SessionRef } from "../db/repo.ts";
import { log } from "../log.ts";
import type { ConnectorLink } from "../ws/link.ts";
import { TTL } from "./buttons.ts";
import { Form, type FormAction } from "./elicitation.ts";
import { escapeHtml, truncate } from "./markdown.ts";
import {
  optionLabel,
  permissionButtons,
  permissionHtml,
  resolvedPermissionHtml,
  toolTitle,
  type PermissionParams,
  type PermOption,
} from "./permissions.ts";
import { T } from "./texts.ts";
import { editHtml, sendHtml } from "./tg.ts";

/** A pressed inline button. */
export type Click = { chatId: number; fromId: number; messageId: number; answer: (text?: string) => Promise<void> };

type PermView = { connectorId: string; requestId: string; chatId: number; messageId: number; title: string; options: PermOption[] };
type FormView = { connectorId: string; requestId: string; chatId: number; messageId: number; form: Form; session: SessionRef };
/** Our answer to a request; fire-and-forget on the wire, so kept until the connector confirms with `*.resolved`. */
type Answer =
  | { type: "permission.respond"; payload: PayloadOf<"permission.respond"> }
  | { type: "elicitation.respond"; payload: PayloadOf<"elicitation.respond"> };

/** Permission requests and elicitation forms shown in Telegram (Flow 5, Flow 6, R6, R15). */
export class Interactions {
  #gw: Gateway;
  #perms = new Map<string, PermView>();
  #forms = new Map<string, FormView>();
  /** connectorId → request_id → last answer sent (re-sent after a reconnect while the request is still pending). */
  #answers = new Map<string, Map<string, Answer>>();

  constructor(gw: Gateway) {
    this.#gw = gw;
  }

  #key(connectorId: string, requestId: string): string {
    return `${connectorId}:${requestId}`;
  }

  #respond(link: ConnectorLink, a: Answer): void {
    link.peer.send(a.type, a.payload);
    let m = this.#answers.get(link.connectorId);
    if (!m) this.#answers.set(link.connectorId, (m = new Map()));
    m.set(a.payload.request_id, a);
  }

  #resolved(connectorId: string, requestId: string): void {
    this.#answers.get(connectorId)?.delete(requestId);
  }

  /**
   * After `sync` (protocol 1.2.0): re-send answers to requests the connector still waits on (the respond was lost with the
   * old link); forget answers, permission messages and forms of requests it no longer waits on.
   */
  async syncPending(link: ConnectorLink, pending: Set<string>): Promise<void> {
    const cid = link.connectorId;
    const answers = this.#answers.get(cid);
    for (const [id, a] of answers ?? []) {
      if (!pending.has(id)) answers!.delete(id);
      else link.peer.send(a.type, a.payload);
    }
    for (const [k, v] of this.#perms) if (v.connectorId === cid && !pending.has(v.requestId)) this.#perms.delete(k);
    for (const [k, v] of this.#forms) {
      if (v.connectorId !== cid || pending.has(v.requestId)) continue;
      this.#forms.delete(k);
      for (const { chatId, armed } of this.#gw.arming.disarmRequest(v.requestId)) {
        if (armed.promptMessageId) await editHtml(this.#gw.api, chatId, armed.promptMessageId, T.armCancelled).catch((err) => log.debug("disarm edit failed", { err }));
      }
    }
  }

  // ---------------- permissions ----------------

  async showPermission(connectorId: string, chatId: number, p: PayloadOf<"permission.request">): Promise<void> {
    const params = p.params as unknown as PermissionParams;
    const rows = permissionButtons(params).map((row) =>
      row.map((o) => ({ label: optionLabel(o), kind: "perm", payload: { r: p.request_id, o: o.optionId } })),
    );
    const markup = await this.#gw.buttons.keyboard(connectorId, rows, TTL.request, { stable: true });
    const m = await sendHtml(this.#gw.api, chatId, permissionHtml(params), { reply_markup: markup });
    this.#perms.set(this.#key(connectorId, p.request_id), {
      connectorId,
      requestId: p.request_id,
      chatId,
      messageId: m.message_id,
      title: toolTitle(params.toolCall),
      options: params.options,
    });
    await this.#gw.recordSession(chatId, m.message_id, connectorId, p.session).catch(() => {});
  }

  async permissionResolved(connectorId: string, p: PayloadOf<"permission.resolved">): Promise<void> {
    this.#gw.state(connectorId).pending.delete(p.request_id);
    this.#resolved(connectorId, p.request_id);
    const k = this.#key(connectorId, p.request_id);
    const view = this.#perms.get(k);
    if (!view) return;
    this.#perms.delete(k);
    const option = p.outcome?.outcome === "selected" ? view.options.find((o) => o.optionId === (p.outcome as { optionId: string }).optionId) : undefined;
    const r = p.by === "user" ? { by: "user" as const, option, elsewhere: true } : { by: p.by };
    await editHtml(this.#gw.api, view.chatId, view.messageId, resolvedPermissionHtml(view.title, r));
  }

  async onPermissionClick(q: Click, row: CallbackRow): Promise<void> {
    const { r, o } = row.payload as { r: string; o: string };
    const link = this.#gw.registry.get(row.connector_id);
    if (!link) return q.answer(T.offline);
    const st = this.#gw.state(row.connector_id);
    const pend = st.pending.get(r);
    if (!pend || pend.kind !== "permission") {
      await q.answer(T.closed);
      await this.#gw.api.editMessageReplyMarkup(q.chatId, q.messageId).catch(() => {});
      return;
    }
    const params = pend.payload.params as unknown as PermissionParams;
    const option = params.options.find((x) => x.optionId === o);
    this.#respond(link, { type: "permission.respond", payload: { request_id: r, outcome: { outcome: "selected", optionId: o } } });
    st.pending.delete(r);
    this.#perms.delete(this.#key(row.connector_id, r));
    await q.answer();
    await editHtml(this.#gw.api, q.chatId, q.messageId, resolvedPermissionHtml(toolTitle(params.toolCall), { by: "user", option }));
  }

  // ---------------- elicitation forms ----------------

  async #keyboard(fv: FormView) {
    const rows = fv.form.buttons().map((row) =>
      row.map((b) => ({ label: b.label, kind: "elic", payload: { r: fv.requestId, f: fv.form.current?.key ?? "", ...b.action } })),
    );
    // Stable ids: a re-render (multi-select toggle) reuses the rows instead of inserting a new 30-day set.
    return this.#gw.buttons.keyboard(fv.connectorId, rows, TTL.request, { stable: true });
  }

  async showElicitation(connectorId: string, chatId: number, p: PayloadOf<"elicitation.request">): Promise<void> {
    const form = new Form(p.params as Record<string, unknown>);
    const fv: FormView = { connectorId, requestId: p.request_id, chatId, messageId: 0, form, session: p.session };
    const m = await sendHtml(this.#gw.api, chatId, form.html(), { reply_markup: await this.#keyboard(fv) });
    fv.messageId = m.message_id;
    this.#forms.set(this.#key(connectorId, p.request_id), fv);
    await this.#gw.recordSession(chatId, m.message_id, connectorId, p.session).catch(() => {});
  }

  async #render(fv: FormView): Promise<void> {
    await editHtml(this.#gw.api, fv.chatId, fv.messageId, fv.form.html(), { reply_markup: await this.#keyboard(fv) });
  }

  async #finish(fv: FormView, outcome: string): Promise<void> {
    this.#forms.delete(this.#key(fv.connectorId, fv.requestId));
    this.#gw.state(fv.connectorId).pending.delete(fv.requestId);
    for (const { chatId, armed } of this.#gw.arming.disarmRequest(fv.requestId)) {
      if (armed.promptMessageId) await this.#gw.api.editMessageReplyMarkup(chatId, armed.promptMessageId).catch(() => {});
    }
    await editHtml(this.#gw.api, fv.chatId, fv.messageId, fv.form.summaryHtml(outcome));
  }

  /** Move to the next field, or send the whole answer when the form is complete. */
  async #advance(fv: FormView): Promise<void> {
    if (!fv.form.done) return this.#render(fv);
    const link = this.#gw.registry.get(fv.connectorId);
    if (!link) throw new Error("connector offline");
    this.#respond(link, { type: "elicitation.respond", payload: { request_id: fv.requestId, action: "accept", content: fv.form.content } });
    await this.#finish(fv, "✅ Ответ отправлен");
  }

  /** Form state for a click: in memory, or rebuilt from the pending request after a restart (from field 0, R15). */
  #formFor(connectorId: string, requestId: string, q: Click): FormView | undefined {
    const k = this.#key(connectorId, requestId);
    const existing = this.#forms.get(k);
    if (existing) return existing;
    const pend = this.#gw.state(connectorId).pending.get(requestId);
    if (!pend || pend.kind !== "elicitation") return undefined;
    const fv: FormView = {
      connectorId,
      requestId,
      chatId: q.chatId,
      messageId: q.messageId,
      form: new Form(pend.payload.params as Record<string, unknown>),
      session: pend.payload.session,
    };
    this.#forms.set(k, fv);
    return fv;
  }

  async onElicitationClick(q: Click, row: CallbackRow): Promise<void> {
    const { r, f, ...action } = row.payload as { r: string; f: string } & FormAction;
    const link = this.#gw.registry.get(row.connector_id);
    if (!link) return q.answer(T.offline);
    const fv = this.#gw.state(row.connector_id).pending.has(r) ? this.#formFor(row.connector_id, r, q) : undefined;
    if (!fv) {
      await q.answer(T.closed);
      await this.#gw.api.editMessageReplyMarkup(q.chatId, q.messageId).catch(() => {});
      return;
    }
    if (action.a === "cancel") {
      this.#respond(link, { type: "elicitation.respond", payload: { request_id: r, action: "cancel" } });
      await q.answer();
      await this.#finish(fv, "✖️ Вы отменили вопрос");
      return;
    }
    const current = fv.form.current;
    if ((current?.key ?? "") !== f) {
      // A button of an earlier field (e.g. after a gateway restart): show the first unanswered field again.
      await q.answer("Продолжим с первого неотвеченного вопроса");
      await this.#render(fv);
      return;
    }
    if (action.a === "custom" || action.a === "answer") {
      await q.answer();
      await this.#arm(fv);
      return;
    }
    if (!fv.form.apply(action)) return q.answer();
    await q.answer();
    await this.#advance(fv);
  }

  async #arm(fv: FormView): Promise<void> {
    const field = fv.form.current;
    if (!field) return;
    const armId = randomBytes(6).toString("base64url");
    const prev = this.#gw.arming.arm(fv.chatId, { armId, connectorId: fv.connectorId, requestId: fv.requestId, fieldKey: field.key });
    if (prev?.promptMessageId) await this.#gw.api.editMessageReplyMarkup(fv.chatId, prev.promptMessageId).catch(() => {});
    const markup = await this.#gw.buttons.keyboard(fv.connectorId, [[{ label: "Отмена", kind: "disarm", payload: { armId } }]], TTL.menu);
    const m = await sendHtml(this.#gw.api, fv.chatId, `${T.armPrompt}\n<i>${escapeHtml(truncate(field.title, 300))}</i>`, { reply_markup: markup });
    const cur = this.#gw.arming.get(fv.chatId);
    if (cur?.armId === armId) cur.promptMessageId = m.message_id;
  }

  async onDisarmClick(q: Click, row: CallbackRow): Promise<void> {
    const { armId } = row.payload as { armId: string };
    this.#gw.arming.disarm(q.chatId, armId);
    await q.answer();
    await editHtml(this.#gw.api, q.chatId, q.messageId, T.armCancelled);
  }

  /** A /command while armed disarms (R6). */
  async disarmChat(chatId: number): Promise<void> {
    const a = this.#gw.arming.disarm(chatId);
    if (a?.promptMessageId) await editHtml(this.#gw.api, chatId, a.promptMessageId, T.armCancelled).catch(() => {});
  }

  /** Text (or transcribed voice) while a field is armed = the answer. */
  async answerArmed(chatId: number, text: string): Promise<void> {
    const a = this.#gw.arming.get(chatId);
    if (!a) return;
    const fv = this.#forms.get(this.#key(a.connectorId, a.requestId));
    const reply = (html: string) => sendHtml(this.#gw.api, chatId, html);
    if (!fv || !this.#gw.state(a.connectorId).pending.has(a.requestId) || fv.form.current?.key !== a.fieldKey) {
      this.#gw.arming.disarm(chatId);
      await reply(T.closed);
      return;
    }
    if (!this.#gw.registry.get(a.connectorId)) {
      await reply(T.offline);
      return;
    }
    const r = fv.form.answerText(text);
    if (!r.ok) {
      await reply(r.reason === "number" ? T.needNumber : T.needOption);
      return;
    }
    this.#gw.arming.disarm(chatId);
    if (a.promptMessageId) await editHtml(this.#gw.api, chatId, a.promptMessageId, "✍️ Ответ принят").catch(() => {});
    await this.#advance(fv);
  }

  async elicitationResolved(connectorId: string, p: PayloadOf<"elicitation.resolved">): Promise<void> {
    this.#gw.state(connectorId).pending.delete(p.request_id);
    this.#resolved(connectorId, p.request_id);
    const fv = this.#forms.get(this.#key(connectorId, p.request_id));
    if (fv) {
      await this.#finish(fv, p.by === "cancelled" ? "✖️ Вопрос отменён" : "✅ Ответ получен (в другом окне)");
    } else {
      for (const { chatId, armed } of this.#gw.arming.disarmRequest(p.request_id)) {
        if (armed.promptMessageId) await this.#gw.api.editMessageReplyMarkup(chatId, armed.promptMessageId).catch((err) => log.debug("disarm edit failed", { err }));
      }
    }
  }
}
