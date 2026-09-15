/**
 * 记忆 / Historian / 会话召回这几层必须走接缝(deps().state / deps().brain),不得直连 node:fs 或 core/db.js。
 *
 * 为什么是硬门禁:直连的功能在 thin worker(云端 Web / 移动端)天生是死的——2026-09 记忆系统「桌面全血、
 * 云端残血」的唯一根因就是五个服务长在 fs + query 上(memoryRepository / memoryCandidates / memoryDream /
 * localHistorian / sessionSearch)。会话召回已改走 StateStore,SQL 后端在 BACKENDS 里逐文件放行(只放行 core/db.js)。
 *
 * 棘轮语义(照 desktop 的 check:parity):
 *   - 范围内的文件不得含被禁 import;新文件默认受管。范围 = services/ 与 tools/builtin/ **递归**、按文件名模式;
 *     services/stateStore/ 整目录必进(召回链的两份 StateStore 实现在这里)。
 *   - KNOWN_DEBT 列存量欠债(文件 → 仍在的被禁 import + 理由/下一步);**清完必须删条目**,条目失效即红。
 *   - 已知天花板(ponytail):按 import/require 说明符做正则匹配,不做 AST;改名绕过模式仍可能漏——加新记忆层文件时
 *     同步补 IN_SCOPE。
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath 而非 .pathname:Windows 上 pathname 是 `/C:/...`,readdirSync 直接炸(仓里有 Windows CI 门)。
const ROOT = fileURLToPath(new URL('../src/', import.meta.url));
const SCOPE_DIRS = ['services', 'tools/builtin'];
const IN_SCOPE = /^(memory\w*|\w*[hH]istorian\w*|session(Search|Recall)\w*|\w*[Rr]ecall\w*|readSession|searchSessions)\.ts$/;
const ALWAYS_IN_SCOPE_DIRS = ['services/stateStore'];
const BANNED: Array<{ id: string; re: RegExp }> = [
  // 静态 import / export-from / 动态 import() / require(),单双引号都认
  { id: 'node:fs', re: /(from\s*|import\s*\(\s*|require\s*\(\s*)['"](node:fs|fs|node:fs\/promises|fs\/promises)['"]/ },
  { id: 'core/db.js', re: /(from\s*|import\s*\(\s*|require\s*\(\s*)['"](\.\.\/)+core\/db\.js['"]/ },
];
/** 持库后端实现:逐文件、逐 import 放行(只放 core/db.js,node:fs 一律不放)。 */
const BACKENDS: Record<string, string[]> = {
  'services/sessionSearchSql.ts': ['core/db.js'],
  'services/stateStore/sqlStateStore.ts': ['core/db.js'],
};
/** 存量欠债:清一个删一行。理由写清「为什么还在」与「哪一步清」。 */
const KNOWN_DEBT: Record<string, { imports: string[]; reason: string }> = {
  'services/memoryRepository.ts': { imports: ['node:fs'], reason: 'P2:版本化记忆仓库改走 agentFiles 形状的接缝(桌面/云端同一份代码)' },
  'services/memoryDream.ts': { imports: ['core/db.js'], reason: 'P2:随 memoryRepository 上接缝;会话读改经 deps().state' },
  'services/localHistorian.ts': { imports: ['core/db.js'], reason: 'P3:按轮 Historian 进 worker(done-run 计数与会话读改经 deps().state)' },
  'services/historian.ts': { imports: ['core/db.js'], reason: '网关空闲扫描版,持库进程专属;P3 落地后退役' },
  'services/historianConfig.ts': { imports: ['core/db.js'], reason: '网关扫描版的 admin 配置(global_settings),随 historian.ts 退役' },
};

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) out.push(full);
  }
  return out;
}
function scopedFiles(): string[] {
  const out = new Set<string>();
  for (const dir of SCOPE_DIRS) {
    for (const full of walk(join(ROOT, dir))) {
      const rel = relative(ROOT, full).split(sep).join('/');
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      if (IN_SCOPE.test(name) || ALWAYS_IN_SCOPE_DIRS.some((d) => rel.startsWith(`${d}/`))) out.add(rel);
    }
  }
  return [...out].sort();
}
/** 去掉整行注释(`//` 与块注释的 ` *` 行)再匹配,免得头注里写 `from '../core/db.js'` 之类的说明误报。 */
const stripComments = (src: string): string => src.split('\n').filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
const bannedIn = (rel: string): string[] => {
  const src = stripComments(readFileSync(join(ROOT, rel), 'utf8'));
  return BANNED.filter((b) => b.re.test(src)).map((b) => b.id);
};

describe('memory / historian / session-recall seam boundary', () => {
  it('scans the expected layer (sanity: the ratchet is not silently scanning nothing)', () => {
    const files = scopedFiles();
    expect(files).toEqual(expect.arrayContaining(['services/memoryRecall.ts', 'services/sessionSearch.ts', 'services/sessionSearchSql.ts',
      'services/stateStore/httpStateStore.ts', 'services/stateStore/sqlStateStore.ts', 'tools/builtin/readSession.ts', 'tools/builtin/searchSessions.ts']));
    expect(files.length).toBeGreaterThanOrEqual(10);
  });
  it('the banned-import matcher catches every import form and ignores comments', () => {
    const hit = (src: string) => BANNED.filter((b) => b.re.test(stripComments(src))).map((b) => b.id);
    expect(hit(`import { query } from "../../core/db.js";`)).toEqual(['core/db.js']);
    expect(hit(`const fs = await import('node:fs/promises');`)).toEqual(['node:fs']);
    expect(hit(`const { readFileSync } = require("fs");`)).toEqual(['node:fs']);
    expect(hit(`export { query } from '../core/db.js';`)).toEqual(['core/db.js']);
    expect(hit(`// 见 import { query } from '../core/db.js'\n * from 'node:fs'\nconst x = 1;`)).toEqual([]);
  });
  it('no file outside BACKENDS / KNOWN_DEBT imports node:fs or core/db.js directly', () => {
    const leaks = scopedFiles().filter((f) => !KNOWN_DEBT[f] && !BACKENDS[f]).map((f) => ({ f, banned: bannedIn(f) })).filter((x) => x.banned.length);
    expect(leaks, '新增直连 fs/db 的记忆层文件:云端(thin worker)会整体不可用,改走 deps().state / deps().brain').toEqual([]);
  });
  it('backends may touch only what they are allowed to (core/db.js), never node:fs', () => {
    for (const [f, allowed] of Object.entries(BACKENDS)) {
      expect(scopedFiles(), `${f} 已不在范围内,更新 BACKENDS`).toContain(f);
      expect(bannedIn(f).filter((id) => !allowed.includes(id)), `${f} 越过了后端放行清单`).toEqual([]);
    }
  });
  it('KNOWN_DEBT entries are still real (a cleared file must be removed from the list)', () => {
    for (const [f, debt] of Object.entries(KNOWN_DEBT)) {
      expect(scopedFiles(), `${f} 已不在范围内,删掉 KNOWN_DEBT 条目`).toContain(f);
      expect(bannedIn(f).sort(), `${f} 的欠债与登记不符(清了就删条目;新增了就补理由)`).toEqual([...debt.imports].sort());
    }
  });
});
