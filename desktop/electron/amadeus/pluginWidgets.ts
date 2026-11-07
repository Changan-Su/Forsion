/**
 * 插件主页小组件的读取(manifest `widgets`,2026-11-07+):每个目录一份 `manifest.json`,和 Agent 做的小组件同一种目录。
 * 桌面外置插件与开发态来源共用;Unit 的 /__unit/plugins 走同一个 readExternalPlugins,一并带上。
 * 读不到 / 不合格的那张丢掉,别的照常 —— 一张卡坏了不连累插件装载。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { pluginWidgetDirs, sanitizePluginWidget, type PluginWidgetSpec } from '@amadeus-shared/ipc'

const MANIFEST_BYTES = 16384

export async function readPluginWidgets(pdir: string, raw: unknown): Promise<PluginWidgetSpec[] | undefined> {
  const dirs = pluginWidgetDirs(raw)
  if (!dirs.length) return undefined
  const root = await fs.realpath(pdir).catch(() => path.resolve(pdir))
  const out: PluginWidgetSpec[] = []
  for (const rel of dirs) {
    // 只读插件根里面的普通文件:软链指到外面的不读,超过上限的不读
    const real = await fs.realpath(path.join(root, rel, 'manifest.json')).catch(() => null)
    if (!real || !real.startsWith(root + path.sep)) continue
    const st = await fs.stat(real).catch(() => null)
    if (!st?.isFile() || st.size > MANIFEST_BYTES) continue
    let parsed: unknown = null
    try { parsed = JSON.parse(await fs.readFile(real, 'utf8')) } catch { continue }
    const spec = sanitizePluginWidget(parsed)
    if (spec && !out.some((w) => w.id === spec.id)) out.push(spec)
  }
  return out.length ? out : undefined
}
