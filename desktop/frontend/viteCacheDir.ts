import { lstatSync } from 'fs'
import { resolve } from 'path'

/**
 * vite 依赖预构建缓存目录(frontend/vite.config.ts 与 electron.vite.config.ts 的 renderer 共用这一处判断)。
 *
 * git worktree 的 desktop/node_modules 是指向主检出的软链,缺省 cacheDir(node_modules/.vite)顺着软链
 * 落进主检出、与那边正开着的 dev 共用。配置哈希含 root,两边必然不同 → 这边的 vite 一启动就把那份 deps
 * 整份删掉重建,dev 之后懒加载的依赖 504(Outdated Optimize Dep)或加载到第二份 React,只能重启。
 * 所以软链检出自动改用本检出自己的 desktop/.vite-worktree/<name>(已进 .gitignore)。
 *
 * `name` 把台架与 electron-vite dev 再分开:后者多两只内置插件,配置哈希同样不同,共用一个目录照样互删。
 * node_modules 是真目录(主检出、CI、自己装了依赖的 worktree)→ 返回 undefined,即 vite 缺省行为。
 * 显式的 FORSION_VITE_CACHE_DIR 永远优先。仪器:npm run check:vitecache。
 */
export function viteCacheDir(desktopDir: string, name: 'web' | 'renderer'): string | undefined {
  if (process.env.FORSION_VITE_CACHE_DIR) return process.env.FORSION_VITE_CACHE_DIR
  const linked = lstatSync(resolve(desktopDir, 'node_modules'), { throwIfNoEntry: false })?.isSymbolicLink()
  // 必须是绝对路径:相对的 cacheDir 由 vite 按 root(frontend/)解析,不是按 desktop/。
  return linked ? resolve(desktopDir, '.vite-worktree', name) : undefined
}
