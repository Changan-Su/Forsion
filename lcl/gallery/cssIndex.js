/**
 * CSS 目录解析器 —— 纯函数,不碰 DOM,故可 `node cssIndex.js` 直接自测(见文件末尾)。
 *
 * 为什么手写扫描器而不用 CSSOM:CSSOM **丢注释**,而分节注释正是本图鉴的分类与「使用时机」来源。
 *
 * 已知边界(有意不做):原生嵌套 `.a { & .b {…} }` 的内层规则不登记 —— 当前真源里一处都没有,
 * 真出现了是「少登记」而不是「错登记」。自测里有一条断言在盯着这个前提。
 */

/** 从 `{` 起找配对的 `}`(跳过注释与字符串)。 */
export function matchBrace(text, open) {
  let depth = 0;
  for (let k = open; k < text.length; k++) {
    const c = text[k];
    if (c === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k + 2); k = e < 0 ? text.length : e + 1; continue; }
    if (c === '"' || c === "'") { k = endOfString(text, k); continue; }
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return k;
  }
  return text.length - 1;
}

function endOfString(text, quotePos) {
  const q = text[quotePos];
  let k = quotePos + 1;
  while (k < text.length && text[k] !== q) { if (text[k] === '\\') k++; k++; }
  return k;
}

/**
 * 找 i 之后第一个**顶层**的 stops 字符(不在注释 / 字符串 / `[]` / `()` 里)。没有则 -1。
 * 选择器前导必须这么扫:`[data-x="{"] .a {…}` 里那个 `{` 在属性值里,直接 indexOf 会把它当块起点,
 * 吞掉后面整段规则 —— 合法 CSS,静默错算。
 */
export function scanTo(text, i, stops) {
  let paren = 0, bracket = 0;
  for (let k = i; k < text.length; k++) {
    const c = text[k];
    if (c === '/' && text[k + 1] === '*') { const e = text.indexOf('*/', k + 2); k = e < 0 ? text.length : e + 1; continue; }
    if (c === '"' || c === "'") { k = endOfString(text, k); continue; }
    if (c === '(') paren++;
    else if (c === ')' && paren) paren--;
    else if (c === '[') bracket++;
    else if (c === ']' && bracket) bracket--;
    else if (!paren && !bracket && stops.includes(c)) return k;
  }
  return -1;
}

export const cleanEdges = (s) => s.replace(/^[\s*─═—=-]+/, '').replace(/[\s*─═—=-]+$/, '').trim();

export const classesIn = (sel) => (sel.match(/\.-?[A-Za-z_][\w-]*/g) || []).map((c) => c.slice(1));
export const varsUsed = (body) => (body.match(/var\(\s*(--[\w-]+)/g) || []).map((v) => v.replace(/var\(\s*/, ''));
export const varsDeclared = (body) => (body.match(/(?:^|[;{\s])(--[\w-]+)\s*:/g) || []).map((v) => v.match(/--[\w-]+/)[0]);

/**
 * 解析为 [{title, doc, line, rules:[{sel, body, line, doc}]}]。
 * 分节判定 = 注释里出现制表线(─ ═)、以 `/**` 开头、或首行带 4+ 个 ASCII `-`/`=`;
 * 其余注释归为紧随其后那条规则的说明。
 * @media/@supports/@layer/@container/@scope 直接下潜(内层规则照常登记),其余带块的 at-rule 整块跳过。
 */
export function parseCss(text) {
  const sections = [];
  let cur = { title: '未分节', doc: '', line: 1, rules: [] };
  sections.push(cur);
  let i = 0, pos = 0, line = 1, pending = null;
  const lineAt = (idx) => { while (pos < idx) { if (text[pos] === '\n') line++; pos++; } return line; };
  const N = text.length;

  while (i < N) {
    const ch = text[i];
    if (ch === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const startLine = lineAt(i);
      const inner = text.slice(i + 2, end < 0 ? N : end);
      const lines = inner.split('\n').map((l) => l.replace(/^\s*\*+/, '').trim());
      const title = cleanEdges(lines.find((l) => cleanEdges(l)) || ''); // /** 头注释首行是裸 *,取第一条有字的
      if ((/[─═]/.test(inner) || text[i + 2] === '*' || /[-=]{4,}/.test(lines[0] || '')) && title) {
        cur = { title, doc: lines.map(cleanEdges).filter(Boolean).slice(1).join('\n').trim(), line: startLine, rules: [] };
        sections.push(cur);
        pending = null;
      } else if (title || lines.length > 1) {
        pending = lines.map((l) => l.trim()).filter(Boolean).join(' ');
      }
      i = end < 0 ? N : end + 2;
      continue;
    }
    if (ch === '}' || /\s/.test(ch)) { i++; continue; }
    if (ch === '@') {
      const j = scanTo(text, i, '{;');
      if (j < 0) break;
      const name = text.slice(i, j).trim().split(/\s+/)[0];
      pending = null;
      if (text[j] === ';') { i = j + 1; continue; }
      if (/^@(media|supports|layer|container|scope)$/.test(name)) { i = j + 1; continue; } // 下潜
      i = matchBrace(text, j) + 1;                                                          // 整块跳过
      continue;
    }
    const j = scanTo(text, i, '{}');
    if (j < 0) break;
    if (text[j] === '}') { i = j + 1; continue; }
    const sel = text.slice(i, j).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\s+/g, ' ').trim();
    const startLine = lineAt(i);
    const bEnd = matchBrace(text, j);
    if (sel) cur.rules.push({ sel, body: text.slice(j + 1, bEnd), line: startLine, doc: pending });
    pending = null;
    i = bEnd + 1;
  }
  return sections.filter((s) => s.rules.length || s.doc);
}

// ── 自测:`node cssIndex.js`。真源 CSS 变了而解析器跟不上时,这里先红。 ──────────────
// ⚠️ `typeof process` 不能省:浏览器里 process 是**未声明标识符**,`process?.argv` 照样抛 ReferenceError。
if (typeof process !== 'undefined' && import.meta.url === `file://${process.argv[1]}`) {
  const { default: assert } = await import('node:assert/strict');
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const { dirname, join } = await import('node:path');
  const here = dirname(fileURLToPath(import.meta.url));

  // 1) Codex 点名的那几条合法但会咬人的 CSS
  const tricky = `
/* ─── 分节 ─── */
[data-x="{"] .a { color: red }
.b /* 选择器里插注释 */ { color: blue }
@supports selector([data-x="{"]) { .c { color: teal } }
@media (min-width: 10px) { .d { --v: 1px } }
@keyframes kf { from { color: pink } to { color: gray } }
.e[title='a}b'] { color: lime }
:is(.f, .g) .h:has(.i) { color: navy }
`;
  const secs = parseCss(tricky);
  const sels = secs.flatMap((s) => s.rules.map((r) => r.sel));
  assert.deepEqual(sels, ['[data-x="{"] .a', '.b', '.c', '.d', ".e[title='a}b']", ':is(.f, .g) .h:has(.i)'],
    '选择器前导扫描应跳过注释/字符串/方括号,且 @keyframes 整块跳过');
  assert.deepEqual([...new Set(sels.flatMap(classesIn))].sort(), ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i']);
  assert.deepEqual(secs.flatMap((s) => s.rules.flatMap((r) => varsDeclared(r.body))), ['--v'], '@media 内的声明要登记');
  assert.equal(secs[0].title, '分节');

  // 2) 真源:数量对得上 + 没有可疑选择器
  // 阈值 = 实测值留约 15% 余量:掉到线下基本只有一种解释 —— 解析器吞了规则。
  const files = [
    ['../../desktop/frontend/src/styles/base.css', 670],   // 实测 790
    ['../../desktop/frontend/src/theme/skins.css', 0],     // 纯 token 文件
    ['../engine/engine.css', 88],                          // 实测 103
    ['../engine/singleColumn.css', 38],                    // 实测 45
    ['../engine/miniCard.css', 40],                        // 实测 48
    ['../engine/skeleton.css', 18],                        // 实测 21
  ];
  let totalClasses = 0, totalTokens = 0;
  for (const [rel, minClasses] of files) {
    const txt = readFileSync(join(here, rel), 'utf8');
    const ss = parseCss(txt);
    const rules = ss.flatMap((s) => s.rules);
    const cls = new Set(rules.flatMap((r) => classesIn(r.sel)));
    totalClasses += cls.size;
    rules.forEach((r) => varsDeclared(r.body).forEach(() => totalTokens++));
    assert.ok(ss.length, `${rel}:至少应有 1 个分节`);
    assert.ok(cls.size >= minClasses, `${rel}:类名 ${cls.size} < ${minClasses},解析器可能吞了规则`);
    for (const r of rules) {
      assert.ok(!/[{}]|\/\*|\*\//.test(r.sel), `${rel}:选择器串味了 → ${r.sel}`);
      assert.ok(r.line >= 1 && r.line <= txt.split('\n').length, `${rel}:行号越界 → ${r.sel}`);
    }
    // 前提校验:出现原生嵌套就说明「不登记内层」这条边界该重估了
    assert.ok(!/^\s*&/m.test(txt), `${rel}:出现原生嵌套,解析器的已知边界需要重估`);
  }
  assert.ok(totalClasses > 900, `真源类名总数 ${totalClasses} 偏少`);
  assert.ok(totalTokens > 300, `真源 token 声明数 ${totalTokens} 偏少`);
  console.log(`ok — 边界用例 + 6 份真源(${totalClasses} 个类,${totalTokens} 条 token 声明)`);
}
