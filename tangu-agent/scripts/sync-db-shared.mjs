#!/usr/bin/env node
// 把 desktop/shared/amadeus/db/{formula,backlink,lookup}.ts(正典,渲染层与引擎共用的纯逻辑)vendor 进引擎:
//   formula.ts → src/services/dbFormula.ts;backlink.ts → src/services/dbBacklink.ts;lookup.ts → src/services/dbLookup.ts。
// 只做 import 路径的最小改写(desktop 的 './schema' 在引擎里对应 './amadeusDb.js';NodeNext 要 .js 后缀)
// 并在文件头加「勿手改」标记;其余逐字节相同。
// 用法: node scripts/sync-db-shared.mjs         # 同步
//       node scripts/sync-db-shared.mjs --check # 只比对(按同一套改写生成后再比),漂移 exit 1(接在 typecheck 后跑)
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const srcDir = join(root, '..', 'desktop', 'shared', 'amadeus', 'db');
const outDir = join(root, 'src', 'services');
const check = process.argv.includes('--check');

/** 源文件 → 目标文件 + import 改写表(键=源码里逐字出现的 from 串)。 */
const FILES = [
  { from: 'formula.ts', to: 'dbFormula.ts', rewrites: { "from './schema'": "from './amadeusDb.js'" } },
  // backlink.ts(可编辑投影列的反向 join / 幂等集合运算)→ dbBacklink.ts;lookup.ts 反向模式经它取命中行
  { from: 'backlink.ts', to: 'dbBacklink.ts', rewrites: { "from './schema'": "from './amadeusDb.js'" } },
  {
    from: 'lookup.ts',
    to: 'dbLookup.ts',
    rewrites: { "from './formula'": "from './dbFormula.js'", "from './backlink'": "from './dbBacklink.js'", "from './schema'": "from './amadeusDb.js'" },
  },
];

// tangu-agent 作为独立 npm 包发布/单独 checkout 时没有旁边的 desktop/ —— 缺源即视为「无正典可比」,不崩
//(与 sync-plugin-api 对 plugins/ 缺失的处理同款);有源才比对。
if (!existsSync(srcDir)) {
  console.log(`[sync-db-shared] 未找到 ${relative(root, srcDir)},跳过(引擎侧拷贝按现状使用)`);
  process.exit(0);
}

function render({ from, to, rewrites }) {
  let body = readFileSync(join(srcDir, from), 'utf8');
  for (const [k, v] of Object.entries(rewrites)) {
    if (!body.includes(k)) throw new Error(`[sync-db-shared] ${from} 里找不到预期的 import 串 ${k}(源文件结构变了,更新本脚本的改写表)`);
    body = body.split(k).join(v);
  }
  const header =
    `// ⚠️ vendor 自 desktop/shared/amadeus/db/${from}(scripts/sync-db-shared.mjs 生成),勿手改;\n` +
    `// 改源文件后跑 npm run sync:db-shared,typecheck 里的 --check 会抓漂移。\n`;
  return { path: join(outDir, to), text: header + body };
}

let drifted = 0;
for (const f of FILES) {
  const { path, text } = render(f);
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
  if (cur === text) continue;
  if (check) {
    console.error(`[sync-db-shared] 漂移: ${relative(root, path)}(与 desktop/shared/amadeus/db/${f.from} 不一致,跑 npm run sync:db-shared)`);
    drifted++;
  } else {
    writeFileSync(path, text);
    console.log(`[sync-db-shared] 已同步: ${relative(root, path)}`);
  }
}
if (check && drifted) process.exit(1);
console.log(`[sync-db-shared] ${check ? '一致' : '完成'}(${FILES.length} 份拷贝)`);
