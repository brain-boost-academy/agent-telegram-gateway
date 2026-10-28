// protects=status message shows tool/steps/plan and collapses into «✓ N шагов · 40 с · $0.12»;
// fails_when=wrong Russian plural, missing duration/cost, stop reason not reflected, unescaped tool title;
// no_claim=how often Telegram lets us edit (see render tests)
import { test } from "node:test";
import assert from "node:assert/strict";
import { finalStatusHtml, liveStatusHtml, toolCallHtml } from "../../src/telegram/status.ts";
import { duration, plural } from "../../src/telegram/texts.ts";

test("collapsed status matches the spec format", () => {
  assert.equal(finalStatusHtml({ steps: 12, durationMs: 40_000, costUsd: 0.12, stopReason: "end_turn" }), "✓ 12 шагов · 40 с · $0.12");
  assert.equal(finalStatusHtml({ steps: 1, durationMs: 3_000, stopReason: "end_turn" }), "✓ 1 шаг · 3 с");
  assert.equal(finalStatusHtml({ steps: 3, durationMs: 125_000, stopReason: "cancelled" }), "⏹ остановлено · 3 шага · 2 мин 5 с");
});

test("Russian plurals and durations", () => {
  assert.deepEqual([1, 2, 5, 11, 21, 22, 112].map((n) => plural(n, "шаг", "шага", "шагов")), ["шаг", "шага", "шагов", "шагов", "шаг", "шага", "шагов"]);
  assert.equal(duration(3_600_000 + 60_000 * 3), "1 ч 3 мин");
});

test("live status: current tool, steps, plan; HTML escaped", () => {
  const html = liveStatusHtml({
    steps: 2,
    currentTool: "Run <rm -rf>",
    elapsedMs: 5000,
    plan: [
      { content: "read", status: "completed" },
      { content: "edit", status: "in_progress" },
      { content: "test", status: "pending" },
    ],
  });
  assert.equal(html, "⚙️ <b>Работаю</b> · 2 шага\n🔧 Run &lt;rm -rf&gt;\n\n<b>План</b>\n✅ read\n⏳ edit\n▫️ test");
});

test("verbose tool message marks status", () => {
  assert.equal(toolCallHtml("Read a.ts", "completed", "read"), "✅ Read a.ts <i>read</i>");
  assert.equal(toolCallHtml("x", "failed"), "❌ x");
  assert.equal(toolCallHtml("x", "in_progress", "other"), "🔧 x");
});

// protects=the live status does not change every second (each change is a Telegram edit); elapsed time shows whole minutes only;
// fails_when=two flushes a second apart produce different status text with nothing else changed;
// no_claim=edit pacing itself (render tests)
test("live status text is stable within a minute (no seconds)", () => {
  const at = (ms: number) => liveStatusHtml({ steps: 2, currentTool: "Bash", elapsedMs: ms });
  assert.equal(at(5_000), at(6_000));
  assert.equal(at(61_000), at(119_000));
  assert.match(at(61_000), /1 мин/);
  assert.doesNotMatch(at(125_000), / с\b/);
});
