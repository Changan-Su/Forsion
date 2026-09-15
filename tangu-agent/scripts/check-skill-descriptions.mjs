#!/usr/bin/env node
/**
 * 内置技能描述长度体检(E3,2026-09-14 评审 §五 E 档)。**报告式,恒 exit 0 —— 不阻断。**
 *
 *   node scripts/check-skill-descriptions.mjs            # 列超标的
 *   node scripts/check-skill-descriptions.mjs --all      # 全部列出(看分布)
 *   node scripts/check-skill-descriptions.mjs --max 400  # 换阈值
 *
 * 为什么只报告不截断:技能描述是**触发契约**(skillLoadout.ts 只把「名称 + 描述」放进 system prompt,
 * 模型据此决定要不要 use_skill),盲截 = 未标注的产品收窄 —— P09 已被这条推翻(评审 §六)。
 * 这里量的是「作者纪律」:超标的该改成「一句话何时用 + 触发词单独列」,不是让工具去砍。
 * 计数口径:`[...s].length`,即 **Unicode 码点**数(一个汉字 1、emoji 1),不是 UTF-8 字节。
 */
import { readFileSync, readdirSync, existsSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const MAX = Number((() => { const i = argv.indexOf('--max'); return i >= 0 ? argv[i + 1] : 300; })()) || 300;
const ALL = argv.includes('--all');

/** 只收**内置技能本体**:skills/<id>/SKILL.md 与 agent-skills/<pack>/<id>/SKILL.md。
 *  更深的(如 forsion-plugin/samples/**)是模板素材,不是会进 system prompt 目录的技能。 */
function builtinSkills() {
  const out = [];
  const dirs = (p) => (existsSync(p) ? readdirSync(p).filter((d) => statSync(join(p, d)).isDirectory()) : []);
  for (const id of dirs(join(root, 'skills'))) out.push(join(root, 'skills', id, 'SKILL.md'));
  for (const pack of dirs(join(root, 'agent-skills'))) {
    for (const id of dirs(join(root, 'agent-skills', pack))) out.push(join(root, 'agent-skills', pack, id, 'SKILL.md'));
  }
  return out.filter(existsSync);
}

/** frontmatter 的 description:支持单行、以及 `>` / `|` 折叠标量的缩进续行。 */
function readDescription(file) {
  const lines = readFileSync(file, 'utf8').split('\n');
  if (lines[0].trim() !== '---') return null;
  let name = null; let desc = null;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break;
    const m = /^([A-Za-z_][\w-]*):\s?(.*)$/.exec(lines[i]);
    if (m && m[1] === 'name') name = m[2].trim();
    if (!m || m[1] !== 'description') continue;
    let value = m[2].trim();
    if (value === '>' || value === '|' || value === '>-' || value === '|-') {
      const parts = [];
      for (let j = i + 1; j < lines.length && lines[j].trim() !== '---'; j++) {
        if (!/^\s+\S/.test(lines[j]) && lines[j].trim() !== '') break;
        parts.push(lines[j].trim());
      }
      value = parts.join(value.startsWith('>') ? ' ' : '\n').trim();
    } else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    desc = value;
  }
  return desc === null ? null : { name, desc };
}

const rows = [];
for (const file of builtinSkills()) {
  const r = readDescription(file);
  const rel = relative(root, file);
  if (!r) { rows.push({ rel, name: '(无 frontmatter description)', len: 0, missing: true }); continue; }
  rows.push({ rel, name: r.name || rel.split('/').at(-2), len: [...r.desc].length });
}
rows.sort((a, b) => b.len - a.len);

const over = rows.filter((r) => r.len > MAX);
const lens = rows.filter((r) => !r.missing).map((r) => r.len);
const sum = lens.reduce((a, b) => a + b, 0);
console.log(`内置技能 ${rows.length} 个;描述长度(码点)总计 ${sum},均值 ${lens.length ? Math.round(sum / lens.length) : 0},最长 ${lens.length ? Math.max(...lens) : 0};阈值 ${MAX}`);
console.log(`超标 ${over.length} 个${over.length ? ':' : ' —— 全部达标'}`);
for (const r of (ALL ? rows : over)) {
  console.log(`  ${String(r.len).padStart(5)}  ${r.missing ? '(缺 description)' : ''}${(r.name || '').slice(0, 30).padEnd(32)}${r.rel}`);
}
const missing = rows.filter((r) => r.missing);
if (missing.length) console.log(`⚠️ ${missing.length} 个技能 frontmatter 里没有 description —— 目录里它没有触发契约,模型不会主动 use_skill。`);
if (over.length) console.log(`\n改法(评审 §五 E3):描述压成「一句话何时用」,把触发词 / 场景枚举挪到 SKILL.md 正文或单独字段;**不要截断**——描述是触发契约,盲截等于悄悄收窄产品(§六 P09)。`);
// ponytail: 报告式,恒 0 —— 阈值是作者纪律的提醒,不是 CI 门禁(真要门禁得先定 N 并把存量改完)。
