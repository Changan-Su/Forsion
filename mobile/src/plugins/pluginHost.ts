/**
 * Android App 的 Forsion 插件宿主(2026-10-02):应用级插件目录,**不在任何笔记库里**(云端库 / 本地库两种模式同一份)。
 *
 *   <Data>/plugins/<slug>/{manifest.json, main.js, README.md, CHANGELOG.md, icon.png}   ← 市场装进来(mobileMarket.ts)
 *   <Data>/plugins-data/<id>.json + <id>.json.alt                                        ← ctx.loadData / ctx.saveData
 *
 * 契约 = 桌面主进程 electron/amadeus/ipc.ts 的 listPlugins / uninstallPlugin / readPluginData / writePluginData:
 * 同一套 id 规则(effectivePluginId)、同一个门禁(gatePluginManifest)、同一份 manifest 映射(installedPluginFields)、
 * 同口径的图标校验(isValidPluginIconPng)。差异只有三处,都是「手机上做不到」:
 *   · manifest `isDesktopOnly: true` → 列出为 blocked:'desktopOnly',代码不读不发;
 *   · 不清点 bundle(内嵌引擎插件 / Agent / 技能 / Space 在手机上没有消费者;报了 bundle,市场装完会去叫云端引擎重扫);
 *   · 没有可见插件目录 → hostCaps.pluginsFolder=false(设置页不渲染「打开文件夹 / 创建示例」两个死键)。
 *
 * 本模块不 import Capacitor(经 PluginFs 接缝),单测见 mobile/scripts/plugin-host.test.cjs。
 */
import { gatePluginManifest, type ExternalPluginSource } from '../../../desktop/shared/amadeus/ipc'
import { installedPluginFields, type InstalledPluginManifest } from '../../../desktop/shared/amadeus/pluginSource'
import { effectivePluginId } from '../../../desktop/shared/products'
import { isSafeSlug, safeEntryPath } from '../../../desktop/shared/marketPackage'
import { PLUGIN_ICON_MAX_BYTES, isValidPluginIconPng } from '../../../desktop/shared/pluginIcon'
import { bytesToBase64, readText, readTextOr, writeText, type PluginFs } from './pluginFs'

export const PLUGINS_DIR = 'plugins'
export const PLUGIN_DATA_DIR = 'plugins-data'
const DOC_CAP = 65536

export interface MobilePluginHost {
  listPlugins(): Promise<ExternalPluginSource[]>
  uninstallPlugin(id: string): Promise<void>
  readPluginData(pluginId: string): Promise<string | null>
  writePluginData(pluginId: string, text: string): Promise<void>
}

/** 读 manifest.json(必须是 JSON 对象);读不到 / 坏 → null。 */
export async function readManifest(fs: PluginFs, dir: string): Promise<InstalledPluginManifest | null> {
  try {
    const m: unknown = JSON.parse(await readText(fs, `${dir}/manifest.json`))
    return m && typeof m === 'object' && !Array.isArray(m) ? (m as InstalledPluginManifest) : null
  } catch {
    return null
  }
}

/** 插件目录下的子目录名(跳过点目录;根不存在 = 一个都没装)。按名排序:同 id 两份时先到先得要确定。 */
export async function pluginDirNames(fs: PluginFs): Promise<string[]> {
  try {
    return (await fs.list(PLUGINS_DIR))
      .filter((e) => e.type === 'directory' && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort()
  } catch {
    return []
  }
}

/** manifest 里的 main(缺省 main.js)→ 包内安全相对路径;越界 / 绝对路径 → null(当作读不到 main)。 */
function mainRelOf(main: unknown): string | null {
  if (main === undefined || main === null || main === '') return 'main.js'
  return typeof main === 'string' ? safeEntryPath(main, '') : null
}

async function readIcon(fs: PluginFs, dir: string): Promise<string | undefined> {
  try {
    const st = await fs.stat(`${dir}/icon.png`)
    if (!st || st.type !== 'file' || st.size > PLUGIN_ICON_MAX_BYTES) return undefined // 先看大小,超重的不读进内存
    const bytes = await fs.readBytes(`${dir}/icon.png`)
    return isValidPluginIconPng(bytes) ? `data:image/png;base64,${bytesToBase64(bytes)}` : undefined
  } catch {
    return undefined
  }
}

// ── 插件私有数据:双槽 + 序号信封 ──────────────────────────────────────────────────────────
// 桌面是「写临时文件 → rename 覆盖」;Android 的 Filesystem.rename 不覆盖已存在的目标(且 move 的实现可能是
// 复制 + 删除),沿用那一套要么写不进去、要么在「删旧 → 改名」之间被杀留下一个都没有的窗口。这里换成:
//   · 两个槽 <id>.json / <id>.json.alt,每次写**较旧(或坏)的那一槽**,最新的有效槽永远不碰;
//   · 槽内容是信封 {"forsionPluginData":1,"seq":N,"text":"…"} —— JSON 对象的任何真前缀都不是合法 JSON,
//     写到一半被杀 = 那一槽解析失败,读取方自动落到另一槽(上一次成功写入的版本);
//   · 读 = 两槽里 seq 最大的有效信封;两槽都无效 = 从没写过(null),与桌面「没写过 = null」同一出口。
// 不需要 rename、不依赖覆盖语义,也不存在「两份都不在」的瞬间。
interface DataEnvelope { forsionPluginData: 1; seq: number; text: string }
const slotPaths = (id: string): [string, string] => [`${PLUGIN_DATA_DIR}/${id}.json`, `${PLUGIN_DATA_DIR}/${id}.json.alt`]

async function readSlot(fs: PluginFs, path: string): Promise<DataEnvelope | null> {
  const raw = await readTextOr(fs, path)
  if (raw === undefined) return null
  try {
    const v = JSON.parse(raw) as Partial<DataEnvelope> | null
    if (v && v.forsionPluginData === 1 && Number.isSafeInteger(v.seq) && typeof v.text === 'string') return v as DataEnvelope
  } catch { /* 写到一半的槽:当它不存在 */ }
  return null
}

/** 当前最新的有效槽:{ slot 下标, 信封 };两槽都无效 → null。 */
async function latestSlot(fs: PluginFs, id: string): Promise<{ slot: 0 | 1; env: DataEnvelope } | null> {
  const [a, b] = slotPaths(id)
  const [ea, eb] = await Promise.all([readSlot(fs, a), readSlot(fs, b)])
  if (ea && (!eb || ea.seq >= eb.seq)) return { slot: 0, env: ea }
  if (eb) return { slot: 1, env: eb }
  return null
}

export function createPluginHost(fs: PluginFs, opts: { appVersion: () => string | null }): MobilePluginHost {
  // 同一个插件的写串行化:两次 saveData 交错时,都读到同一个「最新槽」再各写各的,后写的会盖掉先写的那槽里更新的数据。
  const chains = new Map<string, Promise<unknown>>()
  const serial = <T>(id: string, job: () => Promise<T>): Promise<T> => {
    const run = (chains.get(id) ?? Promise.resolve()).then(job, job)
    const tail = run.catch(() => {})
    chains.set(id, tail)
    void tail.then(() => { if (chains.get(id) === tail) chains.delete(id) })
    return run
  }

  return {
    async listPlugins() {
      const out: ExternalPluginSource[] = []
      const seen = new Set<string>()
      for (const name of await pluginDirNames(fs)) {
        const dir = `${PLUGINS_DIR}/${name}`
        try {
          const m = await readManifest(fs, dir)
          if (!m) continue // manifest 缺 / 坏 = 不是插件(或装到一半:manifest 最后落盘)
          const id = effectivePluginId(name, m.id)
          if (!id) {
            console.warn(`[plugins] 插件目录 "${name}" 的 manifest id 与目录名均非法(须 kebab-case),拒载`)
            continue
          }
          if (seen.has(id)) continue
          // 门禁:apiVersion / minAppVersion 与桌面同一个函数;再加手机独有的一档 —— 声明了只能在桌面跑。
          const blocked = gatePluginManifest(m, opts.appVersion()) ?? (m.isDesktopOnly === true ? 'desktopOnly' : null)
          let code = ''
          if (!blocked) {
            const rel = mainRelOf(m.main)
            if (!rel) continue
            code = await readText(fs, `${dir}/${rel}`) // 读不到 main = 整个跳过(桌面同口径:坏插件不伪装成已启用的空壳)
          }
          const [readme, changelog, iconUrl] = await Promise.all([
            readTextOr(fs, `${dir}/README.md`).then((s) => s?.slice(0, DOC_CAP)),
            readTextOr(fs, `${dir}/CHANGELOG.md`).then((s) => s?.slice(0, DOC_CAP)),
            readIcon(fs, dir),
          ])
          seen.add(id)
          out.push({ id, ...installedPluginFields(m, name), iconUrl, code, readme, changelog, blocked: blocked ?? undefined })
        } catch {
          /* skip malformed plugin */
        }
      }
      return out
    },

    // 按**生效 id** 定位目录(市场的 installSlug 可以 ≠ manifest id,与桌面 uninstallPlugin 同一条扫描规则)。
    // 插件私有数据(plugins-data)刻意保留:与桌面一致,重装后设置还在。原因码由渲染层 ipcErrorText 译。
    async uninstallPlugin(id) {
      if (!isSafeSlug(id)) throw new Error('invalid-plugin-id')
      for (const name of await pluginDirNames(fs)) {
        const m = await readManifest(fs, `${PLUGINS_DIR}/${name}`)
        if (effectivePluginId(name, m?.id) === id) {
          await fs.removeDir(`${PLUGINS_DIR}/${name}`)
          return
        }
      }
      throw new Error('plugin-not-found')
    },

    async readPluginData(pluginId) {
      if (!isSafeSlug(pluginId)) return null // id 直接拼进文件名:`../` 就是任意读
      return serial(pluginId, async () => (await latestSlot(fs, pluginId))?.env.text ?? null)
    },

    async writePluginData(pluginId, text) {
      if (!isSafeSlug(pluginId)) throw new Error('invalid-plugin-id')
      const body = String(text ?? '')
      await serial(pluginId, async () => {
        const cur = await latestSlot(fs, pluginId)
        const target = cur ? (cur.slot === 0 ? 1 : 0) : 0
        const env: DataEnvelope = { forsionPluginData: 1, seq: (cur?.env.seq ?? 0) + 1, text: body }
        await writeText(fs, slotPaths(pluginId)[target], JSON.stringify(env))
      })
    },
  }
}
