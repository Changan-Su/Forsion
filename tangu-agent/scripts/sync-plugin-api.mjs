#!/usr/bin/env node
// 把 plugin-api/tangu-agent.d.ts(正典)逐字节同步到各首方插件的 types/ 拷贝。
// 用法: node scripts/sync-plugin-api.mjs        # 同步
//       node scripts/sync-plugin-api.mjs --check # 只比对,漂移 exit 1(接在 typecheck 后跑)
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const canonical = join(root, 'plugin-api', 'tangu-agent.d.ts');
const src = readFileSync(canonical, 'utf8');
const check = process.argv.includes('--check');

// plugins/ 是本地首方插件工作拷贝目录,CI 全新 checkout 里可能不存在 → 缺失即视为「无拷贝待同步」,不崩。
const pluginsDir = join(root, 'plugins');
const targets = existsSync(pluginsDir)
  ? readdirSync(pluginsDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => join(pluginsDir, d.name, 'types', 'tangu-agent.d.ts'))
      .filter((f) => existsSync(f))
  : [];

// 官方模板同样消费公开契约,不能等作者复制后才发现类型落后于宿主。
for (const rel of [
  ['forsion-sample-plugin', 'types', 'tangu-agent.d.ts'],
  ['forsion-sample-bundle', 'tangu-plugins', 'sample-bundle-tool', 'types', 'tangu-agent.d.ts'],
]) {
  const f = join(root, 'skills', 'forsion-plugin', 'samples', ...rel);
  if (existsSync(f)) targets.push(f);
}

// 外部独立仓插件的 types/ 拷贝(相对 tangu-agent 根的路径段;单独 checkout 里可能不存在 → existsSync 过滤,不崩)。
// tangu-computer-use 在 Forsion/Forsion-Instrumentality-Project/(插件生态目录,07-16 从 Forsion-Genesis 移出)。
for (const rel of [['..', '..', 'Forsion-Instrumentality-Project', 'tangu-computer-use']]) {
  const f = join(root, ...rel, 'types', 'tangu-agent.d.ts');
  if (existsSync(f)) targets.push(f);
}

let drifted = 0;
for (const f of targets) {
  const cur = readFileSync(f, 'utf8');
  if (cur === src) continue;
  if (check) {
    console.error(`[sync-plugin-api] 漂移: ${f}(与 plugin-api/tangu-agent.d.ts 不一致,跑 npm run sync:plugin-api)`);
    drifted++;
  } else {
    writeFileSync(f, src);
    console.log(`[sync-plugin-api] 已同步: ${f}`);
  }
}
if (check && drifted) process.exit(1);
console.log(`[sync-plugin-api] ${check ? '一致' : '完成'}(${targets.length} 份拷贝)`);
