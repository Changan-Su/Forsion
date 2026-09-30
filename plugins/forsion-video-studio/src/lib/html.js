// Surgical edits to a scene's HTML without a DOM: find its text runs and start tags with their offsets,
// then change only those characters. The runtime numbers text nodes the same way (non-blank text,
// document order, nothing inside script/style/textarea/title), so a click in the preview maps to a run here.

const RAW = /^(script|style|textarea|title)$/i;
const VOID = /^(area|base|br|col|embed|hr|img|input|link|meta|source|track|wbr)$/i;
const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', ndash: '–', hellip: '…', middot: '·', copy: '©', reg: '®', trade: '™', laquo: '«', raquo: '»', ldquo: '“', rdquo: '”', lsquo: '‘', rsquo: '’', times: '×', larr: '←', rarr: '→', uarr: '↑', darr: '↓', bull: '•' };

export const decode = s => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, k) => {
  if (k[0] === '#') { const c = k[1] === 'x' || k[1] === 'X' ? parseInt(k.slice(2), 16) : +k.slice(1); try { return String.fromCodePoint(c); } catch { return m; } }
  return ENT[k.toLowerCase()] ?? m;
});
export const escapeText = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const escapeAttr = s => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/** End of the tag that starts at `i` (index just past '>'), honouring quoted attribute values. */
function tagEnd(html, i) {
  let q = null;
  for (let k = i + 1; k < html.length; k++) {
    const c = html[k];
    if (q) { if (c === q) q = null; }
    else if (c === '"' || c === "'") q = c;
    else if (c === '>') return k + 1;
  }
  return html.length;
}

const ATTR = /([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

/** Walk the markup once: text runs (non-blank) and start tags, both with offsets. */
export function scan(html) {
  const texts = [], tags = [];
  const stack = [];
  let i = 0, textStart = 0;
  const n = html.length;
  const pushText = (a, b) => {
    if (b <= a) return;
    const raw = html.slice(a, b), text = decode(raw);
    if (/\S/.test(text)) texts.push({ index: texts.length, start: a, end: b, raw, text, tag: stack.length ? stack[stack.length - 1] : -1 });
  };
  while (i < n) {
    if (html[i] !== '<') { i++; continue; }
    if (html.startsWith('<!--', i)) { pushText(textStart, i); const e = html.indexOf('-->', i + 4); i = e < 0 ? n : e + 3; textStart = i; continue; }
    const m = /^<(\/?)([A-Za-z][\w:-]*)/.exec(html.slice(i, i + 80));
    if (!m) { if (html[i + 1] === '!' || html[i + 1] === '?') { pushText(textStart, i); i = tagEnd(html, i); textStart = i; } else i++; continue; }
    pushText(textStart, i);
    const end = tagEnd(html, i), name = m[2].toLowerCase();
    if (m[1]) {
      for (let k = stack.length - 1; k >= 0; k--) if (tags[stack[k]].name === name) { stack.length = k; break; }
      i = end; textStart = i; continue;
    }
    const body = html.slice(i + 1 + m[2].length, end - 1);
    const attrs = [];
    const selfClose = /\/\s*$/.test(body);
    ATTR.lastIndex = 0;
    let a;
    while ((a = ATTR.exec(body))) {
      if (a[1] === '/') continue;
      const off = i + 1 + m[2].length + a.index;
      const v = a[2] ?? a[3] ?? a[4];
      attrs.push({ name: a[1].toLowerCase(), value: v === undefined ? '' : decode(v), start: off, end: off + a[0].length });
    }
    const tag = { index: tags.length, name, start: i, end, attrs, attr: k => (attrs.find(x => x.name === k) || {}).value };
    tags.push(tag);
    i = end; textStart = i;
    if (RAW.test(name) && !selfClose) {
      const close = html.toLowerCase().indexOf(`</${name}`, i);
      i = close < 0 ? n : close; textStart = i;
      continue;
    }
    if (!VOID.test(name) && !selfClose) stack.push(tag.index);
  }
  pushText(textStart, n);
  return { texts, tags };
}

export const textRuns = html => scan(html).texts;

/** Replace text run `index`, keeping the whitespace around it. */
export function replaceText(html, index, value) {
  const t = scan(html).texts[index];
  if (!t) throw new Error(`no text #${index}`);
  const lead = t.raw.match(/^\s*/)[0], trail = t.raw.match(/\s*$/)[0];
  return html.slice(0, t.start) + lead + escapeText(String(value).trim()) + trail + html.slice(t.end);
}

/** Set (or with null remove) an attribute on start tag `index`. */
export function setAttr(html, index, name, value) {
  const tag = scan(html).tags[index];
  if (!tag) throw new Error(`no tag #${index}`);
  const a = tag.attrs.find(x => x.name === name.toLowerCase());
  if (value === null || value === undefined) {
    if (!a) return html;
    let s = a.start; while (s > tag.start && /\s/.test(html[s - 1])) s--;
    return html.slice(0, s) + html.slice(a.end);
  }
  const piece = `${name}="${escapeAttr(value)}"`;
  if (a) return html.slice(0, a.start) + piece + html.slice(a.end);
  let at = tag.end - 1; if (html[at - 1] === '/') at--;
  while (at > tag.start && /\s/.test(html[at - 1])) at--;
  return html.slice(0, at) + ' ' + piece + html.slice(at);
}

/** Images in source order: { tag, src }. */
export const images = html => scan(html).tags.filter(t => t.name === 'img').map(t => ({ tag: t.index, src: t.attr('src') || '' }));

/** Elements with declarative timing, with the first text inside them as a label. */
export function timedElements(html) {
  const { texts, tags } = scan(html);
  return tags.filter(t => ['data-in', 'data-out', 'data-seq'].some(k => t.attr(k) !== undefined)).map(t => {
    const label = texts.find(x => x.start > t.start);
    return { tag: t.index, name: t.name, in: t.attr('data-in'), out: t.attr('data-out'), fx: t.attr('data-fx'), seq: t.attr('data-seq'), each: t.attr('data-each'), label: label ? label.text.trim().slice(0, 40) : `<${t.name}>` };
  });
}
