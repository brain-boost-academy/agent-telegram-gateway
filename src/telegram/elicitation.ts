import { escapeHtml, TG_TEXT_LIMIT, truncate, visibleLength } from "./markdown.ts";

// ACP form elicitation → one-question-at-a-time Telegram form (Flow 6, R6, R20: no timeout).

/** Option buttons per field; more options are answered by typing (a keyboard of hundreds of buttons is a Bot API 400). */
export const MAX_OPTION_BUTTONS = 50;
/** Button label length (code units); Telegram truncates or rejects longer ones. */
const LABEL_MAX = 60;

/** Non-empty, short, never a split surrogate pair. */
function buttonLabel(label: string, value: unknown, max = LABEL_MAX): string {
  const text = label.trim() || String(value ?? "").trim() || "—";
  return truncate(text, max);
}

/**
 * Lines that must fit one Telegram message: `fixed` always (each already bounded), `optional` lines (e.g. the answered
 * fields) are kept from the end while there is room, with «…» marking what was dropped.
 */
function fit(head: string, optional: string[], tail: string[], dropped: (n: number) => string): string {
  const join = (xs: string[]) => xs.join("\n");
  let room = TG_TEXT_LIMIT - visibleLength(join([head, ...tail])) - 1;
  const kept: string[] = [];
  for (let i = optional.length - 1; i >= 0; i--) {
    const w = visibleLength(optional[i]!) + 1;
    if (w > room - 40) {
      kept.unshift(dropped(i + 1));
      break;
    }
    room -= w;
    kept.unshift(optional[i]!);
  }
  return join([head, ...kept, ...tail]);
}

type Obj = Record<string, unknown>;
export type Option = { value: string | number | boolean; label: string };

type Base = { key: string; title: string; description?: string; required: boolean };
export type Field =
  | (Base & { kind: "single"; options: Option[]; customKey?: string })
  | (Base & { kind: "multi"; options: Option[]; customKey?: string })
  | (Base & { kind: "boolean" })
  | (Base & { kind: "text" | "number" | "integer" });

function asObj(v: unknown): Obj {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Obj) : {};
}

function optionsOf(schema: Obj): Option[] | undefined {
  if (Array.isArray(schema.enum)) {
    const names = Array.isArray(schema.enumNames) ? (schema.enumNames as unknown[]) : [];
    return (schema.enum as Array<string | number | boolean>).map((v, i) => ({
      value: v,
      label: typeof names[i] === "string" ? (names[i] as string) : String(v),
    }));
  }
  const alts = Array.isArray(schema.oneOf) ? schema.oneOf : Array.isArray(schema.anyOf) ? schema.anyOf : undefined;
  if (alts) {
    const opts = (alts as unknown[]).map(asObj).filter((a) => "const" in a);
    if (opts.length) return opts.map((a) => ({ value: a.const as string, label: typeof a.title === "string" ? a.title : String(a.const) }));
  }
  return undefined;
}

/** Parse `requestedSchema` into ordered fields. `<key>_custom` companions become the custom answer of `<key>`. */
export function parseForm(params: Obj): Field[] {
  const schema = asObj(params.requestedSchema);
  const props = asObj(schema.properties);
  const required = new Set(Array.isArray(schema.required) ? (schema.required as string[]) : []);
  const keys = Object.keys(props);
  const companions = new Set(keys.filter((k) => k.endsWith("_custom") && keys.includes(k.slice(0, -"_custom".length))));
  const fields: Field[] = [];
  for (const key of keys) {
    if (companions.has(key)) continue;
    const p = asObj(props[key]);
    const base: Base = {
      key,
      title: typeof p.title === "string" && p.title ? p.title : key,
      description: typeof p.description === "string" && p.description ? p.description : undefined,
      required: required.has(key),
    };
    const customKey = companions.has(`${key}_custom`) ? `${key}_custom` : undefined;
    if (p.type === "array") {
      const opts = optionsOf(asObj(p.items));
      if (opts) {
        fields.push({ ...base, kind: "multi", options: opts, customKey });
        continue;
      }
    }
    const opts = optionsOf(p);
    if (opts) fields.push({ ...base, kind: "single", options: opts, customKey });
    else if (p.type === "boolean") fields.push({ ...base, kind: "boolean" });
    else if (p.type === "number") fields.push({ ...base, kind: "number" });
    else if (p.type === "integer") fields.push({ ...base, kind: "integer" });
    else fields.push({ ...base, kind: "text" });
  }
  // A companion whose base is not a choice field is still a plain text question.
  for (const key of companions) {
    const baseField = fields.find((f) => f.key === key.slice(0, -"_custom".length));
    if (baseField && baseField.kind !== "single" && baseField.kind !== "multi") {
      const p = asObj(props[key]);
      fields.push({ key, title: typeof p.title === "string" ? p.title : key, required: required.has(key), kind: "text" });
    }
  }
  return fields;
}

/** Button actions inside a form; stored in the `callbacks` payload with request_id and field key. */
export type FormAction =
  | { a: "opt"; i: number }
  | { a: "tog"; i: number }
  | { a: "done" }
  | { a: "bool"; v: boolean }
  | { a: "custom" }
  | { a: "answer" }
  | { a: "cancel" };

export type Button = { label: string; action: FormAction };

export class Form {
  readonly message: string;
  readonly fields: Field[];
  readonly content: Record<string, unknown> = {};
  /** Display text of each answered field, in order. */
  readonly summary: Array<{ title: string; text: string }> = [];
  index = 0;
  selected = new Set<number>();

  constructor(params: Obj) {
    this.message = typeof params.message === "string" ? params.message : "";
    this.fields = params.mode === "form" || params.requestedSchema ? parseForm(params) : [];
  }

  get current(): Field | undefined {
    return this.fields[this.index];
  }

  get done(): boolean {
    return this.index >= this.fields.length;
  }

  #advance(title: string, text: string): void {
    this.summary.push({ title, text });
    this.index++;
    this.selected = new Set();
  }

  /** Apply a button action to the current field. Returns false if it does not apply. */
  apply(action: FormAction): boolean {
    const f = this.current;
    if (!f) return action.a === "done"; // a form without fields is acknowledged with «OK»
    if (action.a === "opt" && f.kind === "single") {
      const o = f.options[action.i];
      if (!o) return false;
      this.content[f.key] = o.value;
      this.#advance(f.title, o.label);
      return true;
    }
    if (action.a === "tog" && f.kind === "multi") {
      if (!f.options[action.i]) return false;
      if (this.selected.has(action.i)) this.selected.delete(action.i);
      else this.selected.add(action.i);
      return true;
    }
    if (action.a === "done" && f.kind === "multi") {
      const picked = [...this.selected].sort((a, b) => a - b).map((i) => f.options[i]!);
      this.content[f.key] = picked.map((o) => o.value);
      this.#advance(f.title, picked.map((o) => o.label).join(", ") || "—");
      return true;
    }
    if (action.a === "bool" && f.kind === "boolean") {
      this.content[f.key] = action.v;
      this.#advance(f.title, action.v ? "Да" : "Нет");
      return true;
    }
    return false;
  }

  /**
   * Free-text answer for the current field (armed via «Свой вариант» / «Ответить»). A choice field without a custom
   * companion only takes one of its options (by label or value; that is how options beyond the button cap are chosen).
   */
  answerText(text: string): { ok: true } | { ok: false; reason: "number" | "option" } {
    const f = this.current;
    if (!f) return { ok: true };
    if (f.kind === "number" || f.kind === "integer") {
      const n = Number(text.trim().replace(",", "."));
      if (!Number.isFinite(n) || (f.kind === "integer" && !Number.isInteger(n))) return { ok: false, reason: "number" };
      this.content[f.key] = n;
    } else if ((f.kind === "single" || f.kind === "multi") && f.customKey) {
      this.content[f.customKey] = text;
    } else if (f.kind === "single" || f.kind === "multi") {
      const t = text.trim().toLowerCase();
      const o = f.options.find((x) => x.label.trim().toLowerCase() === t) ?? f.options.find((x) => String(x.value).toLowerCase() === t);
      if (!o) return { ok: false, reason: "option" };
      this.content[f.key] = f.kind === "multi" ? [o.value] : o.value;
      this.#advance(f.title, o.label || String(o.value));
      return { ok: true };
    } else {
      this.content[f.key] = text;
    }
    this.#advance(f.title, text);
    return { ok: true };
  }

  /** Keyboard for the current field. At most MAX_OPTION_BUTTONS options; the rest are typed («Свой вариант»). */
  buttons(): Button[][] {
    const f = this.current;
    const rows: Button[][] = [];
    if (f?.kind === "single") {
      for (const [i, o] of f.options.slice(0, MAX_OPTION_BUTTONS).entries()) rows.push([{ label: buttonLabel(o.label, o.value), action: { a: "opt", i } }]);
      if (f.customKey || f.options.length > MAX_OPTION_BUTTONS) rows.push([{ label: "✍️ Свой вариант", action: { a: "custom" } }]);
    } else if (f?.kind === "multi") {
      for (const [i, o] of f.options.slice(0, MAX_OPTION_BUTTONS).entries()) {
        rows.push([{ label: `${this.selected.has(i) ? "☑️" : "▫️"} ${buttonLabel(o.label, o.value, LABEL_MAX - 4)}`, action: { a: "tog", i } }]);
      }
      const last: Button[] = [{ label: "Готово", action: { a: "done" } }];
      if (f.customKey || f.options.length > MAX_OPTION_BUTTONS) last.unshift({ label: "✍️ Свой вариант", action: { a: "custom" } });
      rows.push(last);
    } else if (f?.kind === "boolean") {
      rows.push([
        { label: "Да", action: { a: "bool", v: true } },
        { label: "Нет", action: { a: "bool", v: false } },
      ]);
    } else if (f) {
      rows.push([{ label: "✍️ Ответить", action: { a: "answer" } }]);
    } else {
      rows.push([{ label: "OK", action: { a: "done" } }]);
    }
    rows.push([{ label: "Отмена", action: { a: "cancel" } }]);
    return rows;
  }

  /** The form message; always ≤ 4096 visible chars (answered fields are dropped from the top first). */
  html(): string {
    const head = `❓ ${escapeHtml(truncate(this.message, 1500))}`;
    const f = this.current;
    if (!f) return head;
    const answered = this.summary.map((s) => `✔️ ${escapeHtml(truncate(s.title, 100))}: ${escapeHtml(truncate(s.text, 300))}`);
    const tail: string[] = [];
    const progress = this.fields.length > 1 ? ` (${this.index + 1}/${this.fields.length})` : "";
    if (this.fields.length > 1 || f.title !== this.message) tail.push("", `<b>${escapeHtml(truncate(f.title, 300))}</b>${progress}`);
    if (f.description) tail.push(`<i>${escapeHtml(truncate(f.description, 500))}</i>`);
    if ((f.kind === "single" || f.kind === "multi") && f.options.some((o) => o.label.length > LABEL_MAX)) {
      // full labels of the cut buttons, as long as they fit (≈ 1500 chars)
      let room = 1500;
      for (const [i, o] of f.options.slice(0, MAX_OPTION_BUTTONS).entries()) {
        const line = `• ${escapeHtml(truncate(o.label || String(o.value), 200))}`;
        room -= visibleLength(line) + 1;
        if (room < 0) {
          tail.push(`… ещё ${Math.min(f.options.length, MAX_OPTION_BUTTONS) - i}`);
          break;
        }
        tail.push(line);
      }
    }
    if (f.kind === "single" || f.kind === "multi") {
      if (f.options.length > MAX_OPTION_BUTTONS) tail.push(`<i>Ещё ${f.options.length - MAX_OPTION_BUTTONS} вариантов — напишите вариант текстом («✍️ Свой вариант»)</i>`);
    }
    return fit(head, answered, tail, (n) => `✔️ … (ответов выше: ${n})`);
  }

  /** The closed form: question, answers, outcome; ≤ 4096 visible chars. */
  summaryHtml(outcome: string): string {
    const answered = this.summary.map((s) => `• ${escapeHtml(truncate(s.title, 100))}: ${escapeHtml(truncate(s.text, 500))}`);
    return fit(`❓ ${escapeHtml(truncate(this.message, 1500))}`, answered, [outcome], (n) => `• … (ответов выше: ${n})`);
  }
}

// ---------------- arming (R6) ----------------

export type Armed = {
  armId: string;
  connectorId: string;
  requestId: string;
  fieldKey: string;
  promptMessageId?: number;
};

/** One armed free-text field per chat. Pure state; Telegram effects are done by the caller. */
export class Arming {
  #byChat = new Map<number, Armed>();

  arm(chatId: number, a: Armed): Armed | undefined {
    const prev = this.#byChat.get(chatId);
    this.#byChat.set(chatId, a);
    return prev;
  }

  get(chatId: number): Armed | undefined {
    return this.#byChat.get(chatId);
  }

  disarm(chatId: number, armId?: string): Armed | undefined {
    const cur = this.#byChat.get(chatId);
    if (!cur || (armId && cur.armId !== armId)) return undefined;
    this.#byChat.delete(chatId);
    return cur;
  }

  /** Clear arming tied to an elicitation that resolved or was cancelled. */
  disarmRequest(requestId: string): Array<{ chatId: number; armed: Armed }> {
    const out: Array<{ chatId: number; armed: Armed }> = [];
    for (const [chatId, a] of this.#byChat) {
      if (a.requestId === requestId) {
        this.#byChat.delete(chatId);
        out.push({ chatId, armed: a });
      }
    }
    return out;
  }
}

/**
 * What an incoming text/voice message means for a chat (R6):
 * a /command disarms and runs; while armed the message is the answer — including text that merely starts with "/"
 * («/tmp/x», «/shrug») when `isCommand` says it is not one of ours; otherwise a normal prompt.
 */
export function routeIncoming(
  armed: Armed | undefined,
  text: string,
  isCommand: (text: string) => boolean = (t) => t.startsWith("/"),
): "command" | "answer" | "prompt" {
  if (text.startsWith("/") && (!armed || isCommand(text))) return "command";
  return armed ? "answer" : "prompt";
}
