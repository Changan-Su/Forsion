/** Amadeus 全局浮层(Root 级挂载):左栏折叠会卸载面板,浮层不能住在面板/侧栏里。
 *  复用 engine 命令面板的 cmd-* 外观;cmd-row/cmd-path 两个补充类在 amadeus-host.css。
 *  组件随 overlay 状态整体卸载 → 每次打开都是干净的输入态,无需重置。 */
import { useEffect, useState, type KeyboardEvent } from 'react'
import { usePageStore } from '@amadeus/store/pageStore'
import { useUiStore } from '@amadeus/store/uiStore'
import { useUiOverlay, type TemplateCtx } from './amadeusOverlayStore'
import { pageKey } from '@amadeus-shared/links'
import { fuzzyRank } from '@lcl/engine/fuzzy'
import { openNote } from './amadeusNav'
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
  return (
    <>
      {overlay === 'switcher' && <QuickSwitcher />}
      {overlay === 'template' && templateCtx && <TemplatePicker ctx={templateCtx} />}
      {toast && <div className="amx-toast">{toast}</div>}
    </>
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
    if (showCreate && i === results.length) usePageStore.getState().openWikiLink(q)
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
