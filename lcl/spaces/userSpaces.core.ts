/** 用户自定义 Space 的纯逻辑层:space.json 解析/校验 + slug 工具。
 *  无任何引擎/React 依赖,vitest 直测。宿主注入 isViewRegistered/appVersion/reservedIds。
 *  schema 见 docs(L0 数据 Space):Space=纯数据布局配方;requires/minAppVersion 是 L1(Space App)的前向接缝。 */

export interface SpacePanelSpec {
  type: string
  params?: Record<string, unknown>
}

export interface SpaceSpec {
  id: string
  name: string | { zh?: string; en?: string }
  icon?: string
  /** 配方版本(插件/市场包升级时递增)。宿主据此判断「这份配方换过了」→ 丢弃该 Space 的
   *  已保存布局,让新配方真正落地;否则 setActiveSpace 恒走 applyNamed(保存布局优先),
   *  改了 layout 的新版对**用过该 Space 的用户永远不生效**。 */
  version?: string
  minAppVersion?: string
  layout: { main: SpacePanelSpec[]; left: SpacePanelSpec[]; right: SpacePanelSpec[] }
  requires?: { views?: string[]; plugin?: string | null }
}

export interface ParseOpts {
  isViewRegistered(type: string): boolean
  /** 当前应用版本;null = 未知(跳过 minAppVersion 检查)。 */
  appVersion: string | null
  reservedIds: readonly string[]
}

export type ParseResult = { ok: true; spec: SpaceSpec } | { ok: false; error: string }

const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** 语义化版本比较(数值逐段,缺段=0;非数字段按 0):a<b → -1, a==b → 0, a>b → 1。 */
export function cmpVersion(a: string, b: string): number {
  const pa = a.replace(/^v/i, '').split('.')
  const pb = b.replace(/^v/i, '').split('.')
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = parseInt(pa[i] ?? '0', 10) || 0
    const y = parseInt(pb[i] ?? '0', 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function panelList(v: unknown, field: string): SpacePanelSpec[] | string {
  if (v === undefined) return []
  if (!Array.isArray(v)) return `layout.${field} 必须是数组`
  const out: SpacePanelSpec[] = []
  for (const it of v) {
    if (!it || typeof it !== 'object' || typeof (it as { type?: unknown }).type !== 'string' || !(it as { type: string }).type) {
      return `layout.${field} 的条目必须是 { type: string }`
    }
    const params = (it as { params?: unknown }).params
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      return `layout.${field} 的 params 必须是对象`
    }
    out.push(params ? { type: (it as { type: string }).type, params: params as Record<string, unknown> } : { type: (it as { type: string }).type })
  }
  return out
}

export function parseSpaceJson(raw: string, opts: ParseOpts): ParseResult {
  let data: unknown
  try { data = JSON.parse(raw) } catch { return { ok: false, error: 'space.json 不是合法 JSON' } }
  if (!data || typeof data !== 'object') return { ok: false, error: 'space.json 必须是对象' }
  const d = data as Record<string, unknown>

  const id = d.id
  if (typeof id !== 'string' || !SLUG_RE.test(id)) return { ok: false, error: 'id 必须是 kebab-case(a-z0-9-)' }
  if (opts.reservedIds.includes(id)) return { ok: false, error: `id "${id}" 是内置 Space 保留名` }

  const name = d.name
  const nameOk = (typeof name === 'string' && name.trim()) ||
    (!!name && typeof name === 'object' && !Array.isArray(name) &&
      (typeof (name as { zh?: unknown }).zh === 'string' || typeof (name as { en?: unknown }).en === 'string'))
  if (!nameOk) return { ok: false, error: 'name 必须是非空字符串或 {zh?,en?}' }

  if (d.icon !== undefined && typeof d.icon !== 'string') return { ok: false, error: 'icon 必须是字符串' }
  if (d.minAppVersion !== undefined && typeof d.minAppVersion !== 'string') return { ok: false, error: 'minAppVersion 必须是字符串' }
  if (typeof d.minAppVersion === 'string' && opts.appVersion && cmpVersion(opts.appVersion, d.minAppVersion) < 0) {
    return { ok: false, error: `需要应用版本 ≥ ${d.minAppVersion}(当前 ${opts.appVersion})` }
  }

  if (!d.layout || typeof d.layout !== 'object') return { ok: false, error: '缺少 layout' }
  const lay = d.layout as Record<string, unknown>
  const main = panelList(lay.main, 'main')
  const left = panelList(lay.left, 'left')
  const right = panelList(lay.right, 'right')
  for (const r of [main, left, right]) if (typeof r === 'string') return { ok: false, error: r }
  if (!(main as SpacePanelSpec[]).length) return { ok: false, error: 'layout.main 至少要有一个视图' }

  const req = d.requires as { views?: unknown } | undefined
  const reqViews = Array.isArray(req?.views) ? (req!.views as unknown[]).filter((v): v is string => typeof v === 'string') : []
  const allTypes = [...(main as SpacePanelSpec[]), ...(left as SpacePanelSpec[]), ...(right as SpacePanelSpec[])].map((p) => p.type).concat(reqViews)
  const missing = [...new Set(allTypes.filter((t) => !opts.isViewRegistered(t)))]
  if (missing.length) return { ok: false, error: `引用了未注册的视图: ${missing.join(', ')}(可能需要升级应用或安装对应 Space App)` }

  return {
    ok: true,
    spec: {
      id,
      name: name as SpaceSpec['name'],
      icon: typeof d.icon === 'string' ? d.icon : undefined,
      version: typeof d.version === 'string' ? d.version : undefined,
      minAppVersion: typeof d.minAppVersion === 'string' ? d.minAppVersion : undefined,
      layout: { main: main as SpacePanelSpec[], left: left as SpacePanelSpec[], right: right as SpacePanelSpec[] },
      requires: reqViews.length ? { views: reqViews } : undefined,
    },
  }
}

/** 名称 → kebab id(中文等非 ASCII 全部折叠;空 → 'space')。 */
export function slugifyId(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48)
  return SLUG_RE.test(s) ? s : 'space'
}

/** base 已被占用则追加 -2/-3…(占用集合含内置与已注册用户 Space)。 */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let i = 2; ; i++) if (!taken.has(`${base}-${i}`)) return `${base}-${i}`
}

/** 一个 panel 的 `__loc` 该进配方的哪个桶;`null` = 不进配方。
 *
 * 单独成纯函数是因为它原本是一句**会骗过类型检查的断言**:`params.__loc as 'main'|'left'|'right'`。
 * 引擎加了第四个 loc `'bottom'` 之后,断言仍然编译通过,但 `layout['bottom']` 是 undefined —— 调用方的
 * `layout[loc].push(...)` 当场抛(开着底部面板点「另存为 Space」必崩)。断言不会报错,实判才会。
 *
 * 底部**故意不进配方**:SpaceSpec.layout 只有 main/left/right 三桶,「底部的 per-Space 默认内容」是
 * 明确的未做项 —— 真要做得先扩配方格式并迁移已存的 space.json。
 */
export function recipeBucketOf(rawLoc: unknown): 'main' | 'left' | 'right' | null {
  if (rawLoc === 'bottom') return null
  return rawLoc === 'left' || rawLoc === 'right' ? rawLoc : 'main'
}
