/** extraResources 不会像 app.asar 那样筛 production 依赖。
 * 使用 npm lock 的 dev 标志排除整个开发专用依赖闭包;共有依赖/可选原生依赖保留。
 * 不改开发机 node_modules,也不在打包阶段重新解析或下载依赖。
 */
function backendDependencyFilter(lock) {
  if (!lock.packages || lock.lockfileVersion < 2) {
    throw new Error('Backend dependency packaging requires an npm v2/v3 lockfile');
  }
  const excluded = Object.entries(lock.packages)
    .filter(([name, info]) => name.startsWith('node_modules/') && info.dev === true)
    .map(([name]) => name.slice('node_modules/'.length));
  // 不允许过滤父目录时意外带走生产依赖(异常 lock 应中止构建)。
  for (const [name, info] of Object.entries(lock.packages)) {
    if (!name.startsWith('node_modules/') || info.dev === true) continue;
    const relative = name.slice('node_modules/'.length);
    if (excluded.some((dir) => relative.startsWith(`${dir}/`))) {
      throw new Error(`Production dependency would be excluded: ${name}`);
    }
  }
  return ['**/*', ...excluded.map((name) => `!${name}{,/**/*}`)];
}

module.exports = { backendDependencyFilter };
