// protects=agent markdown reaches Telegram as valid HTML with only allowed tags, split ≤4096 without broken tags;
// fails_when=raw <,>,& leak, a tag is left unclosed/crossed in any chunk, snake_case turns italic, a chunk exceeds 4096 visible chars, javascript: links survive;
// no_claim=Telegram's own HTML parser (rules mirrored from Bot API docs)
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml, markdownToHtml, splitHtml, truncate, visibleLength } from "../../src/telegram/markdown.ts";

const ALLOWED = new Set(["b", "i", "s", "u", "code", "pre", "a", "blockquote"]);

/** Every tag allowed, properly nested and closed. */
function assertWellFormed(html: string): void {
  const stack: string[] = [];
  for (const m of html.matchAll(/<(\/?)([a-z-]+)[^>]*>/g)) {
    const [, close, name] = m;
    assert.ok(ALLOWED.has(name!), `tag ${name} not allowed in ${html}`);
    if (close) assert.equal(stack.pop(), name, `crossed/unbalanced </${name}> in ${html}`);
    else stack.push(name!);
  }
  assert.deepEqual(stack, [], `unclosed tags in ${html}`);
  assert.ok(!/<(?![/a-z])/.test(html), `raw < in ${html}`);
}

test("inline markup maps to Telegram tags and escapes the rest", () => {
  const html = markdownToHtml("**bold** *it* _it2_ ~~del~~ `a<b>&c` [link](https://x.y/?a=1&b=2) 1 < 2 & 3 > 1");
  assert.equal(
    html,
    '<b>bold</b> <i>it</i> <i>it2</i> <s>del</s> <code>a&lt;b&gt;&amp;c</code> <a href="https://x.y/?a=1&amp;b=2">link</a> 1 &lt; 2 &amp; 3 &gt; 1',
  );
  assertWellFormed(html);
});

test("snake_case and lone markers stay literal", () => {
  assert.equal(markdownToHtml("use my_var_name and 2 * 3 * 4"), "use my_var_name and 2 * 3 * 4");
  assert.equal(markdownToHtml("\\*not italic\\*"), "*not italic*");
});

test("unsafe link schemes keep only the text", () => {
  assert.equal(markdownToHtml("[x](javascript:alert(1))"), "x");
});

test("unclosed and crossing markers from a partial stream stay well-formed", () => {
  for (const md of ["**bold without end", "**a *b** c*", "`code", "[text](http://a", "_a **b_ c**", "***x***", "~~a **b~~ c**"]) {
    assertWellFormed(markdownToHtml(md));
  }
});

test("blocks: headings, lists, quotes, fenced code (also unclosed while streaming), tables", () => {
  const html = markdownToHtml("# Title\n- one\n- **two**\n> quoted *x*\n> more\n```ts\nconst a = 1 < 2;\n```\n| a | b |\n|---|---|\n| 1 | 2 |");
  assert.equal(
    html,
    [
      "<b>Title</b>",
      "• one",
      "• <b>two</b>",
      "<blockquote>quoted <i>x</i>\nmore</blockquote>",
      '<pre><code class="language-ts">const a = 1 &lt; 2;</code></pre>',
      "<pre>| a | b |\n| 1 | 2 |</pre>",
    ].join("\n"),
  );
  assert.equal(markdownToHtml("```\npartial <code"), "<pre><code>partial &lt;code</code></pre>");
});

test("split: ≤4096 visible chars per chunk, tags never broken, nothing lost", () => {
  const para = "Слово **жирное** и `код` & <тег>. ".repeat(40);
  const md = Array.from({ length: 12 }, (_, i) => `## Раздел ${i}\n${para}`).join("\n") + "\n```\n" + "x = 1\n".repeat(1500) + "```";
  const html = markdownToHtml(md);
  const chunks = splitHtml(html);
  assert.ok(chunks.length > 2);
  for (const c of chunks) {
    assert.ok(visibleLength(c) <= 4096, `chunk too long: ${visibleLength(c)}`);
    assertWellFormed(c);
  }
  const strip = (s: string) => s.replace(/<[^>]*>/g, "").replace(/\s+/g, "");
  assert.equal(chunks.map(strip).join(""), strip(html));
  // the code block was split inside <pre> and reopened
  assert.ok(chunks.filter((c) => c.includes("<pre><code>")).length >= 2);
});

test("split: one huge line without spaces is hard-cut, entities kept whole", () => {
  const html = escapeHtml("&".repeat(5000));
  const chunks = splitHtml(html);
  assert.equal(chunks.length, 2);
  assert.equal(visibleLength(chunks[0]!), 4096);
  for (const c of chunks) assert.ok(!/&(?!amp;)/.test(c));
});

test("split: short text is returned as is", () => {
  assert.deepEqual(splitHtml("<b>hi</b>"), ["<b>hi</b>"]);
});

// protects=Telegram's 4096 limit is in UTF-16 code units: emoji-dense text is split by code units and surrogate pairs stay whole;
// fails_when=a chunk of emoji exceeds 4096 code units (Bot API 400 «message is too long»), a chunk starts/ends with a lone surrogate;
// no_claim=grapheme clusters (ZWJ sequences may be split between two messages, still valid UTF-16)
test("split: emoji-dense line → every chunk ≤ 4096 UTF-16 code units, no lone surrogates", () => {
  const html = "😀".repeat(5000) + " a" + "🎉x".repeat(3000);
  const chunks = splitHtml(html);
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const c of chunks) {
    assert.ok(c.length <= 4096, `chunk has ${c.length} code units`);
    assert.ok(!lone.test(c), "lone surrogate");
  }
  assert.equal(chunks.join("").replace(/\s/g, ""), html.replace(/\s/g, ""));
});

test("truncate never cuts a surrogate pair", () => {
  const s = truncate("a😀😀😀", 3);
  assert.ok(!/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(s), JSON.stringify(s));
});
