/**
 * 插件样式契约(tangu-agent/skills/forsion-plugin/tools/plugin-contract.json)与宿主 CSS 对账:
 * 契约里列的 token 宿主都定义着、类名宿主都有规则,`since` 只记契约里有的 token。
 * 改名 / 删掉一个公开 token 或类名会在这里红:要么别动它,要么同轮改契约(插件作者手册、技能、生态指南跟着改)。
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const contract = JSON.parse(readFileSync(join(ROOT, 'tangu-agent/skills/forsion-plugin/tools/plugin-contract.json'), 'utf8'));
const cssOf = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
  e.name === 'node_modules' ? [] : e.isDirectory() ? cssOf(join(dir, e.name)) : e.name.endsWith('.css') ? [readFileSync(join(dir, e.name), 'utf8')] : []);
const css = ['desktop/frontend/src', 'lcl'].flatMap((dir) => cssOf(join(ROOT, dir))).join('\n');
const tokens: string[] = Object.values(contract.tokens as Record<string, Record<string, string>>).flatMap(Object.keys);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('plugin-contract.json ↔ 宿主 CSS', () => {
  it('每个公开 token 宿主都定义着', () => {
    expect(tokens.filter((t) => !new RegExp(`(?<![\\w-])${esc(t)}\\s*:`).test(css))).toEqual([]);
  });
  it('每个公开类名宿主都有规则', () => {
    expect(Object.keys(contract.classes).filter((c) => !new RegExp(`${esc(c)}(?![\\w-])`).test(css))).toEqual([]);
  });
  it('插件视图的基础样式:零权重、全局 button 重置让出同一批按钮、只用公开 token 不写兜底、排在重置与表单基线之后', () => {
    const base = readFileSync(join(ROOT, 'desktop/frontend/src/styles/base.css'), 'utf8');
    const start = base.indexOf('/* plugin-view-base:start'), end = base.indexOf('/* plugin-view-base:end');
    expect(start).toBeGreaterThan(base.indexOf('/* form-baseline:end */'));
    const block = base.slice(start, end).replace(/\/\*[\s\S]*?\*\//g, '');
    // 重置让出的那批与基础样式接管的那批必须逐字同一串:差一个字就是两头都不管(UA 灰按钮)或两头都管(插件零权重规则又输)
    const scope = /^:where\(([^{]*?)\) \{/m.exec(block)?.[1];
    expect(scope).toMatch(/^\[data-plugin-view-host\] button:not\(\[class\]/);
    expect(base).toContain(`button:where(:not(${scope})) { font: inherit;`);
    // 每条规则都整条包在 :where() 里
    expect(block.match(/^[^\s}][^{]*\{/gm)?.filter((sel) => !sel.startsWith(':where('))).toEqual([]);
    const bad = [...block.matchAll(/var\((--[\w-]+)([^)]*)\)/g)].filter(([, t, rest]) => !tokens.includes(t) || rest.trim()).map((m) => m[0]);
    expect(bad).toEqual([]);
  });
  it('since / fallbackAllowed / deprecated 只指向契约里的 token', () => {
    const pub = new Set(tokens);
    expect(Object.keys(contract.since).filter((t) => t !== '$comment' && !pub.has(t))).toEqual([]);
    expect(contract.fallbackAllowed.filter((t: string) => !pub.has(t))).toEqual([]);
    expect(Object.keys(contract.deprecated).filter((t) => pub.has(t))).toEqual([]);
  });
});
