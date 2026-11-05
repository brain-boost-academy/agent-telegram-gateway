import type { Api } from "grammy";
import type { PayloadOf } from "@brain-boost-academy/agent-protocol";
import type { SessionRef } from "../db/repo.ts";
import { log } from "../log.ts";
import { markdownToHtml, splitHtml } from "./markdown.ts";
import { errorStatusHtml, finalStatusHtml, interruptedStatusHtml, liveStatusHtml, toolCallHtml, type PlanEntry } from "./status.ts";
import { editHtml, sendHtml } from "./tg.ts";

type Obj = Record<string, unknown>;

export type RenderDeps = {
  api: Api;
  recordSession: (chatId: number, messageId: number, connectorId: string, session: SessionRef) => Promise<void>;
  /** Minimum pause between the end of one flush of a turn and the start of the next (≤ ~1 edit/s per chat). */
  flushMs?: number;
  /** Omit the cost from the collapsed status (HIDE_COST). */
  hideCost?: boolean;
};

type ToolView = { title: string; kind?: string; status?: string; msgId?: number; sent?: string };

/** Live render state of one turn in one chat (R14: kept in memory, rebuilt from `sync` after a restart). */
class TurnView {
  readonly connectorId: string;
  readonly chatId: number;
  readonly turnId: string;
  session: SessionRef;
  startedAt: number;
  verbose: boolean;
  text = "";
  gap = false;
  /** Answer messages of the current segment (the text from `segFrom` on). */
  answerIds: number[] = [];
  answerSent: string[] = [];
  /** Visible length of the text drawn in messages above a cut; the current segment starts there. */
  segFrom = 0;
  /** A message landed in the chat below this turn (question, permission, notify): visible length of the text and the status then. */
  cutAt?: number;
  cutStatus?: string;
  /** What the last flush put on screen: visible length of the text and the status without the elapsed time (see `statusOf`). */
  drawnWeight = 0;
  drawnStatus?: string;
  statusId?: number;
  statusSent?: string;
  toolIds = new Set<string>();
  stepsBase = 0;
  currentTool?: string;
  plan?: PlanEntry[];
  costUsd?: number;
  tools = new Map<string, ToolView>();
  final?: string;
  /** Closed as interrupted by `sync` (the connector no longer runs it); a late turn.ended/turn.error still completes it. */
  interrupted = false;
  /** Finished: no more scheduled flushes. */
  done = false;
  /** Flushes queued or running; while > 0 updates only mark the view dirty (no flush piles up behind them). */
  flushes = 0;
  dirty = false;
  /** End of the last flush. */
  lastFlush = 0;
  lastActivity = Date.now();
  timer?: NodeJS.Timeout;
  chain: Promise<void> = Promise.resolve();

  constructor(connectorId: string, chatId: number, turnId: string, session: SessionRef, verbose: boolean, startedAt = Date.now()) {
    this.connectorId = connectorId;
    this.chatId = chatId;
    this.turnId = turnId;
    this.session = session;
    this.verbose = verbose;
    this.startedAt = startedAt;
  }

  get steps(): number {
    return this.stepsBase + this.toolIds.size;
  }
}

/** Visible-content length, used to decide whether the connector's text is more complete than ours. */
function weight(s: string): number {
  return s.replace(/\s+/g, "").length;
}

/** The part of `s` from its `from`-th to its `to`-th visible character (whitespace is not counted, see `weight`). */
function sliceWeight(s: string, from: number, to = Infinity): string {
  if (to <= from) return "";
  let w = 0;
  let start = from > 0 ? s.length : 0;
  let end = s.length;
  for (let i = 0; i < s.length; i++) {
    if (/\s/.test(s[i]!)) continue;
    if (from > 0 && w === from) start = i;
    if (++w === to) {
      end = i + 1;
      break;
    }
  }
  return s.slice(start, end);
}

/** The status line of a turn; the cut compares it with `elapsedMs` 0, so the minute ticking over is not news. */
function statusOf(v: TurnView, elapsedMs: number): string {
  return v.final ?? liveStatusHtml({ steps: v.steps, currentTool: v.currentTool, plan: v.plan, elapsedMs });
}

function textOf(update: Obj): string | undefined {
  const c = update.content as Obj | undefined;
  return c && c.type === "text" && typeof c.text === "string" ? c.text : undefined;
}

export class Renderer {
  #d: RenderDeps;
  #views = new Map<string, TurnView>();
  #ended = new Set<string>();
  #gc: NodeJS.Timeout;

  constructor(d: RenderDeps) {
    this.#d = d;
    // Views of turns whose end we never saw (connector vanished) are dropped after an hour of silence.
    this.#gc = setInterval(() => {
      const cutoff = Date.now() - 3600_000;
      for (const [k, v] of this.#views) if (v.lastActivity < cutoff && !v.timer) this.#views.delete(k);
    }, 600_000);
    this.#gc.unref();
  }

  stop(): void {
    clearInterval(this.#gc);
    for (const v of this.#views.values()) clearTimeout(v.timer);
  }

  #key(connectorId: string, turnId: string): string {
    return `${connectorId}:${turnId}`;
  }

  knows(connectorId: string, turnId: string): boolean {
    return this.#views.has(this.#key(connectorId, turnId));
  }

  #view(connectorId: string, chatId: number, turnId: string, session: SessionRef, verbose: boolean, startedAt?: number): TurnView {
    const k = this.#key(connectorId, turnId);
    let v = this.#views.get(k);
    if (!v) {
      v = new TurnView(connectorId, chatId, turnId, session, verbose, startedAt);
      this.#views.set(k, v);
    }
    return v;
  }

  /** turn.started: draw the status message right away. */
  async start(connectorId: string, chatId: number, p: PayloadOf<"turn.started">, verbose: boolean): Promise<void> {
    if (this.#ended.has(this.#key(connectorId, p.turn_id))) return;
    const v = this.#view(connectorId, chatId, p.turn_id, p.session, verbose);
    await this.#enqueueFlush(v).catch((err) => log.warn("status message failed", { err }));
  }

  /** session.update: update state synchronously, flush at most once per interval. Returns false for unknown kinds. */
  update(connectorId: string, chatId: number, p: PayloadOf<"session.update">, verbose: boolean): boolean {
    const u = p.update as Obj & { sessionUpdate: string };
    if (!p.turn_id || this.#ended.has(this.#key(connectorId, p.turn_id))) return true;
    const v = this.#view(connectorId, chatId, p.turn_id, p.session, verbose);
    v.lastActivity = Date.now();
    switch (u.sessionUpdate) {
      case "agent_message_chunk": {
        const t = textOf(u);
        if (!t) return true;
        if (v.gap && v.text && !/\n\s*$/.test(v.text) && !/^\s*\n/.test(t)) v.text += "\n\n";
        v.gap = false;
        v.text += t;
        break;
      }
      case "tool_call": {
        const id = String(u.toolCallId ?? "");
        const title = typeof u.title === "string" && u.title ? u.title : String(u.kind ?? "tool");
        if (id) v.toolIds.add(id);
        v.currentTool = title;
        v.gap = true;
        if (v.verbose && id) v.tools.set(id, { title, kind: u.kind as string | undefined, status: u.status as string | undefined });
        break;
      }
      case "tool_call_update": {
        const id = String(u.toolCallId ?? "");
        const tv = v.tools.get(id);
        if (typeof u.title === "string" && u.title) {
          if (tv) tv.title = u.title;
          if (v.toolIds.has(id)) v.currentTool = u.title;
        }
        if (tv && typeof u.status === "string") tv.status = u.status;
        break;
      }
      case "plan":
        v.plan = Array.isArray(u.entries)
          ? (u.entries as Obj[]).map((e) => ({ content: String(e.content ?? ""), status: String(e.status ?? "pending") }))
          : v.plan;
        break;
      case "usage_update": {
        const c = u.cost as Obj | undefined;
        if (c && typeof c.amount === "number" && (c.currency === undefined || c.currency === "USD")) v.costUsd = c.amount;
        return true;
      }
      case "agent_thought_chunk":
      case "user_message_chunk":
      case "available_commands_update":
      case "current_mode_update":
      case "config_option_update":
      case "session_info_update":
        return true;
      default:
        return false;
    }
    this.#schedule(v);
    return true;
  }

  /** sync (R14): a turn we render keeps its messages; an unknown one is drawn anew from the snapshot. */
  async reconcile(connectorId: string, chatId: number, t: PayloadOf<"sync">["running_turns"][number], verbose: boolean): Promise<void> {
    const k = this.#key(connectorId, t.turn_id);
    if (this.#ended.has(k)) return;
    const known = this.#views.get(k);
    if (known) {
      if (weight(t.text_so_far) > weight(known.text)) known.text = t.text_so_far;
      if (t.steps > known.steps) known.stepsBase += t.steps - known.steps;
      if (t.current_tool) known.currentTool = t.current_tool;
      known.lastActivity = Date.now();
      this.#schedule(known);
      return;
    }
    const started = Date.parse(t.started_at);
    const v = this.#view(connectorId, chatId, t.turn_id, t.session, verbose, Number.isFinite(started) ? started : Date.now());
    v.text = t.text_so_far;
    v.stepsBase = t.steps;
    v.currentTool = t.current_tool;
    await this.#enqueueFlush(v).catch((err) => log.warn("sync redraw failed", { err }));
  }

  /** turn.ended (durable): complete the answer and collapse the status. Throws if Telegram failed. */
  async end(connectorId: string, chatId: number, p: PayloadOf<"turn.ended">, verbose: boolean): Promise<void> {
    const v = this.#view(connectorId, chatId, p.turn_id, p.session, verbose, Date.now() - p.duration_ms);
    if (weight(p.text) > weight(v.text)) v.text = p.text;
    v.final = finalStatusHtml({ steps: p.tool_calls, durationMs: p.duration_ms, costUsd: this.#d.hideCost ? undefined : (p.cost_usd ?? v.costUsd), stopReason: p.stop_reason });
    await this.#finish(v);
  }

  async error(connectorId: string, chatId: number, p: PayloadOf<"turn.error">, verbose: boolean): Promise<void> {
    const v = this.#view(connectorId, chatId, p.turn_id, p.session, verbose);
    v.final = errorStatusHtml(p.message, Date.now() - v.startedAt, v.steps);
    await this.#finish(v);
  }

  /**
   * sync (protocol 1.2.0): turns of this connector we still render but that are not in `running_turns` ended while we were
   * apart (or the connector restarted). Their status becomes «прервано», the answer stays; the view is kept so a durable
   * turn.ended/turn.error that follows still completes it.
   */
  async interruptMissing(connectorId: string, running: Set<string>): Promise<void> {
    const gone = [...this.#views.values()].filter((v) => v.connectorId === connectorId && !running.has(v.turnId) && !v.interrupted);
    for (const v of gone) {
      v.interrupted = true;
      clearTimeout(v.timer);
      v.timer = undefined;
      v.final = interruptedStatusHtml(v.steps, Date.now() - v.startedAt);
      await this.#enqueueFlush(v);
    }
  }

  /**
   * Send a message of our own (question, permission, notify) into a chat where turns may be rendering. What the turns have
   * so far is drawn above it first; once a turn has something new, its status and further text go to new messages below it,
   * not into edits of messages the user has scrolled past (no notification, easy to miss).
   */
  async below<T>(chatId: number, send: () => Promise<T>): Promise<T> {
    const views = [...this.#views.values()].filter((v) => v.chatId === chatId && !v.done);
    for (const v of views) {
      clearTimeout(v.timer);
      v.timer = undefined;
      await this.#enqueueFlush(v).catch((err) => log.warn("render flush failed", { turn: v.turnId, err }));
    }
    const r = await send();
    for (const v of views) {
      if (v.done || v.statusId === undefined) continue;
      // what was on screen when the message went out, not what arrived while it was being sent (that goes below it)
      v.cutAt = v.drawnWeight;
      v.cutStatus = v.drawnStatus;
    }
    return r;
  }

  async #finish(v: TurnView): Promise<void> {
    clearTimeout(v.timer);
    v.timer = undefined;
    v.done = true;
    await this.#enqueueFlush(v);
    const k = this.#key(v.connectorId, v.turnId);
    this.#views.delete(k);
    this.#ended.add(k);
    if (this.#ended.size > 1000) this.#ended.delete(this.#ended.values().next().value!);
  }

  /** Flush at most once per `flushMs`, counted from the end of the previous flush; never queue behind a pending one. */
  #schedule(v: TurnView): void {
    if (v.done || v.timer) return;
    if (v.flushes > 0) {
      v.dirty = true;
      return;
    }
    const flushMs = this.#d.flushMs ?? 1000;
    const delay = Math.max(0, v.lastFlush + flushMs - Date.now());
    v.timer = setTimeout(() => {
      v.timer = undefined;
      if (v.flushes > 0) {
        v.dirty = true;
        return;
      }
      this.#enqueueFlush(v).catch((err) => log.warn("render flush failed", { turn: v.turnId, err }));
    }, delay);
  }

  #enqueueFlush(v: TurnView): Promise<void> {
    v.flushes++;
    const run = v.chain.then(async () => {
      v.dirty = false;
      try {
        await this.#flush(v);
      } finally {
        v.lastFlush = Date.now();
        if (--v.flushes === 0 && v.dirty) {
          v.dirty = false;
          this.#schedule(v);
        }
      }
    });
    v.chain = run.catch(() => {});
    return run;
  }

  /** Bring Telegram in line with the view: status, verbose tool messages, answer parts. Idempotent. */
  async #flush(v: TurnView): Promise<void> {
    const { api } = this.#d;
    const status = statusOf(v, Date.now() - v.startedAt);
    const statusKey = statusOf(v, 0);
    if (v.cutAt !== undefined && (weight(v.text) > v.cutAt || statusKey !== v.cutStatus)) {
      // something new since a message landed below us: finish the text above it, then continue below it
      const cutAt = v.cutAt;
      await this.#drawAnswer(v, sliceWeight(v.text, v.segFrom, cutAt));
      v.cutAt = undefined;
      v.segFrom = cutAt;
      v.answerIds = [];
      v.answerSent = [];
      if (v.statusId !== undefined) await api.deleteMessage(v.chatId, v.statusId).catch((err) => log.debug("old status not deleted", { err }));
      v.statusId = undefined;
      v.statusSent = undefined;
    }
    if (v.statusId === undefined || (v.statusSent !== status && (await editHtml(api, v.chatId, v.statusId, status)) === "gone")) {
      const m = await sendHtml(api, v.chatId, status);
      v.statusId = m.message_id;
      await this.#record(v, m.message_id);
    }
    v.statusSent = status;
    v.drawnStatus = statusKey;

    for (const tv of v.tools.values()) {
      const html = toolCallHtml(tv.title, tv.status, tv.kind);
      if (tv.sent === html) continue;
      if (tv.msgId === undefined || (await editHtml(api, v.chatId, tv.msgId, html)) === "gone") {
        const m = await sendHtml(api, v.chatId, html);
        tv.msgId = m.message_id;
        await this.#record(v, m.message_id);
      }
      tv.sent = html;
    }

    const drawn = weight(v.text);
    await this.#drawAnswer(v, sliceWeight(v.text, v.segFrom));
    v.drawnWeight = drawn;
  }

  async #drawAnswer(v: TurnView, text: string): Promise<void> {
    const { api } = this.#d;
    const parts = text.trim() ? splitHtml(markdownToHtml(text)) : [];
    for (const [i, part] of parts.entries()) {
      const id = v.answerIds[i];
      if (id !== undefined && v.answerSent[i] === part) continue;
      if (id === undefined || (await editHtml(api, v.chatId, id, part)) === "gone") {
        const m = await sendHtml(api, v.chatId, part);
        v.answerIds[i] = m.message_id;
        await this.#record(v, m.message_id);
      }
      v.answerSent[i] = part;
    }
  }

  async #record(v: TurnView, messageId: number): Promise<void> {
    await this.#d.recordSession(v.chatId, messageId, v.connectorId, v.session).catch((err) => log.warn("message_sessions insert failed", { err }));
  }
}
