import { promises as fs } from 'node:fs'
import type { CorePluginUpdate, CorePluginUpdates } from '../shared/corePlugins'

/** One process-wide run for the tray, settings, startup and timer. Failures remain visible per package. */
export function createCorePluginUpdater(options: {
  items: CorePluginUpdate[]
  enabled: boolean
  run: (report: (item: CorePluginUpdate) => void) => Promise<unknown>
  broadcast: (status: CorePluginUpdates) => void
}) {
  let items = options.items.map((item) => ({ ...item, phase: options.enabled ? item.phase : 'development' as const }))
  let running: Promise<void> | undefined
  let checking = false
  let generation = 0 // reset() 加一:之前开跑的那一轮拍下的已装 / 暂存版本,播种之后就过时了
  const snapshot = (): CorePluginUpdates => ({ checking, items: items.map((item) => ({ ...item })) })
  const emit = (): void => options.broadcast(snapshot())
  const check = (): Promise<void> => {
    if (running) return running
    if (!options.enabled) { emit(); return Promise.resolve() }
    checking = true
    items = items.map((item) => ({ ...item, phase: 'checking', error: undefined }))
    emit()
    const gen = generation
    running = Promise.resolve().then(() => options.run((item) => {
      if (gen !== generation) return
      items = items.map((before) => before.id === item.id ? { ...before, ...item } : before)
      emit()
    })).then(() => undefined).catch((error: unknown) => {
      if (gen !== generation) return
      items = items.map((item) => item.phase === 'checking' || item.phase === 'downloading'
        ? { ...item, phase: 'error', error: error instanceof Error ? error.message : String(error) } : item)
    }).finally(() => {
      checking = false
      running = undefined
      emit()
      if (gen !== generation) void check() // 过时的那一轮结束了:按现在磁盘上的状态重查一遍
    })
    return running
  }
  /** 回到「尚未检查」:首次启动预取之后,刚播种的、下次拉起引擎就用上的那份不该再显示「重启并启用更新」;下一次检查重新填。
   *  预取超时后还在跑的那一轮,之后的回报一律不收,它跑完自动再查一遍。 */
  const reset = (): void => {
    generation++
    items = items.map((item) => ({ id: item.id, packageName: item.packageName, phase: options.enabled ? 'idle' : 'development' }))
    emit()
  }
  return { snapshot, check, reset }
}

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
