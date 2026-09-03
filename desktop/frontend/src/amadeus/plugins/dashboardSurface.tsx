/**
 * 插件仪表盘挂载(2026-09-02):在插件自己的 DOM 容器里渲染**真** DashboardGridView,
 * **不依赖笔记库**。
 *
 * 为什么存在:Dashboard 在 Forsion 里的定义是「库里的一份 .dashboard.md 笔记」,于是走文件路线的
 * 插件总览(写库→开 tab)把「必须有打开的库」这个前提原封继承了 —— 服务器总览凭什么要看用户
 * 有没有笔记库(用户 2026-09-02 实报「这太奇怪了」)。这里把「渲染」与「住在库里」解耦:
 *  · 配方 → 编译成页字节(与真文件逐字节同构)→ 喂进一个**内存作用域**的 pageStore
 *    (pageStoreFor(scope, { sink })):不 loadPage、不 savePage,库开没开与它无关;
 *  · 真 DashboardGridView 挂进插件容器(mountHostReact,复用块表面那套双 root 防线);
 *  · 用户在排版台手排 → 视图照常 setFmExtra → 防抖 save → **sink** 把编译后的整页文本交给
 *    插件的 onLayout,插件自己持久化(ctx.saveData);下次挂载把它作 layoutText 传回,
 *    compileDashboardRecipe 的「再生成保布局」按卡 id 合并 —— 手排存活,数据刷新。
 *
 * 三条纪律:
 *  ① 虚拟路径带 `plugin:` 前缀(库内相对路径不可能以它开头)—— 外部回灌按 activePage 匹配,
 *     永远匹配不上真文件;pageStoreFor 会镜像库级字段进来,但本模块**绝不写 vaultRoot**。
 *  ② activePage 先于挂载种好 = GridView 的 `activePage !== dashPath → loadPage` 分支永不触发。
 *  ③ dispose 顺序:先卸 React 树,再 disposePageStoreScope(内部先 flushSave → sink 最后一发)。
 */
import { useState } from 'react'
import type { ViewProps } from '@lcl/engine'
import { DashboardGridView } from '../../views/DashboardGridView'
import { PageScopeCtx, disposePageStoreScope, pageStoreFor } from '../store/pageStore'
import { mountHostReact } from './blockSurface'
import { compileDashboardRecipe, type DashboardRecipe } from '@amadeus-shared/dashboardRecipe'
import { compile } from '@amadeus-shared/compiler/compile'
import { parseBody } from '@amadeus-shared/compiler/markers'
import { parseLayout } from '@amadeus-shared/compiler/manifest'
import { extractFrontmatterExtra, parseFrontmatter, stripFrontmatter } from '@amadeus-shared/compiler/split'
import { COMPILER_VERSION, PAGE_SCHEMA, type PageManifest } from '@amadeus-shared/compiler/types'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'plugindash.recipeInvalid': { zh: '仪表盘配方无效:{err}', en: 'Invalid dashboard recipe: {err}' },
})

export interface PluginDashboardOptions {
  recipe: DashboardRecipe
  /** 上次 onLayout 交出的整页文本(插件自己存的);传回来即「再生成保布局」。 */
  layoutText?: string | null
  /** 用户手排后(防抖 ~400ms)收到编译后的整页文本;插件负责持久化。 */
  onLayout?: (text: string) => void
  /** 缺省锁定(成品页);false = 直接进排版台。 */
  locked?: boolean
}

/** 页字节 → pageStore 状态(与 harness/dashrecipe 同一套真解码器,别再各写各的)。 */
export function pageStateFromText(text: string, title: string): {
  manifest: PageManifest
  blocks: Record<string, { id: string; type: string; content: string }>
} {
  const fm = parseFrontmatter(text)
  const parsed = parseBody(stripFrontmatter(text))
  const ids: string[] = []
  const blocks: Record<string, { id: string; type: string; content: string }> = {}
  for (const b of parsed) {
    if (!b.id) continue
    ids.push(b.id)
    blocks[b.id] = { id: b.id, type: 'markdown', content: b.content }
  }
  const now = new Date().toISOString()
  const manifest: PageManifest = {
    schema: PAGE_SCHEMA,
    id: fm.amadeus_page || 'plugin-dashboard',
    title,
    createdAt: now,
    updatedAt: now,
    compiler: { version: COMPILER_VERSION },
    root: parseLayout(fm.amadeus_layout),
    blocks: Object.fromEntries(ids.map((id) => [id, { type: 'markdown' }])),
    fmExtra: extractFrontmatterExtra(text),
  }
  return { manifest, blocks }
}

function Surface({ scope, dashPath, locked }: { scope: string; dashPath: string; locked: boolean }) {
  const [params, setParams] = useState<Record<string, unknown>>({ dashPath, locked })
  // ⚠️ leaf.id 必须 = 内存作用域名:GridView 内部按 leaf.id 再套一层 PageScopeCtx.Provider
  //    (DashboardGridView.tsx:174),给别的 id 就会解析到一份**空**store → 恒显示「从模板开始」。
  const leaf = {
    id: scope,
    type: 'dashboard',
    loc: 'main' as const,
    params,
    setTitle: () => {},
    setParams: (p: Record<string, unknown>) => setParams(p),
    close: () => {},
  }
  // 与真 Dashboard tab 同一棵 CSS 祖先(token 在 :root,类名只为 .am-app 作用域的组件样式)
  return (
    <div className="amadeus-root am-app tangu-lovable" style={{ height: '100%' }}>
      <DashboardGridView {...({ leaf, params } as unknown as ViewProps)} />
    </div>
  )
}

let seq = 0

/** 挂载;返回卸载函数。配方无效时容器里给可读提示(不抛)。 */
export function mountPluginDashboard(pluginId: string, el: HTMLElement, o: PluginDashboardOptions): { dispose: () => void; scope: string } {
  const compiled = compileDashboardRecipe(o.recipe, {
    existingFileText: o.layoutText || undefined,
    pageId: `plugin-dash-${pluginId}`,
  })
  if (!compiled.ok) {
    el.textContent = translate('plugindash.recipeInvalid', { err: compiled.error })
    return { dispose: () => { el.replaceChildren() }, scope: '' }
  }
  const scope = `plugin:${pluginId}:dashboard:${++seq}`
  const dashPath = `plugin:${pluginId}/overview.dashboard.md`
  const store = pageStoreFor(scope, {
    sink: (_path, manifest, contents) => { o.onLayout?.(compile(manifest, contents)) },
  })
  const { manifest, blocks } = pageStateFromText(compiled.text, pluginId)
  store.setState({ activePage: dashPath, pendingPage: null, manifest, blocks, status: 'ready', error: null })
  // 宿主 PluginViewHost 的容器是 overflow:auto,而 .dash3-host 自己就是滚动容器 → 双滚动条(接缝评审 P4)
  el.style.height = '100%'
  el.style.overflow = 'hidden'
  const disposeRoot = mountHostReact(
    el,
    <PageScopeCtx.Provider value={scope}>
      <Surface scope={scope} dashPath={dashPath} locked={o.locked !== false} />
    </PageScopeCtx.Provider>,
  )
  let disposed = false
  return {
    scope,
    dispose: () => {
      if (disposed) return
      disposed = true
      disposeRoot()
      disposePageStoreScope(scope) // 先收树再摘店:内部 flushSave → sink 最后一发
    },
  }
}
