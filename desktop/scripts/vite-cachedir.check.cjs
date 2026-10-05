#!/usr/bin/env node
/**
 * vite 依赖预构建缓存的归属检查:两份配置(`vite frontend` 台架 / electron-vite dev 的渲染层)解析出的
 * cacheDir 必须在本检出里、不在 node_modules 里、且互不相同。
 *
 * 为什么:worktree 的 desktop/node_modules 是指向主检出的软链,vite 缺省的 cacheDir(node_modules/.vite)
 * 等于所有检出共用。配置哈希含 root(台架与 dev 之间还差两只插件),必然不同 → 后起的 vite 把那份 deps 整份
 * 删掉重建,正开着的 dev 之后懒加载的依赖 504(Outdated Optimize Dep)或加载到第二份 React,只能重启。
 * 2026-10-05 一天里两个会话各犯一次,所以两份配置都改成固定用本检出的 desktop/.vite-cache/<名字>。
 * node_modules 里的那份缓存谁都不再用:基点更早、配置还是旧的 worktree 仍会去删它,但碰不到这里了。
 *
 * 只解析配置:不起服务、不跑预构建、不碰任何缓存目录,dev 开着也能跑。
 * 跑:npm run check:vitecache(主检出与 worktree 都该绿)。
 * 负对照:删掉任一份配置里的 cacheDir 一行,必红。
 */
const fs = require('fs')
const path = require('path')

const DESKTOP = path.resolve(__dirname, '..')
process.chdir(DESKTOP) // electron.vite.config.ts 按 cwd 解析路径
delete process.env.FORSION_VITE_CACHE_DIR // 查的是缺省行为;显式指定的目录由指定的人负责

/** 缓存目录可能还没建:取最近一个已存在祖先的真实路径,再把剩下的段接回去。 */
function realpathLoose(p) {
  let rest = ''
  while (!fs.existsSync(p)) {
    rest = path.join(path.basename(p), rest)
    p = path.dirname(p)
  }
  return path.join(fs.realpathSync(p), rest)
}

;(async () => {
  const { resolveConfig } = await import('vite')
  const electronVite = await import('electron-vite')
  // electron-vite dev 就是把这份 renderer 配置原样交给 vite 的 createServer。
  const renderer = (await electronVite.resolveConfig({}, 'serve')).config.renderer
  const cases = {
    'vite frontend(台架)': { root: 'frontend', configFile: 'frontend/vite.config.ts' },
    'electron-vite dev(渲染层)': { ...renderer, configFile: false },
  }
  const home = fs.realpathSync(DESKTOP) + path.sep
  const modules = realpathLoose(path.join(DESKTOP, 'node_modules')) + path.sep
  const seen = new Map()
  let bad = 0
  for (const [name, inline] of Object.entries(cases)) {
    const { cacheDir } = await resolveConfig({ ...inline, logLevel: 'silent' }, 'serve')
    const real = realpathLoose(cacheDir) + path.sep
    const why = []
    if (!real.startsWith(home)) why.push('不在本检出里')
    if (real.startsWith(modules)) why.push('在 node_modules 里(软链检出共用这一份)')
    if (seen.has(real)) why.push(`与「${seen.get(real)}」共用(两份配置哈希不同,会互删)`)
    seen.set(real, name)
    if (why.length) bad++
    console.log(`${why.length ? '✗' : '✓'} ${name}: ${real}${why.length ? `  ← ${why.join(';')}` : ''}`)
  }
  if (bad) {
    console.error(`\n✗ ${bad} 份配置的缓存归属不对 —— 在这里起 vite 会删掉别人的 deps`)
    process.exit(1)
  }
  console.log('\n✓ 两份配置的缓存都在本检出里,互不共用')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
