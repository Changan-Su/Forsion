/** Amadeus 全局浮层(Root 级挂载):左栏折叠会卸载面板,浮层不能住在面板/侧栏里。
 *  复用 engine 命令面板的 cmd-* 外观;cmd-row/cmd-path 两个补充类在 amadeus-host.css。
 *  组件随 overlay 状态整体卸载 → 每次打开都是干净的输入态,无需重置。 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { usePageStore } from '@amadeus/store/pageStore'
import { useUiStore } from '@amadeus/store/uiStore'
import { ConfirmDialog } from '@amadeus/components/Dialogs'
import { WikiHoverPreview } from '@amadeus/components/WikiHoverPreview'
import { AskStringHost } from '@amadeus/components/askString'
import { CloudSyncDialogHost } from './components/CloudSyncDialog'
import { fdDirOf } from '@amadeus/lib/fd'
import { useUiOverlay, type TemplateCtx } from './amadeusOverlayStore'
import { pageKey } from '@amadeus-shared/links'
import { fuzzyRank } from '@lcl/engine/fuzzy'
import { openDb, openDrawing, openFile, openNote, openPdf } from './amadeusNav'
import { insertTemplate, listTemplates } from './amadeusTemplates'

const baseName = (p: string): string => (p.split(/[\\/]/).pop() ?? p).replace(/\.md$/i, '')

export function AmadeusOverlays() {
  const overlay = useUiOverlay((s) => s.overlay)
  const templateCtx = useUiOverlay((s) => s.templateCtx)
  const toast = useUiStore((s) => s.toast) // 插件 notify / 字数统计等的全局吐司(自动 2.6s 消失)
  // 斜杠菜单「模板」经 CustomEvent 解耦触发(vendored MarkdownBlock 不 import 桌面 store)。
  useEffect(() => {
    const onPick = (e: Event): void => {
      const d = (e as CustomEvent<TemplateCtx>).detail
      if (d?.afterId) useUiOverlay.getState().openTemplate(d)
    }
    window.addEventListener('amadeus:template-picker', onPick)
    return () => window.removeEventListener('amadeus:template-picker', onPick)
  }, [])
  // 同一解耦模式:编辑器层要给用户提示时发事件(目前用于插件斜杠项失败 —— 第三方代码静默失败会被当成「点了没反应」)。
  useEffect(() => {
    const onToast = (e: Event): void => {
      const d = (e as CustomEvent<{ text?: string }>).detail
      if (d?.text) useUiStore.getState().notify(d.text) // 与插件 ctx.notify 同一条吐司通道(2.6s 自动消失)
    }
    window.addEventListener('amadeus:toast', onToast)
    return () => window.removeEventListener('amadeus:toast', onToast)
  }, [])
  // [[xxx.db]] 点击应用内开 db tab(pageStore 发事件解耦,同模板选择器模式)。
  useEffect(() => {
    const onOpenDb = (e: Event): void => {
      const p = (e as CustomEvent<{ path?: string }>).detail?.path
      if (typeof p === 'string' && p) openDb(p)
    }
    window.addEventListener('amadeus:open-db', onOpenDb)
    return () => window.removeEventListener('amadeus:open-db', onOpenDb)
  }, [])
  // [[xxx.pdf#page=N]] 点击应用内开可批注 PDF tab(pageStore 发事件解耦,同 open-db 模式)。
  useEffect(() => {
    const onOpenPdf = (e: Event): void => {
      const d = (e as CustomEvent<{ path?: string; page?: number }>).detail
      if (typeof d?.path === 'string' && d.path) openPdf(d.path, d.page)
    }
    window.addEventListener('amadeus:open-pdf', onOpenPdf)
    return () => window.removeEventListener('amadeus:open-pdf', onOpenPdf)
  }, [])
  // [[X.excalidraw]] 点击应用内开白板 tab(pageStore 发事件解耦,同 open-db 模式)。
  useEffect(() => {
    const onOpenDrawing = (e: Event): void => {
      const p = (e as CustomEvent<{ path?: string }>).detail?.path
      if (typeof p === 'string' && p) openDrawing(p)
    }
    window.addEventListener('amadeus:open-drawing', onOpenDrawing)
    return () => window.removeEventListener('amadeus:open-drawing', onOpenDrawing)
  }, [])
  // `[[图.mindmap.md]]` 之类:名字直接命中库里一份已存在的文件(插件声明的文件类型多为 `.<子类型>.md`,
  // 页面列表里永远查不到)。openFile 会按内置 → 插件 → 系统默认程序依次路由。
  useEffect(() => {
    const onOpenFile = (e: Event): void => {
      const p = (e as CustomEvent<{ path?: string }>).detail?.path
      if (typeof p === 'string' && p) openFile(p)
    }
    window.addEventListener('amadeus:open-file', onOpenFile)
    return () => window.removeEventListener('amadeus:open-file', onOpenFile)
  }, [])
  return (
    <>
      {overlay === 'switcher' && <QuickSwitcher />}
      {overlay === 'template' && templateCtx && <TemplatePicker ctx={templateCtx} />}
      <WikiCreateConfirm />
      <WikiHoverPreview />
      <AskStringHost />
      <CloudSyncDialogHost />
      {toast && <div className="amx-toast">{toast}</div>}
    </>
  )
}

/** 未解析 [[链接]] 点击后的创建确认(pendingWikiCreate 驱动):裸名落源笔记 .fd,
 *  带路径按链接原路径,无源落 vault 根。.dialog-* 样式挂在 .am-app 下 → display:contents 载体;
 *  .tangu-lovable = 取色桥,少了它弹窗吃到 html 上钉死的 Origin 色(理由见 askString Host 注释)。 */
function WikiCreateConfirm() {
  const pending = usePageStore((s) => s.pendingWikiCreate)
  if (!pending) return null
  const dest = /[\\/]/.test(pending.name)
    ? `${pending.name.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/\.md$/i, '')}.md`
    : pending.sourcePath
      ? `${fdDirOf(pending.sourcePath)}/${pending.name}.md`
      : `${pending.name}.md`
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <ConfirmDialog
        title="创建新笔记"
        message={`“${pending.name}” 尚不存在。要在 ${dest} 创建吗？`}
        confirmLabel="创建"
        danger={false}
        onConfirm={() => void usePageStore.getState().confirmWikiCreate()}
        onClose={() => usePageStore.getState().cancelWikiCreate()}
      />
    </div>
  )
}

/** 模板选择器:列出 templates/ 下的笔记,选中即插入(替换 {{date}}/{{time}}/{{title}})。 */
function TemplatePicker({ ctx }: { ctx: TemplateCtx }) {
  const pages = usePageStore((s) => s.pages)
  const close = useUiOverlay((s) => s.close)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  void pages // 订阅 pages 让「创建模板文件夹」后列表随结构刷新

  const templates = fuzzyRank(query, listTemplates(), (p) => pageKey(p))
  const choose = (i: number): void => {
    const t = templates[i]
    close()
    // 模板可能在列表刷新前被删(readPage 只读、缺文件即抛)——吞掉即可,不留幽灵文件。
    if (t) insertTemplate(t, ctx.afterId, ctx.emptyBlock).catch(() => { /* ignore */ })
  }
  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, templates.length - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  return (
    <div className="cmd-overlay" onMouseDown={close}>
      <div className="cmd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          autoFocus
          placeholder="选择模板…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onKeyDown}
        />
        <div className="cmd-list">
          {templates.map((p, i) => (
            <button key={p} className="cmd-item" data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
              <span className="cmd-row">
                <span className="cmd-title">{baseName(p)}</span>
                <span className="cmd-path">{p}</span>
              </span>
            </button>
          ))}
          {templates.length === 0 && (
            <div className="cmd-empty">
              还没有模板。把笔记放进 vault 的 templates/ 文件夹即可,支持 {'{{date}} {{time}} {{title}}'} 变量。
              <div style={{ marginTop: 10 }}>
                <button className="btn ghost sm" onClick={() => { void usePageStore.getState().createFolder('', 'templates'); close() }}>
                  创建 templates 文件夹
                </button>
              </div>
            </div>
          )}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 插入 <kbd>esc</kbd> 关闭</span>
          <span className="cmd-foot-count">{templates.length} 个模板</span>
        </div>
      </div>
    </div>
  )
}

/** ⌘P 快速切换:模糊跳转任意笔记;无匹配时可就地新建(走 openWikiLink,与 [[ ]] 同语义)。 */
function QuickSwitcher() {
  const pages = usePageStore((s) => s.pages)
  const close = useUiOverlay((s) => s.close)
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)

  const results = fuzzyRank(query, pages, pageKey).slice(0, 30)
  const q = query.trim()
  const showCreate = q.length > 0 && !pages.some((p) => pageKey(p) === pageKey(q))
  const total = results.length + (showCreate ? 1 : 0)

  const choose = (i: number): void => {
    // 「新建」是显式创建意图:直接建在 vault 根,不走未解析询问流程。
    if (showCreate && i === results.length) void usePageStore.getState().createWikiPage(q)
    else if (results[i]) void openNote(results[i])
    close()
  }

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, total - 1)) }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)) }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active) }
    else if (e.key === 'Escape') { e.preventDefault(); close() }
  }

  return (
    <div className="cmd-overlay" onMouseDown={close}>
      <div className="cmd-panel" onMouseDown={(e) => e.stopPropagation()}>
        <input
          className="cmd-input"
          autoFocus
          placeholder="跳转到笔记…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActive(0) }}
          onKeyDown={onKeyDown}
        />
        <div className="cmd-list">
          {results.map((p, i) => (
            <button key={p} className="cmd-item" data-active={i === active || undefined} onMouseEnter={() => setActive(i)} onClick={() => choose(i)}>
              <span className="cmd-row">
                <span className="cmd-title">{baseName(p)}</span>
                <span className="cmd-path">{p}</span>
              </span>
            </button>
          ))}
          {showCreate && (
            <button className="cmd-item" data-active={active === results.length || undefined} onMouseEnter={() => setActive(results.length)} onClick={() => choose(results.length)}>
              <span className="cmd-row">
                <span className="cmd-title">新建 “{q}”</span>
                <span className="cmd-path">创建新笔记</span>
              </span>
            </button>
          )}
          {total === 0 && <div className="cmd-empty">无匹配笔记</div>}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑↓</kbd> 选择 <kbd>↵</kbd> 打开 <kbd>esc</kbd> 关闭</span>
          <span className="cmd-foot-count">{total} 项</span>
        </div>
      </div>
    </div>
  )
}
