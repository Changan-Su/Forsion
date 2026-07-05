import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

// 本地特性(Special Agent / 压缩 / 会话)在 standalone 走 **SQLite**——禁用 Postgres 专有 SQL:
// `COUNT(*)::int` 之类 `::` cast、`make_interval(...)` 都会让 SQLite 报 "unrecognized token: ':'"。
// 这类错误常被外层 try/catch 吞掉,表现为「Historian 永不触发 / add_muse_todo 永远失败」。本测试守住回归。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..'); // src/db → 包根

const SQLITE_PATH_FILES = [
  'src/services/localHistorian.ts',
  'src/tools/builtin/museTodo.ts',
  'src/services/muse.ts',
  'src/services/compaction.ts',
  'src/routes/special.ts',
  'src/routes/sessions.ts',
  'src/agents/agentRegistry.ts',
];

/** 去掉块注释与行注释(避免注释里的示范文字误判)。这些文件无 http:// 之类含 `//` 的代码字面量。 */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .map((l) => l.replace(/\/\/.*/, ''))
    .join('\n');
}

describe('SQLite 方言安全(本地特性禁 PG 专有 SQL)', () => {
  for (const f of SQLITE_PATH_FILES) {
    it(`${f} 不含 ::cast / make_interval`, () => {
      const code = stripComments(readFileSync(path.join(root, f), 'utf-8'));
      expect(code, '不要用 PG 的 ::cast(SQLite 不认)').not.toMatch(/::\s*(int|bigint|float|text|numeric|timestamp)/i);
      expect(code, '不要用 PG 的 make_interval(SQLite 无此函数)').not.toMatch(/make_interval/);
    });
  }
});
