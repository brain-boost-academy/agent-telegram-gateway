import { escapeHtml, truncate } from "./markdown.ts";
import { cost, duration, steps } from "./texts.ts";

export type PlanEntry = { content: string; status: string };

export type LiveStatus = {
  steps: number;
  currentTool?: string;
  plan?: PlanEntry[];
  elapsedMs: number;
};

export type FinalStatus = {
  steps: number;
  durationMs: number;
  costUsd?: number;
  stopReason: string;
};

const PLAN_MARK: Record<string, string> = { completed: "✅", in_progress: "⏳", pending: "▫️" };

/**
 * Live status message: current tool, step count, plan. Elapsed time only in whole minutes: every change of this text
 * is a Telegram edit, so it must not tick every second.
 */
export function liveStatusHtml(s: LiveStatus): string {
  const minutes = Math.floor(s.elapsedMs / 60_000);
  const lines = [`⚙️ <b>Работаю</b> · ${steps(s.steps)}${minutes >= 1 ? ` · ${duration(minutes * 60_000)}` : ""}`];
  if (s.currentTool) lines.push(`🔧 ${escapeHtml(truncate(s.currentTool, 200))}`);
  if (s.plan?.length) {
    lines.push("", "<b>План</b>");
    for (const e of s.plan.slice(0, 20)) lines.push(`${PLAN_MARK[e.status] ?? "▫️"} ${escapeHtml(truncate(e.content, 150))}`);
    if (s.plan.length > 20) lines.push(`… ещё ${s.plan.length - 20}`);
  }
  return lines.join("\n");
}

/** Collapsed status after `turn.ended`: «✓ 12 шагов · 40 с · $0.12». */
export function finalStatusHtml(s: FinalStatus): string {
  const parts = [steps(s.steps), duration(s.durationMs)];
  if (s.costUsd !== undefined) parts.push(cost(s.costUsd));
  const tail = parts.join(" · ");
  switch (s.stopReason) {
    case "end_turn":
      return `✓ ${tail}`;
    case "cancelled":
      return `⏹ остановлено · ${tail}`;
    case "max_tokens":
    case "max_turn_requests":
      return `⚠️ лимит (${escapeHtml(s.stopReason)}) · ${tail}`;
    case "refusal":
      return `⚠️ агент отказался · ${tail}`;
    default:
      return `✓ ${tail} · ${escapeHtml(s.stopReason)}`;
  }
}

/** Status of a turn the connector no longer runs (it restarted, or the turn ended while the link was down). */
export function interruptedStatusHtml(stepCount: number, elapsedMs: number): string {
  return `⚠️ прервано · ${steps(stepCount)} · ${duration(elapsedMs)}`;
}

export function errorStatusHtml(message: string, elapsedMs: number, stepCount: number): string {
  return `❌ ошибка · ${steps(stepCount)} · ${duration(elapsedMs)}\n${escapeHtml(truncate(message, 1000))}`;
}

/** One message per tool call in /verbose mode. */
export function toolCallHtml(title: string, status: string | undefined, kind?: string): string {
  const mark = status === "completed" ? "✅" : status === "failed" ? "❌" : "🔧";
  const k = kind && kind !== "other" ? ` <i>${escapeHtml(kind)}</i>` : "";
  return `${mark} ${escapeHtml(truncate(title, 500))}${k}`;
}
