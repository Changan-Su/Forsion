#!/usr/bin/env node
// 把 src/core/commandCatalog.ts(正典)同步到 Desktop 前端的拷贝。
// Desktop 不依赖本包(它是 spawn 子进程调引擎,不 import),所以只能拷贝 —— 与 sync-plugin-api 同款套路。
// 用法: node scripts/sync-command-catalog.mjs         # 同步
//       node scripts/sync-command-catalog.mjs --check # 只比对,漂移 exit 1(接在 typecheck 后跑)
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = join(root, 'src', 'core', 'commandCatalog.ts');
const check = process.argv.includes('--check');

const BANNER = `/* eslint-disable */
// ⚠️ 自动生成,勿手改。正典 = Forsion-Genesis/tangu-agent/src/core/commandCatalog.ts
// 改那边后跑 \`cd ../tangu-agent && npm run sync:commands\`;两侧 typecheck 都会 --check 拦漂移。
`;

const body = readFileSync(canonical, 'utf8');
const out = BANNER + body;

// Desktop 单独 checkout 时该目录可能不在 → 缺失即视为无拷贝待同步,不崩。
const targets = [join(root, '..', 'desktop', 'frontend', 'src', 'commandCatalog.ts')].filter((f) =>
  existsSync(dirname(f)),
);

let drifted = 0;
for (const f of targets) {
  const cur = existsSync(f) ? readFileSync(f, 'utf8') : '';
  if (cur === out) continue;
  if (check) {
    console.error(`[sync-commands] 漂移: ${f}(与 src/core/commandCatalog.ts 不一致,跑 npm run sync:commands)`);
    drifted++;
  } else {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, out);
    console.log(`[sync-commands] 已同步: ${f}`);
  }
}
if (check && drifted) process.exit(1);
console.log(`[sync-commands] ${check ? '一致' : '完成'}(${targets.length} 份拷贝)`);
