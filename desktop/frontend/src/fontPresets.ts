/**
 * 字体预设注册表。**内置预设与插件字体同形** —— 都是这里的一条 FontPreset,设置界面的下拉不区分来源,
 * 只按 source 分组。加内置字体 = 往 BUILTIN 里加一条;插件带字体 = 调 registerFont(见 plugin ctx)。
 *
 * ⚠ 预设的值是**字体栈,不是单个字族**。这是「不用系统字体库」的要害:若 Inter 预设只解析成 `Inter`,
 *   每个汉字仍会回落到本机的 PingFang/雅黑,换台电脑就变样 —— 等于没改。所以每条栈都自带内置的
 *   中文字族兜底(Noto Sans SC),末位才是 ui-sans-serif 这类关键字。
 *
 * ⚠ 栈里点名的 family 必须与 build/gen-fonts.cjs 落盘的 @font-face 逐字一致,对不上会静默回落系统字体。
 */
import type { FontSlot } from './uiFont'

export type FontSource = 'builtin' | `plugin:${string}`

export type FontPreset = {
  /** 稳定 slug,存进 localStorage 的就是它。**永不改**(改了 = 老用户的选择静默失效)。 */
  id: string
  /** i18n key;没有就直接显示 label。插件字体一般只给 label。 */
  labelKey?: string
  label?: string
  /** 这条预设允许出现在哪几档。等宽字体不该出现在正文档里。 */
  slots: FontSlot[]
  /** 完整 font-family 栈。 */
  stack: string
  source: FontSource
}

/** 中文兜底:所有非等宽栈都以它收尾,保证汉字也走内置字体而不是本机的。 */
const CJK = `'Noto Sans SC'`

const BUILTIN: FontPreset[] = [
  {
    id: 'inter',
    labelKey: 'settings.theme.fontPreset.inter',
    slots: ['ui', 'body'],
    stack: `'Inter Variable', ${CJK}, ui-sans-serif, sans-serif`,
    source: 'builtin',
  },
  {
    id: 'noto-sans',
    labelKey: 'settings.theme.fontPreset.notoSans',
    slots: ['ui', 'body'],
    stack: `${CJK}, ui-sans-serif, sans-serif`,
    source: 'builtin',
  },
  {
    id: 'wenkai',
    labelKey: 'settings.theme.fontPreset.wenkai',
    slots: ['ui', 'body'],
    stack: `'LXGW WenKai', ${CJK}, ui-serif, serif`,
    source: 'builtin',
  },
  {
    id: 'jetbrains',
    labelKey: 'settings.theme.fontPreset.jetbrains',
    slots: ['mono'],
    stack: `'JetBrains Mono Variable', ${CJK}, ui-monospace, monospace`,
    source: 'builtin',
  },
  // 系统字体仍留一条明路:有人就是想要本机观感。但它不再是默认、也不再是唯一选项。
  {
    id: 'system',
    labelKey: 'settings.theme.fontPreset.system',
    slots: ['ui', 'body'],
    stack: 'system-ui, sans-serif',
    source: 'builtin',
  },
  {
    id: 'system-mono',
    labelKey: 'settings.theme.fontPreset.system',
    slots: ['mono'],
    stack: 'ui-monospace, monospace',
    source: 'builtin',
  },
]

/** 插件注册进来的字体。插件禁用/卸载 → dispose → 这里删掉 → 存了该 id 的档位自动回落「跟随主题」。 */
type Entry = { preset: FontPreset; faces: FontFace[]; disposed: boolean }
const dynamic = new Map<string, Entry>()

/** 注册表变了要让已注入的 <style> 重算 —— 否则:①外置插件是异步装的,启动时那趟 applyUiFonts 早就跑完了,
 *  持久化的插件字体重启后永远回不来;②插件禁用后 <style> 里那条插件栈还继续盖着主题。
 *  uiFont.ts 单向 import 本文件,所以回调只能这样反向送出去(不能在这里 import uiFont,会成环)。 */
const listeners = new Set<() => void>()
export function subscribeFonts(cb: () => void): () => void {
  listeners.add(cb)
  return () => listeners.delete(cb)
}
function notify(): void {
  for (const cb of Array.from(listeners)) {
    try { cb() } catch (e) { console.error('[fonts] listener failed', e) }
  }
}

/** 旧版自由输入留下的字面值 → 新预设 id。只认这几个最常见的,其余一律落「跟随主题」。 */
const LEGACY: Record<string, string> = {
  'system-ui': 'system',
  'ui-monospace': 'system-mono',
  Inter: 'inter',
  'Noto Sans SC': 'noto-sans',
  'Source Han Sans SC': 'noto-sans',
  'LXGW WenKai': 'wenkai',
  'JetBrains Mono': 'jetbrains',
}

export function migrateLegacyValue(raw: string): string {
  return LEGACY[raw.trim()] ?? ''
}

export function listFonts(slot: FontSlot): FontPreset[] {
  return [...BUILTIN, ...[...dynamic.values()].map((e) => e.preset)].filter((f) => f.slots.includes(slot))
}

/** 未知 id → undefined。调用方据此回落「跟随主题」(一条声明都不出)。 */
export function getFont(id: string): FontPreset | undefined {
  if (!id) return undefined
  return BUILTIN.find((f) => f.id === id) ?? dynamic.get(id)?.preset
}

export type PluginFontFile = { url: string; weight?: string; style?: string }

/** 预设 id → 能安全写进 CSS 的 family 名。
 *  ⚠ 不能直接拿 id 当 family:id 形如 `plugin:acme:serif`,而 sanitizeFont 会把冒号剥掉,
 *    于是 @font-face 的 family 与栈里写的名字永远对不上 —— 文件加载了也用不上(codex 评审 2026-08-28)。
 *  ⚠ 光把非字母数字折叠成 `-` 会**确定性撞车**:`plugin:a-b:c` 与 `plugin:a:b-c` 归一后同名,
 *    两个插件的 FontFace 会挤进同一个 family,选 A 可能显示 B 的字体(同评审第二轮)。
 *    所以可读 slug 后面必须再缀一段**原始 id** 的哈希来消歧。 */
export function pluginFontFamily(id: string): string {
  const slug = id.replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  // FNV-1a:纯 JS、确定性、无依赖。这里只用于消歧,不是安全哈希。
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `pf-${slug}-${h.toString(36)}`
}

/** 插件注册字体。返回 disposer —— 插件停用时必须调,否则字体与下拉项都留在原地。 */
export function registerFont(
  entry: Omit<FontPreset, 'source'> & { source: FontSource; files?: PluginFontFile[] },
): () => void {
  const { files, ...rest } = entry
  const preset = { ...rest } as FontPreset

  // 同 id 重复注册 = 原子替换:先把旧的整条收掉,否则旧 disposer 会反手删掉新的那条。
  dispose(preset.id)

  const faces: FontFace[] = []
  const self: Entry = { preset, faces, disposed: false }

  if (files?.length) {
    // 宿主自己起一个只含安全字符的 family,并**放到栈首** —— 插件只管给文件,不必猜宿主怎么命名。
    const family = pluginFontFamily(preset.id)
    preset.stack = `'${family}', ${preset.stack}`
    for (const f of files) {
      try {
        const face = new FontFace(family, `url(${JSON.stringify(f.url)})`, {
          weight: f.weight ?? '400',
          style: f.style ?? 'normal',
        })
        faces.push(face)
        void face.load().then((loaded) => {
          // 加载是异步的:期间可能已经 dispose 或被同 id 的新注册顶掉。
          // 不判这一下,disposer 先删一个还没 add 的 face,Promise 随后又把它永久加回去。
          if (self.disposed || dynamic.get(preset.id) !== self) return
          try { document.fonts.add(loaded) } catch { /* 无 document.fonts */ }
        }).catch(() => { /* 坏文件不该拖垮插件 */ })
      } catch { /* 非法 URL / 无 FontFace(老环境) */ }
    }
  }

  dynamic.set(preset.id, self)
  notify()
  return () => dispose(preset.id, self)
}

/** 收掉一条动态字体。传 owner 时只收自己那条(避免删掉后来者)。 */
function dispose(id: string, owner?: Entry): void {
  const entry = dynamic.get(id)
  if (!entry || (owner && entry !== owner)) return
  entry.disposed = true
  dynamic.delete(id)
  for (const face of entry.faces) {
    try { document.fonts.delete(face) } catch { /* 没加进去过 / 无 document.fonts */ }
  }
  notify()
}

/** 单测/热重载用。 */
export function _resetDynamicFonts(): void {
  for (const id of Array.from(dynamic.keys())) dispose(id)
  dynamic.clear()
}
