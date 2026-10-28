// protects=permission message shows tool title + gist and buttons mapped from ACP option kinds (Flow 5);
// fails_when=button labels differ from «Разрешить/Всегда/Запретить/Никогда», unknown kind loses its name, diff size/command/path missing, HTML unescaped;
// no_claim=exact rawInput shapes of future adapter versions (gist is best effort)
import { test } from "node:test";
import assert from "node:assert/strict";
import { lineDelta, optionLabel, permissionButtons, permissionHtml, resolvedPermissionHtml } from "../../src/telegram/permissions.ts";

const options = [
  { optionId: "allow-once", name: "Yes", kind: "allow_once" },
  { optionId: "allow-always", name: "Always", kind: "allow_always" },
  { optionId: "reject", name: "No", kind: "reject_once" },
  { optionId: "never", name: "Never", kind: "reject_always" },
  { optionId: "x", name: "Custom thing", kind: "something_new" },
];

test("buttons come from ACP options with Russian labels; unknown kind falls back to the option name", () => {
  const rows = permissionButtons({ toolCall: { toolCallId: "t" }, options });
  assert.deepEqual(rows.map((r) => r.map(optionLabel)), [["Разрешить", "Всегда"], ["Запретить", "Никогда", "Custom thing"]]);
});

test("gist: Bash command", () => {
  const html = permissionHtml({ toolCall: { toolCallId: "t", title: "`ls -la`", kind: "execute", rawInput: { command: "ls -la | grep <x>", description: "List" } }, options });
  assert.equal(html, "🔐 <b>Разрешить?</b>\n<b>`ls -la`</b>\n<pre>ls -la | grep &lt;x&gt;</pre>\n<i>List</i>");
});

test("gist: edit with ACP diff content → path and +N −M", () => {
  const html = permissionHtml({
    toolCall: {
      toolCallId: "t",
      title: "Edit src/a.ts",
      content: [{ type: "diff", path: "/w/src/a.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\n" }],
      locations: [{ path: "/w/src/a.ts" }],
    },
    options,
  });
  assert.match(html, /📄 <code>\/w\/src\/a\.ts<\/code> \(\+2 −1\)/);
});

test("gist: Claude Edit rawInput old_string/new_string", () => {
  const html = permissionHtml({ toolCall: { toolCallId: "t", title: "Edit", rawInput: { file_path: "/a", old_string: "x", new_string: "y\nz" } }, options });
  assert.match(html, /\(\+2 −1\)/);
  assert.deepEqual(lineDelta("", "a\nb"), { added: 2, removed: 0 });
});

test("resolved message: outcome per kind, timeout, cancelled, elsewhere", () => {
  assert.equal(resolvedPermissionHtml("Bash", { by: "user", option: options[1] }), "🔐 <b>Bash</b>\n✅ Разрешено всегда");
  assert.equal(resolvedPermissionHtml("Bash", { by: "user", option: options[2], elsewhere: true }), "🔐 <b>Bash</b>\n❌ Запрещено (в другом окне)");
  assert.equal(resolvedPermissionHtml("Bash", { by: "timeout" }), "🔐 <b>Bash</b>\n⌛ Время ожидания истекло");
  assert.equal(resolvedPermissionHtml("Bash", { by: "cancelled" }), "🔐 <b>Bash</b>\n✖️ Отменено");
});
