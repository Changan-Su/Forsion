#!/usr/bin/env node
/**
 * vite 依赖预构建缓存的归属检查:本检出两份配置解析出的 cacheDir,必须物理落在本检出里。
 *
 * 为什么:worktree 的 desktop/node_modules 是指向主检出的软链,缺省 cacheDir(node_modules/.vite)顺着软链
 * 落进主检出。配置哈希含 root,两边必然不同 → worktree 的 vite 一启动就把那份 deps 整份删掉重建,主检出里
 * 正开着的 dev 之后懒加载的依赖 504(Outdated Optimize Dep)或加载到第二份 React,只能重启。2026-10-05
 * 一天里两个会话各犯一次,所以改成配置的缺省行为(frontend/viteCacheDir.ts),这里是它的仪器。
 *
 * 只解析配置:不起服务、不跑预构建、不碰任何缓存目录,dev 开着也能跑。
 * 跑:npm run check:vitecache(主检出与 worktree 都该绿)。
 * 负对照:让 frontend/viteCacheDir.ts 恒返回 undefined,在软链检出里跑必红。
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
  const seen = new Map()
  let bad = 0
  for (const [name, inline] of Object.entries(cases)) {
    const { cacheDir } = await resolveConfig({ ...inline, logLevel: 'silent' }, 'serve')
    const real = realpathLoose(cacheDir)
    const own = real.startsWith(home)
    if (!own) bad++
    console.log(`${own ? '✓' : '✗'} ${name}: ${real}${own ? '' : '  ← 落在别的检出里'}`)
    // 两份配置的哈希不同(electron-vite 多两只内置插件),共用一个目录 = 同一检出里 dev 与台架互删。
    // 真目录检出(主检出)刻意保持 vite 缺省、确实共用,所以只提示不判红。
    if (seen.has(real)) console.log(`  ⚠ 与「${seen.get(real)}」共用:这个检出里别同时开 dev 和台架 vite(或给其中一个设 FORSION_VITE_CACHE_DIR)`)
    seen.set(real, name)
  }
  if (bad) {
    console.error(`\n✗ ${bad} 份配置的缓存落在别的检出里 —— 在这里起 vite 会删掉对方的 deps`)
    process.exit(1)
  }
  console.log('\n✓ 缓存都在本检出里')
})().catch((e) => {
  console.error(e)
  process.exit(1)
})
