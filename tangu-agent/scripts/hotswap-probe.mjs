#!/usr/bin/env node
// 拿本机真实的引擎插件过一遍热升级判定(loader cannotHotSwap),改判定规则后看有没有误伤。
// 10-02 第一次跑就揪出两处误报:stickers 工具描述里的「import (」、beacon-engine 只拿内置的当场 createRequire。
// 用法: npm run build && node scripts/hotswap-probe.mjs [tangu-plugin.json …]
//   不给参数 = 扫 ~/.tangu/plugins、本仓 plugins/、~/.forsion(-dev)/plugins/*/tangu-plugins 下的全部引擎插件。
// 输出每个插件 hot-swap / NEEDS-RESTART;需重启的要能说出真实原因(CommonJS 读包内文件等),说不出就是误报。
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const { cannotHotSwap } = await import(pathToFileURL(path.join(root, 'dist', 'plugins', 'loader.js')).href);

const subdirs = (d) => { try { return readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
const home = os.homedir();
const manifests = process.argv.length > 2 ? process.argv.slice(2) : [
  ...subdirs(path.join(home, '.tangu', 'plugins')),
  ...subdirs(path.join(root, 'plugins')),
  ...['.forsion', '.forsion-dev'].flatMap((h) => subdirs(path.join(home, h, 'plugins')).flatMap((b) => subdirs(path.join(b, 'tangu-plugins')))),
].map((d) => path.join(d, 'tangu-plugin.json')).filter((f) => existsSync(f));

for (const m of manifests) {
  const dir = path.dirname(m);
  const entry = path.join(dir, JSON.parse(readFileSync(m, 'utf8')).entry || 'dist/index.js');
  const label = dir.replace(home, '~');
  if (!existsSync(entry)) { console.log(`no entry       ${label}`); continue; }
  console.log(`${cannotHotSwap({ dir, entryUrl: pathToFileURL(entry).href }) ? 'NEEDS-RESTART' : 'hot-swap     '}  ${label}`);
}
