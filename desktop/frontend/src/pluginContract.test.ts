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
const css = ['desktop/frontend/src', 'lcl'].flatMap((dir) =>
  (readdirSync(join(ROOT, dir), { recursive: true }) as string[])
    .filter((f) => f.endsWith('.css') && !f.includes('node_modules'))
    .map((f) => readFileSync(join(ROOT, dir, f), 'utf8')),
).join('\n');
const tokens: string[] = Object.values(contract.tokens as Record<string, Record<string, string>>).flatMap(Object.keys);
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

describe('plugin-contract.json ↔ 宿主 CSS', () => {
  it('每个公开 token 宿主都定义着', () => {
    expect(tokens.filter((t) => !new RegExp(`(?<![\\w-])${esc(t)}\\s*:`).test(css))).toEqual([]);
  });
  it('每个公开类名宿主都有规则', () => {
    expect(Object.keys(contract.classes).filter((c) => !new RegExp(`${esc(c)}(?![\\w-])`).test(css))).toEqual([]);
  });
  it('since / fallbackAllowed / deprecated 只指向契约里的 token', () => {
    const pub = new Set(tokens);
    expect(Object.keys(contract.since).filter((t) => t !== '$comment' && !pub.has(t))).toEqual([]);
    expect(contract.fallbackAllowed.filter((t: string) => !pub.has(t))).toEqual([]);
    expect(Object.keys(contract.deprecated).filter((t) => pub.has(t))).toEqual([]);
  });
});
