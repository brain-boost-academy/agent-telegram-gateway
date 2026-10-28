import { escapeHtml, truncate } from "./markdown.ts";

type Obj = Record<string, unknown>;
export type PermOption = { optionId: string; name: string; kind: string };
export type PermissionParams = { toolCall: Obj & { toolCallId: string }; options: PermOption[] };

const KIND_LABEL: Record<string, string> = {
  allow_once: "Разрешить",
  allow_always: "Всегда",
  reject_once: "Запретить",
  reject_always: "Никогда",
};

const KIND_OUTCOME: Record<string, string> = {
  allow_once: "✅ Разрешено",
  allow_always: "✅ Разрешено всегда",
  reject_once: "❌ Запрещено",
  reject_always: "⛔ Запрещено навсегда",
};

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.length > 0 ? v : undefined;
}

function lines(s: string): string[] {
  return s.length ? s.replace(/\n$/, "").split("\n") : [];
}

/** +added −removed lines between two texts (multiset diff; good enough for a gist). */
export function lineDelta(oldText: string, newText: string): { added: number; removed: number } {
  const pool = new Map<string, number>();
  for (const l of lines(oldText)) pool.set(l, (pool.get(l) ?? 0) + 1);
  let added = 0;
  for (const l of lines(newText)) {
    const n = pool.get(l) ?? 0;
    if (n > 0) pool.set(l, n - 1);
    else added++;
  }
  let removed = 0;
  for (const n of pool.values()) removed += n;
  return { added, removed };
}

/** Short human gist of a tool call: command, path and/or diff size, when derivable. */
export function permissionGist(toolCall: Obj): string[] {
  const out: string[] = [];
  const raw = (toolCall.rawInput && typeof toolCall.rawInput === "object" ? toolCall.rawInput : {}) as Obj;
  const command = str(raw.command) ?? str(raw.cmd);
  if (command) out.push(`<pre>${escapeHtml(truncate(command, 800))}</pre>`);
  const path =
    str(raw.file_path) ?? str(raw.filePath) ?? str(raw.path) ?? str(raw.notebook_path) ??
    str((Array.isArray(toolCall.locations) ? (toolCall.locations[0] as Obj | undefined) : undefined)?.path);
  let delta: { added: number; removed: number } | undefined;
  const content = Array.isArray(toolCall.content) ? (toolCall.content as Obj[]) : [];
  for (const c of content) {
    if (c?.type === "diff") {
      const d = lineDelta(str(c.oldText) ?? "", typeof c.newText === "string" ? c.newText : "");
      delta = { added: (delta?.added ?? 0) + d.added, removed: (delta?.removed ?? 0) + d.removed };
    }
  }
  if (!delta && (typeof raw.old_string === "string" || typeof raw.new_string === "string")) {
    delta = lineDelta(str(raw.old_string) ?? "", str(raw.new_string) ?? "");
  }
  if (!delta && typeof raw.content === "string") delta = { added: lines(raw.content).length, removed: 0 };
  if (path) out.push(`📄 <code>${escapeHtml(truncate(path, 300))}</code>${delta ? ` (+${delta.added} −${delta.removed})` : ""}`);
  else if (delta) out.push(`+${delta.added} −${delta.removed}`);
  const url = str(raw.url);
  if (url) out.push(`🌐 ${escapeHtml(truncate(url, 300))}`);
  const pattern = str(raw.pattern) ?? str(raw.query);
  if (pattern && !command) out.push(`🔎 <code>${escapeHtml(truncate(pattern, 200))}</code>`);
  const description = str(raw.description);
  if (description) out.push(`<i>${escapeHtml(truncate(description, 300))}</i>`);
  return out;
}

export function toolTitle(toolCall: Obj): string {
  return str(toolCall.title) ?? str(toolCall.kind) ?? "Инструмент";
}

export function permissionHtml(params: PermissionParams): string {
  return [`🔐 <b>Разрешить?</b>`, `<b>${escapeHtml(truncate(toolTitle(params.toolCall), 300))}</b>`, ...permissionGist(params.toolCall)].join("\n");
}

export function optionLabel(o: PermOption): string {
  return KIND_LABEL[o.kind] ?? o.name;
}

/** Button rows: allow-type options on the first row, reject-type on the second. */
export function permissionButtons(params: PermissionParams): PermOption[][] {
  const allow = params.options.filter((o) => o.kind.startsWith("allow"));
  const other = params.options.filter((o) => !o.kind.startsWith("allow"));
  return [allow, other].filter((r) => r.length > 0);
}

export type PermResolution =
  | { by: "user"; option?: PermOption; elsewhere?: boolean }
  | { by: "timeout" }
  | { by: "cancelled" };

export function outcomeLine(r: PermResolution): string {
  if (r.by === "timeout") return "⌛ Время ожидания истекло";
  if (r.by === "cancelled") return "✖️ Отменено";
  const base = r.option ? (KIND_OUTCOME[r.option.kind] ?? `☑️ ${escapeHtml(r.option.name)}`) : "☑️ Ответ получен";
  return r.elsewhere ? `${base} (в другом окне)` : base;
}

/** The message after the request is answered: title + outcome, buttons removed. */
export function resolvedPermissionHtml(title: string, r: PermResolution): string {
  return `🔐 <b>${escapeHtml(truncate(title, 300))}</b>\n${outcomeLine(r)}`;
}
