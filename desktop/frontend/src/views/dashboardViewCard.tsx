/**
 * 视图卡片(view widget)—— 把**任意已注册视图**活化成 Dashboard 里的一张卡片。
 * 原住 AmadeusDashboardView.tsx(旧 24 列网格版);2026-08-25 旧版整体移除后独立成文件,
 * 现由画布版 DashboardCanvasView 使用。**嵌入白名单(embeddable)在调用方复查**,不在这里。
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { Leaf } from '@lcl/engine'
import { getView, subscribeViews } from '@lcl/engine'
import { useScopedPageStore } from '@amadeus/store/pageStore'
import { widgetSource } from '@amadeus-shared/dashboard'

/** 视图卡片:把**任意已注册视图**(日历 / 待办 / 收件箱 / 活动日志 / 插件视图……)活化在格子里。
 *  卡片源码 = ```view 围栏,`type:` 记注册键,其余键即该视图的 params。
 *
 *  做法是合成一个 Leaf 句柄喂给视图工厂 —— 视图不知道自己在仪表盘里,照常按 leaf.id 建作用域、
 *  按 leaf.params 重建状态。三条刻意的取舍:
 *  · leaf.id 不在 mainTabs 里:视图里那些「我是不是当前活动 tab」的判定一律得 false。这是对的 ——
 *    卡片不是 tab,不该去抢活动作用域(如 setActivePageScope)、也不该被当成导航目标。
 *  · setParams 写回卡片源码 → 随笔记落盘、重启还原;**只落标量**(源码是给人读的纯文本)。
 *  · 不认 singleton:那是「开 tab」的约束;一份仪表盘里放两张日历是合理需求。 */
export function ViewCard({ dashLeafId, dashPath, blockId, opts, onClose }: {
  dashLeafId: string
  dashPath: string
  blockId: string
  opts: Record<string, string>
  onClose: () => void
}) {
  const store = useScopedPageStore()
  const type = opts.type ?? ''
  const [, force] = useState(0)
  // 插件视图可能晚于本卡片注册(插件在运行期 registerView)→ 订阅注册表,否则永远停在「不可用」。
  useEffect(() => subscribeViews(() => force((n) => n + 1)), [])
  // onClose 每帧新身份 → 走 ref,免得 leaf 跟着换身份(视图里以 leaf 为依赖的 effect 会空转)。
  const closeRef = useRef(onClose)
  closeRef.current = onClose

  // parseWidget 每次都产新对象,同样不能直接当依赖 —— 用序列化值(opts 全是字符串,round-trip 安全)。
  const optsKey = JSON.stringify(opts)
  const params = useMemo(() => {
    const { type: _t, ...rest } = JSON.parse(optsKey) as Record<string, string>
    return rest as Record<string, unknown>
  }, [optsKey])

  const leaf = useMemo<Leaf>(() => ({
    id: `${dashLeafId}::${blockId}`,
    type,
    loc: 'main',
    params,
    setTitle: () => {}, // 卡片没有标题栏可写
    setParams: (p) => {
      const st = store.getState()
      if (st.activePage !== dashPath) return // 换页/已删 → 绝不写进别人的笔记
      const next: Record<string, string> = { type }
      for (const [k, v] of Object.entries(p)) {
        // ponytail: 只落标量。视图想存复杂状态自己找地方(它本来就有自己的 store)。
        if (k !== 'type' && (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')) next[k] = String(v)
      }
      const src = widgetSource('view', next)
      if ((st.blocks[blockId]?.content ?? '').trim() === src) return // 没变就不写(堵住写盘自激)
      st.setBlockContent(blockId, src)
    },
    close: () => closeRef.current(),
  }), [dashLeafId, dashPath, blockId, type, params, store])

  if (!type) return <div className="dash-widget"><div className="dash-widget-note">卡片源码里缺 `type:`(视图注册键)</div></div>
  const def = getView(type)
  if (!def) return <div className="dash-widget"><div className="dash-widget-note">视图「{type}」不可用 —— 可能来自未启用的插件</div></div>
  // 复用引擎的 .wb-view(满高 flex 列 + 自身滚动):视图在卡片里拿到的尺寸语义与在 tab 里一致。
  return <div className="wb-view dash-viewcard">{def.factory({ leaf, params })}</div>
}

// ───────────────── 嵌卡白名单与身份判定(网格版 / 画布版共用,勿各写一份) ─────────────────

/** 渲染层也拒的嵌入禁区(安全 / 全局语义炸弹)。添加菜单另按 `embeddable` 白名单收窄。
 *  ⚠️ 白名单必须在**渲染入口**复查,不能只做菜单过滤:卡片源码是 md 文本,同步/共享/手写都能
 *  往里塞任意注册键,那样 embeddable 就只是建议而不是安全边界(Codex 2026-08-25 评审)。 */
export const EMBED_DENY = new Set(['chat', 'browser', 'terminal', 'dashboard', 'amadeus-dashboard', 'sidebar-empty', 'home'])

/** 这张视图卡需不需要先挑一个文件?返回 `{param, accept}` = 需要,把选中的路径写进 `param`。
 *  判据来自 P0 的声明元数据,不另立表:`idParam` + `fileMatch` = 文件类实体视图。
 *  大纲是唯一例外 —— aux 类没有 idParam,但不给身份就恒空(方案 §6.4 C 类),故显式配。 */
export function pickSpecOf(
  v: { type: string; idParam?: string; fileMatch?: unknown },
  fileMatchViewType: (path: string) => string | null,
): { param: string; accept: (kind: string, path: string) => boolean } | null {
  if (v.type === 'outline') return { param: 'sourcePath', accept: (_k, path) => fileMatchViewType(path) === 'amadeus-editor' }
  if (!v.idParam || !v.fileMatch) return null
  return { param: v.idParam, accept: (_k, path) => fileMatchViewType(path) === v.type }
}

/** 一张视图卡在统一外壳上显示的标题:视图名 +(带身份时)文件名。
 *  外壳由 Dashboard 画、标题由 Dashboard 取 —— 视图自己不再画标题栏,这是「统一」的来源。 */
export function viewCardTitle(opts: Record<string, string>, displayName: string): string {
  const idish = Object.entries(opts).find(([k, v]) => k !== 'type' && /path$/i.test(k) && v)
  if (!idish) return displayName
  const base = (idish[1].split(/[\\/]/).pop() ?? idish[1]).replace(/\.[^.]+$/, '')
  return base ? `${displayName} · ${base}` : displayName
}
