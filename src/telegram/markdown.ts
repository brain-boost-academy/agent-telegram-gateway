// Markdown (as produced by coding agents) → Telegram HTML.
// Output uses only b, i, s, code, pre, a, blockquote; everything else is escaped text.
// Every produced fragment is well-formed (inline markup is parsed recursively), so
// partial markdown from a running stream renders safely: unclosed markers stay literal.

export const TG_TEXT_LIMIT = 4096;

export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

const SAFE_URL = /^(https?:\/\/|tg:\/\/|mailto:)/i;

// ---------------- inline ----------------

type Delim = "**" | "__" | "~~" | "*" | "_";

function isWordChar(c: string | undefined): boolean {
  return c !== undefined && /[\p{L}\p{N}]/u.test(c);
}

function isSpace(c: string | undefined): boolean {
  return c === undefined || /\s/.test(c);
}

/** Length of a run of `ch` starting at i. */
function runLength(s: string, i: number, ch: string): number {
  let n = 0;
  while (s[i + n] === ch) n++;
  return n;
}

/** Index after the code span starting at i (a backtick run), or -1 if unclosed. */
function codeSpanEnd(s: string, i: number): { end: number; inner: string } | null {
  const n = runLength(s, i, "`");
  const fence = "`".repeat(n);
  let j = i + n;
  for (;;) {
    const k = s.indexOf(fence, j);
    if (k < 0) return null;
    if (s[k + n] !== "`" && s[k - 1] !== "`") {
      let inner = s.slice(i + n, k);
      if (inner.length > 2 && inner.startsWith(" ") && inner.endsWith(" ")) inner = inner.slice(1, -1);
      return { end: k + n, inner };
    }
    j = k + runLength(s, k, "`");
  }
}

function canOpen(s: string, i: number, d: Delim): boolean {
  const after = s[i + d.length];
  if (isSpace(after)) return false;
  if (d === "_" || d === "__") return !isWordChar(s[i - 1]);
  return true;
}

function canClose(s: string, j: number, d: Delim): boolean {
  if (isSpace(s[j - 1])) return false;
  if (d === "_" || d === "__") return !isWordChar(s[j + d.length]);
  return true;
}

/** Find the closing delimiter for an opener at `from` (exclusive), skipping code spans and escapes. */
function findCloser(s: string, from: number, d: Delim): number {
  let j = from;
  while (j < s.length) {
    const c = s[j]!;
    if (c === "\\") {
      j += 2;
      continue;
    }
    if (c === "`") {
      const span = codeSpanEnd(s, j);
      j = span ? span.end : j + runLength(s, j, "`");
      continue;
    }
    if (s.startsWith(d, j)) {
      // a single-char delimiter must not be half of a double one
      if (d.length === 1 && s[j + 1] === d) {
        j += runLength(s, j, d);
        continue;
      }
      if (j > from && canClose(s, j, d)) return j;
    }
    j++;
  }
  return -1;
}

const TAG: Record<Delim, string> = { "**": "b", __: "b", "~~": "s", "*": "i", _: "i" };

function parseLink(s: string, i: number): { end: number; text: string; url: string } | null {
  // [text](url)
  let depth = 0;
  let j = i;
  for (; j < s.length; j++) {
    if (s[j] === "\\") {
      j++;
      continue;
    }
    if (s[j] === "[") depth++;
    else if (s[j] === "]" && --depth === 0) break;
  }
  if (j >= s.length || s[j + 1] !== "(") return null;
  // URL may contain balanced parentheses (Wikipedia links)
  let close = -1;
  for (let k = j + 2, d = 1; k < s.length; k++) {
    if (s[k] === "(") d++;
    else if (s[k] === ")" && --d === 0) {
      close = k;
      break;
    }
  }
  if (close < 0) return null;
  const url = s.slice(j + 2, close).trim().split(/\s+/)[0] ?? "";
  if (!url) return null;
  return { end: close + 1, text: s.slice(i + 1, j), url };
}

export function inlineToHtml(s: string): string {
  let out = "";
  const noCloser = new Set<Delim>();
  let i = 0;
  while (i < s.length) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length && /[\\`*_~[\]()#>!|{}.+-]/.test(s[i + 1]!)) {
      out += escapeHtml(s[i + 1]!);
      i += 2;
      continue;
    }
    if (c === "`") {
      const span = codeSpanEnd(s, i);
      if (span) {
        out += `<code>${escapeHtml(span.inner)}</code>`;
        i = span.end;
      } else {
        const n = runLength(s, i, "`");
        out += s.slice(i, i + n);
        i += n;
      }
      continue;
    }
    if (c === "[") {
      const link = parseLink(s, i);
      if (link) {
        const inner = inlineToHtml(link.text);
        out += SAFE_URL.test(link.url) ? `<a href="${escapeAttr(link.url)}">${inner}</a>` : inner;
        i = link.end;
        continue;
      }
    }
    if (c === "<") {
      const m = /^<((?:https?|tg|mailto):[^\s<>]+)>/i.exec(s.slice(i));
      if (m) {
        out += `<a href="${escapeAttr(m[1]!)}">${escapeHtml(m[1]!)}</a>`;
        i += m[0].length;
        continue;
      }
    }
    if (c === "*" || c === "_" || c === "~") {
      const run = runLength(s, i, c);
      const d = (run >= 2 ? c + c : c) as Delim;
      if ((d as string) !== "~" && !noCloser.has(d) && canOpen(s, i, d)) {
        const close = findCloser(s, i + d.length, d);
        if (close > i + d.length) {
          const tag = TAG[d];
          out += `<${tag}>${inlineToHtml(s.slice(i + d.length, close))}</${tag}>`;
          i = close + d.length;
          continue;
        }
        if (close < 0) noCloser.add(d);
      }
      out += escapeHtml(s.slice(i, i + run));
      i += run;
      continue;
    }
    out += escapeHtml(c);
    i++;
  }
  return out;
}

// ---------------- blocks ----------------

const FENCE = /^ {0,3}(`{3,}|~{3,})\s*([\w+#.-]*)/;

/** Convert agent markdown to Telegram HTML. Blocks are joined with "\n". */
export function markdownToHtml(md: string): string {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2]!.replace(/[^\w+-]/g, "");
      const body: string[] = [];
      const close = new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}\\s*$`);
      i++;
      while (i < lines.length && !close.test(lines[i]!)) {
        body.push(lines[i]!);
        i++;
      }
      i++; // closing fence (or past the end while streaming)
      const cls = lang ? ` class="language-${lang}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (/^\s*>/.test(line)) {
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^\s*> ?/, ""));
        i++;
      }
      out.push(`<blockquote>${quoted.map(inlineToHtml).join("\n")}</blockquote>`);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const rows: string[] = [];
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i]!)) {
        if (!/^\s*\|[\s|:-]+\|\s*$/.test(lines[i]!)) rows.push(lines[i]!.trim());
        i++;
      }
      out.push(`<pre>${escapeHtml(rows.join("\n"))}</pre>`);
      continue;
    }
    const heading = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (heading) {
      out.push(`<b>${inlineToHtml(heading[1]!)}</b>`);
      i++;
      continue;
    }
    if (/^ {0,3}([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push("———");
      i++;
      continue;
    }
    const bullet = /^(\s*)[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      out.push(`${bullet[1]!}• ${inlineToHtml(bullet[2]!)}`);
      i++;
      continue;
    }
    out.push(inlineToHtml(line));
    i++;
  }
  return out.join("\n");
}

// ---------------- splitting ----------------

type Tok = { kind: "open"; name: string; raw: string } | { kind: "close"; name: string; raw: string } | { kind: "text"; raw: string };

function tokenize(html: string): Tok[] {
  const toks: Tok[] = [];
  const re = /<(\/?)([a-z-]+)[^>]*>/g;
  let last = 0;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m.index > last) toks.push({ kind: "text", raw: html.slice(last, m.index) });
    toks.push({ kind: m[1] ? "close" : "open", name: m[2]!, raw: m[0] });
    last = re.lastIndex;
  }
  if (last < html.length) toks.push({ kind: "text", raw: html.slice(last) });
  return toks;
}

/** Visible length as Telegram counts it (UTF-16 units, an entity is one char). */
export function visibleLength(html: string): number {
  return html.replace(/<[^>]*>/g, "").replace(/&(amp|lt|gt|quot);/g, "_").length;
}

/** Split escaped text into units: whole entities and whole surrogate pairs. */
function textUnits(raw: string): string[] {
  return raw.match(/&(?:amp|lt|gt|quot);|[\uD800-\uDBFF][\uDC00-\uDFFF]|[\s\S]/g) ?? [];
}

/** Visible width of a unit in UTF-16 code units (what Telegram's 4096 limit counts). */
function unitWidth(u: string): number {
  return u.length > 1 && u.startsWith("&") ? 1 : u.length;
}

/** Tag-aware hard split of one piece that is longer than `limit`. Prefers newline, then space. */
function hardSplit(html: string, limit: number): string[] {
  const chunks: string[] = [];
  const stack: Array<{ name: string; raw: string }> = [];
  let cur = "";
  let len = 0;
  const reopen = () => stack.map((t) => t.raw).join("");
  const closeAll = () => [...stack].reverse().map((t) => `</${t.name}>`).join("");
  const flush = () => {
    chunks.push(cur + closeAll());
    cur = reopen();
    len = 0;
  };
  for (const tok of tokenize(html)) {
    if (tok.kind === "open") {
      stack.push({ name: tok.name, raw: tok.raw });
      cur += tok.raw;
      continue;
    }
    if (tok.kind === "close") {
      const idx = stack.map((t) => t.name).lastIndexOf(tok.name);
      if (idx >= 0) stack.splice(idx, 1);
      cur += tok.raw;
      continue;
    }
    let units = textUnits(tok.raw);
    while (units.length) {
      const room = limit - len;
      // how many whole units fit: Telegram counts UTF-16 code units (an emoji is 2), an entity is 1 visible char
      let fits = 0;
      let used = 0;
      while (fits < units.length && used + unitWidth(units[fits]!) <= room) used += unitWidth(units[fits++]!);
      if (fits === units.length) {
        cur += units.join("");
        len += used;
        break;
      }
      if (fits === 0) {
        if (len > 0) {
          flush();
          continue;
        }
        fits = 1; // a single unit wider than the limit (limit < 2): emit it rather than loop
      }
      let cut = fits;
      const window = units.slice(0, fits);
      const nl = window.lastIndexOf("\n");
      const sp = window.lastIndexOf(" ");
      if (nl > fits / 2) cut = nl + 1;
      else if (sp > fits / 2) cut = sp + 1;
      cur += units.slice(0, cut).join("");
      units = units.slice(cut);
      flush();
    }
  }
  if (visibleLength(cur) > 0 || chunks.length === 0) chunks.push(cur + closeAll());
  return chunks;
}

/**
 * Split Telegram HTML into messages of at most `limit` visible chars.
 * Prefers top-level line boundaries; never leaves a tag unclosed in a chunk.
 */
export function splitHtml(html: string, limit = TG_TEXT_LIMIT): string[] {
  if (visibleLength(html) <= limit) return [html];
  // Top-level lines: newline positions outside any tag.
  const pieces: string[] = [];
  let depth = 0;
  let start = 0;
  for (const tok of tokenize(html).reduce<Array<{ tok: Tok; at: number }>>((acc, t) => {
    const at = acc.length ? acc[acc.length - 1]!.at + acc[acc.length - 1]!.tok.raw.length : 0;
    acc.push({ tok: t, at });
    return acc;
  }, [])) {
    if (tok.tok.kind === "open") depth++;
    else if (tok.tok.kind === "close") depth = Math.max(0, depth - 1);
    else if (depth === 0) {
      let k = tok.tok.raw.indexOf("\n");
      while (k >= 0) {
        pieces.push(html.slice(start, tok.at + k));
        start = tok.at + k + 1;
        k = tok.tok.raw.indexOf("\n", k + 1);
      }
    }
  }
  pieces.push(html.slice(start));

  const chunks: string[] = [];
  let cur = "";
  for (const piece of pieces) {
    const candidate = cur ? `${cur}\n${piece}` : piece;
    if (visibleLength(candidate) <= limit) {
      cur = candidate;
      continue;
    }
    if (cur) chunks.push(cur);
    if (visibleLength(piece) <= limit) {
      cur = piece;
    } else {
      const parts = hardSplit(piece, limit);
      chunks.push(...parts.slice(0, -1));
      cur = parts[parts.length - 1] ?? "";
    }
  }
  if (cur) chunks.push(cur);
  return chunks.filter((c) => visibleLength(c) > 0 || c.length > 0);
}

/** Shorten plain text to `max` UTF-16 code units with an ellipsis; never splits a surrogate pair. */
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  let end = Math.max(0, max - 1);
  const last = s.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return s.slice(0, end) + "…";
}
