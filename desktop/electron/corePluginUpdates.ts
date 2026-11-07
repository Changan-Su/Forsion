import { promises as fs } from 'node:fs'
export { createCorePluginUpdater } from '../shared/corePlugins'

/**
 * 装好 / 升级后第一次启动:播种内置包、拉起引擎之前先限时查一次 npm(2026-10-26)。安装包钉的是发版那一刻的版本,
 * 之后插件 / 引擎还在发 —— 不预取的话刚装好的人一打开就看到「重启并启用更新」。查到的新版落进暂存区 / engine 目录,
 * 这一次启动的播种与拉起就用上。
 * 超时就不等了:播种照常用安装包那份;没下完的那次接着在后台跑,下次启动生效(暂存区写入与播种互斥,见 withPendingLock)。
 * 同一版只预取一次:记号在查完或超时后才写,离线的人之后的启动不再多等,中途崩了的下次再试。
 */
export async function prefetchOnFirstBoot(o: {
  markerFile: string
  version: string
  timeoutMs: number
  check: () => Promise<unknown>
}): Promise<'skipped' | 'done' | 'timeout'> {
  if ((await fs.readFile(o.markerFile, 'utf8').catch(() => '')).trim() === o.version) return 'skipped'
  let timer: ReturnType<typeof setTimeout> | undefined
  const outcome = await Promise.race([
    o.check().then(() => 'done' as const, () => 'done' as const),
    new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), o.timeoutMs) }),
  ])
  clearTimeout(timer)
  await fs.writeFile(o.markerFile, o.version, 'utf8').catch(() => {})
  return outcome
}
