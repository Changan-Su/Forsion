/**
 * 公开分享页(/share/<token>)的只读 Amadeus 渲染面(P4,2026-09-07 用户拍板「Publish 分享的应该是只读版的
 * Amadeus 编辑器」):正文由**生产 UnifiedPage(readOnly)** 渲染 —— 文档/画布/分栏/卡片/嵌入(多维表·画板·
 * PDF·媒体·书签)/封面·图标·属性,与桌面同一套源码同一套 CSS;数据来自只读桥(amadeus/shareBridge)。
 * v3 标记文件走「打开即升」在内存升成 v4(只读不落盘);升级被拒(mindmap / dashboard 键)与未来 schema
 * 才退回 react-markdown(shareMarkdown)。
 *
 * ⚠️ 本模块的静态 import 图会拉到 amadeus/api.ts(模块级抓 window.amadeus)与 dbStore(模块级订阅事件)
 *    —— 只能由 sharePage 在装好 shareBridge **之后**动态 import。
 * ⚠️ 外壳必须是 `.am-app.tangu-lovable.amx-pane.amx-editor`:OverlayPortal 按 `.am-app` 找逃生舱,
 *    画布满铺给 `.amx-pane` 挂 `.amx-canvas-pane`,模式胶囊按 `closest('.amx-pane')` 找 `.amx-modeseg-slot`。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import '@/styles/base.css'
import '@/amadeus-host.css'
import '@/i18n.generated'
import { LocaleProvider, registerMessages, useI18n } from '@/i18n'
import { applyTheme } from '@/theme/loader'
import { resolveInitialBg, resolveInitialEffectiveMode, resolveInitialLang, resolveInitialSkin } from '@/theme/registry'
import { useTheme } from '@/stores/themeStore'
import { UnifiedPage } from '@amadeus/unified/UnifiedPage'
import { routeNote, type RouteDecision } from '@amadeus/unified/router'
import { SEG_SLOT } from '@amadeus/unified/CanvasModeSeg'
import { usePageStore } from '@amadeus/store/pageStore'
import { WikiHoverPreview } from '@amadeus/components/WikiHoverPreview'
import { amadeus } from '@amadeus/api'
import { resolvePageName } from '@amadeus-shared/links'
import { stripPageBasename } from '@amadeus-shared/compiler/names'
import { buildTree, mergeFdNotes, pathTo, subtreeAt, type TreeNode } from '@amadeus/lib/pageTree'
import { ShareMarkdown } from './shareMarkdown'
import type { ShareTree } from './amadeus/shareBridge'

registerMessages({
  'shareview.readOnly': { zh: '只读', en: 'Read-only' },
  'shareview.footer': { zh: '由 Forsion 云端笔记分享 · 只读', en: 'Shared from Forsion cloud notes · read-only' },
  'shareview.notFound': { zh: '页面不存在或不在分享范围内', en: 'This page does not exist or is outside the shared scope' },
  'shareview.loadFailed': { zh: '加载失败', en: 'Failed to load' },
  'shareview.loading': { zh: '加载中…', en: 'Loading…' },
})

export interface ShareMeta { mode: 'page' | 'subtree'; path: string; title: string }

export interface ShareViewerProps {
  token: string
  /** 公开分享 API 基址(…/public/shares/<token>)。 */
  base: string
  meta: ShareMeta
  tree: ShareTree
  /** 当前页变了 → 桥的资产/引用解析基准跟着换。 */
  onCurrentChange: (path: string) => void
}

const CSS = `
.shv { height: calc(100vh / var(--uiz, 1)); display: flex; background: var(--bg); color: var(--text); font: 15px/1.75 -apple-system, "PingFang SC", "Segoe UI", Roboto, sans-serif; }
.shv-side { width: 240px; flex-shrink: 0; border-right: 1px solid var(--border, rgba(127,127,127,.18)); padding: 20px 10px; overflow-y: auto; height: calc(100vh / var(--uiz, 1)); background: var(--sidebar-bg, transparent); }
.shv-side button { display: block; width: 100%; text-align: left; padding: 5px 10px; border: 0; background: none; border-radius: 8px; font: 13px/1.5 inherit; color: inherit; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.shv-side button:hover { background: var(--overlay-light, rgba(127,127,127,.1)); }
.shv-side button.on { background: var(--accent-soft, rgba(76,110,245,.12)); color: var(--accent, #4c6ef5); }
.shv-side .cr { display: inline-block; width: 14px; margin-right: 2px; font-size: 9px; opacity: .5; vertical-align: 1px; }
/* vh 一律除以 --uiz:lcl/engine/singleColumn.css 在触屏窄幅给 body 挂 zoom 1.15(并同步 :root --uiz),
   CSS zoom 不缩 vh → 100vh 渲染成 115% 视口(真机视口实见 971/844)。桌面浏览器分享页不跑 uiZoom,var 回退 1。 */
.shv-main { flex: 1; min-width: 0; height: calc(100vh / var(--uiz, 1)); }
.shv-pane { padding-bottom: 96px; }
.shv-toolbar { justify-content: flex-start; }
.shv-crumb { font-size: 12.5px; color: var(--text-muted); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0; }
.shv-spacer { flex: 1; }
.shv-ro { font-size: 11.5px; padding: 1px 8px; border-radius: 999px; background: var(--overlay-light, rgba(127,127,127,.12)); color: var(--text-muted); }
.shv-doc { max-width: 920px; margin: 0 auto; padding: 8px 48px 0; }
.shv-doc pre { background: rgba(127,127,127,.09); padding: 12px 14px; border-radius: 10px; overflow-x: auto; font-size: 13px; }
.shv-doc code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .92em; }
.shv-doc img { max-width: 100%; border-radius: 8px; }
.shv-doc blockquote { margin: 0; padding: 2px 16px; border-left: 3px solid rgba(127,127,127,.35); opacity: .9; }
.shv-doc table { border-collapse: collapse; display: block; overflow-x: auto; }
.shv-doc th, .shv-doc td { border: 1px solid rgba(127,127,127,.25); padding: 5px 10px; font-size: 14px; }
.shv-db { margin: 14px 0; border: 1px solid rgba(127,127,127,.2); border-radius: 10px; overflow: hidden; }
.shv-db-head { padding: 8px 12px; font-size: 13px; font-weight: 600; background: rgba(127,127,127,.06); border-bottom: 1px solid rgba(127,127,127,.15); }
.shv-db-scroll { overflow-x: auto; }
.shv-db-table { border-collapse: collapse; width: 100%; font-size: 13px; }
.shv-db-table th, .shv-db-table td { border: 1px solid rgba(127,127,127,.18); padding: 5px 10px; text-align: left; vertical-align: top; }
.shv-db-table th { font-weight: 600; background: rgba(127,127,127,.05); white-space: nowrap; }
.shv-db-chip { display: inline-block; padding: 0 8px; margin: 1px 3px 1px 0; border-radius: 999px; background: rgba(76,110,245,.16); color: #4c6ef5; font-size: 12px; }
.shv-db-check { font-size: 14px; }
.shv-db-foot { padding: 6px 12px; font-size: 12px; opacity: .6; }
.shv-db-err { padding: 10px 12px; font-size: 12.5px; opacity: .7; }
.shv-foot { max-width: 920px; margin: 64px auto 0; padding: 16px 48px 0; border-top: 1px solid var(--border, rgba(127,127,127,.15)); font-size: 12px; opacity: .55; }
.shv-center { margin: auto; text-align: center; padding: 48px; color: var(--text-muted); }
@media (max-width: 720px) {
  .shv { flex-direction: column; height: auto; min-height: calc(100vh / var(--uiz, 1)); }
  .shv-side { width: auto; height: auto; border-right: 0; border-bottom: 1px solid var(--border, rgba(127,127,127,.18)); }
  .shv-main { height: auto; }
  /* 竖排后 pane 不再有 100vh 的父高;画布满铺是绝对定位铺 pane 的 padding box,pane 高度 auto 就塌成
     只剩顶栏(真机视口实见 168px)—— 给下限。选择器要压过 amadeus-host.css 触屏断点里的
     .am-app.amx-pane.amx-editor { min-height: 0 }(0,3,0),故写成 (0,5,0);dvh 兜手机地址栏。 */
  .shv-main > .am-app.amx-pane.amx-editor.shv-pane { box-sizing: border-box; min-height: calc(100vh / var(--uiz, 1)); min-height: calc(100dvh / var(--uiz, 1)); }
  .shv-doc, .shv-foot { padding-left: 16px; padding-right: 16px; }
}
`

const dirOf = (p: string): string => p.split('/').slice(0, -1).join('/')

/** 首屏落到哪一页:hash 指名且在范围内 → 它;subtree 模式 → 第一页;page 模式 → 根页。 */
function initialPage(meta: ShareMeta, tree: ShareTree): string {
  const fromHash = location.hash.slice(1) ? decodeURIComponent(location.hash.slice(1)) : ''
  if (fromHash && tree.pages.includes(fromHash)) return fromHash
  return meta.mode === 'subtree' ? (tree.pages[0] ?? meta.path) : meta.path
}

type NoteState =
  | { path: string; decision: RouteDecision; raw: string }
  | { path: string; error: string }

function ShareApp({ base, meta, tree, onCurrentChange }: ShareViewerProps): React.ReactElement {
  const { t } = useI18n()
  const mode = useTheme((s) => s.mode)
  const flat = useTheme((s) => s.flat)
  const [current, setCurrent] = useState<string>(() => initialPage(meta, tree))
  const [note, setNote] = useState<NoteState | null>(null)
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  // 画布满铺时笔记体绝对定位铺满 pane,流里的页脚会浮到舞台左上角盖住主卡(真链路截图实见)—— 满铺期间不画页脚。
  const [canvasOn, setCanvasOn] = useState(false)
  const paneRef = useRef<HTMLDivElement>(null)

  useEffect(() => { onCurrentChange(current) }, [current, onCurrentChange])

  useEffect(() => {
    const onHash = (): void => {
      const p = decodeURIComponent(location.hash.slice(1))
      if (p) setCurrent(p)
    }
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // 读原文 → 路由(与桌面 amadeusViews 同一把尺子:routeNote;升级开关恒开,内存里升成 v4 但只读不落盘)。
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const raw = await amadeus.readTextFile(current)
        if (!alive) return
        if (raw == null) {
          setNote({ path: current, error: t('shareview.notFound') })
          return
        }
        setNote({ path: current, decision: routeNote(current, raw, true, new Date().toISOString()), raw })
        document.title = `${stripPageBasename(current)} · Forsion`
      } catch {
        if (alive) setNote({ path: current, error: t('shareview.loadFailed') })
      }
    })()
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  const go = (p: string): void => {
    location.hash = encodeURIComponent(p)
    setCurrent(p)
  }

  // [[双链]] 点击:编辑器里的 wikilink 部件在自己身上听 mousedown → pageStore.openWikiLink → openNote → LCL 工作区,
  // 这里没有工作区。捕获期截在祖先上(先于目标节点的监听器),范围内的按 hash 导航,范围外的什么都不做
  // (产品口径:范围外链接照常显示、点不进去)。
  useEffect(() => {
    const pane = paneRef.current
    if (!pane) return
    const onDown = (e: MouseEvent): void => {
      const el = (e.target as HTMLElement | null)?.closest?.('.wikilink[data-wiki]') as HTMLElement | null
      if (!el) return
      e.preventDefault()
      e.stopPropagation()
      const hit = resolvePageName(el.getAttribute('data-wiki') ?? '', tree.pages, current)
      if (hit) go(hit)
    }
    pane.addEventListener('mousedown', onDown, true)
    return () => pane.removeEventListener('mousedown', onDown, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tree, current])

  // 侧栏折叠树:与桌面端同一套 buildTree/mergeFdNotes;subtree 模式以分享根为顶层,page 模式以根页所在
  // 文件夹为顶层(根页 + 它的 .fd 子页面被 mergeFdNotes 折成一支)。
  const treeRoot = useMemo(() => {
    const full = mergeFdNotes(buildTree(tree.pages, tree.folders))
    return subtreeAt(full, meta.mode === 'subtree' ? tree.root : dirOf(tree.root))
  }, [tree, meta.mode])
  const showSide = meta.mode === 'subtree' || tree.pages.length > 1

  // 落到新页面就展开它的祖先。ponytail: 不持久化,手动开合只活在本次会话。
  useEffect(() => {
    if (!treeRoot || !current) return
    const chain = pathTo(treeRoot, current)
    if (!chain?.length) return
    setExpanded((prev) => (chain.every((p) => prev.has(p)) ? prev : new Set([...prev, ...chain])))
  }, [treeRoot, current])

  const toggle = (path: string): void => setExpanded((prev) => {
    const next = new Set(prev)
    if (!next.delete(path)) next.add(path)
    return next
  })

  // 整行:文件夹→开合,文件→跳转;有孩子的行前面那个三角单独可点(.fd 容器笔记既能开也能读)。
  const renderRow = (n: TreeNode, depth: number): React.ReactElement => {
    const open = expanded.has(n.path)
    const foldable = n.children.length > 0
    return (
      <React.Fragment key={n.path}>
        <button
          className={n.path === current ? 'on' : ''}
          style={{ paddingLeft: 10 + depth * 12 }}
          onClick={() => {
            if (n.kind !== 'file') { toggle(n.path); return }
            go(n.path)
          }}
        >
          <span className="cr" onClick={foldable ? (e) => { e.stopPropagation(); toggle(n.path) } : undefined}>
            {foldable ? (open ? '▾' : '▸') : ''}
          </span>
          {n.name.replace(/\.md$/i, '')}
        </button>
        {open && n.children.map((c) => renderRow(c, depth + 1))}
      </React.Fragment>
    )
  }

  const ready = note && note.path === current ? note : null
  const title = stripPageBasename(current)

  return (
    <div className="shv">
      {showSide && <nav className="shv-side">{treeRoot.children.map((n) => renderRow(n, 0))}</nav>}
      <main className="shv-main">
        <div ref={paneRef} className="am-app tangu-lovable amx-pane amx-editor shv-pane" data-mode={mode} data-flat={flat ? '1' : '0'}>
          {/* 顶栏:与桌面 .amx-toolbar 同一条(sticky、画布满铺压不住它);胶囊插槽由 UnifiedPage 的 CanvasSegPortal
              投「文档 | 画布」进来。移动端也画这条 —— 应用里手机没顶栏是因为底栏胶囊接管了,这里没有底栏。 */}
          <div className="amx-toolbar shv-toolbar">
            <span className="shv-crumb" title={current}>{title}</span>
            <span className="shv-spacer" />
            <span className={SEG_SLOT} />
            <span className="shv-ro">{t('shareview.readOnly')}</span>
          </div>
          {!ready ? (
            <div className="shv-center">{t('shareview.loading')}</div>
          ) : 'error' in ready ? (
            <div className="shv-center">{ready.error}</div>
          ) : ready.decision.editor === 'unified' ? (
            <UnifiedPage
              key={current}
              path={current}
              initial={ready.decision.initial}
              diskRaw={ready.decision.diskRaw}
              readOnly
              onCanvasMode={(s) => setCanvasOn(!!s?.on)}
            />
          ) : (
            <>
              <div className="amx-doc"><h1 className="amx-title-input amx-title-static">{title}</h1></div>
              <ShareMarkdown base={base} current={current} pages={tree.pages} content={ready.raw} />
            </>
          )}
          {!canvasOn && <footer className="shv-foot">{t('shareview.footer')}</footer>}
        </div>
      </main>
      <WikiHoverPreview />
    </div>
  )
}

export function mountShareViewer(props: ShareViewerProps): void {
  // 主题:与 desktop main.tsx 同一次调用(语言 × 主题色 × 背景 × 明暗,读访客自己的偏好;没用过 Forsion 的访客
  // 拿到缺省 lovable/cream + 跟随系统明暗)。
  applyTheme(resolveInitialLang(), resolveInitialSkin(), resolveInitialBg(), resolveInitialEffectiveMode())
  // 名册进 pageStore:wikilink 的「已解析/未解析」判定与悬停预览按 pages 找;vaultRoot 只是 localStorage 记忆
  // (画布/文档模式、滚动位置)的命名空间,按 token 隔开,别和登录后的云库串键。
  usePageStore.setState({
    vaultRoot: `share:${props.token}`,
    vaultSide: 'local',
    pages: props.tree.pages,
    folders: props.tree.folders,
    files: [],
    icons: {},
    status: 'ready',
    vaultLoading: false,
  })
  const style = document.createElement('style')
  style.textContent = CSS
  document.head.appendChild(style)
  const el = document.getElementById('root') ?? document.body.appendChild(document.createElement('div'))
  createRoot(el).render(
    <LocaleProvider>
      <ShareApp {...props} />
    </LocaleProvider>,
  )
}
