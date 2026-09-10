/** 量化 extraResources 后端依赖的文件数/字节数,与 electron-builder 使用相同过滤器。
 * node scripts/backend-dependencies.check.cjs [node_modules 路径]
 * 数字来自当前目录;不能当作 Windows 实机安装耗时。
 */
const { readdirSync, lstatSync } = require('node:fs');
const { resolve, join } = require('node:path');
const { Minimatch } = require('minimatch');
const { createFilter } = require('app-builder-lib/out/util/filter.js');
const { backendDependencyFilter } = require('../build/backend-dependencies.cjs');
const lock = require('../../tangu-agent/package-lock.json');
const root = process.argv[2] ? resolve(process.argv[2]) : resolve(__dirname, '../../tangu-agent/node_modules');
const filter = createFilter(root, backendDependencyFilter(lock).map((pattern) => new Minimatch(pattern, { dot: true })));
const before = { files: 0, bytes: 0 };
const after = { files: 0, bytes: 0 };
function walk(dir, included = true) {
  for (const entry of readdirSync(dir)) {
    const file = join(dir, entry);
    const stat = lstatSync(file);
    const keep = included && filter(file, stat);
    if (stat.isDirectory()) walk(file, keep);
    else {
      before.files++; before.bytes += stat.size;
      if (keep) { after.files++; after.bytes += stat.size; }
    }
  }
}
walk(root);
console.log(JSON.stringify({ root, before, after, removed: {
  files: before.files - after.files,
  MiB: Math.round((before.bytes - after.bytes) / 1024 ** 2 * 100) / 100,
} }, null, 2));
