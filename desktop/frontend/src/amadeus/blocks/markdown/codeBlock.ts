/** 代码块增强(AFFiNE 对标):lowlight(highlight.js common,37 语言)语法高亮装饰
 *  + 悬停工具条 widget(语言选择 / 复制 / 折行)。配色复用 base.css 既有 .hljs-* 主题 token。
 *  语言即 fence info(```py)= code_block 节点 attrs.language,改语言 = setNodeMarkup(落盘 md 原生);
 *  折行是会话视图态(不进 md),位置经事务映射保持贴同一块。
 *  块编辑器一块一 doc,doc 极小 → 每次变更全量重高亮,无需缓存。 */
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import { common, createLowlight } from 'lowlight'
import { currentLocale, registerMessages, translate } from '../../../i18n'

/** 工具条文案。⚠️ 按钮字面**必须短**(和中文的两字一样):工具条绝对定位盖在代码块右上,
 *  英文写长了(实测 "Line numbers"/"Collapse" 一套 375px)会盖住短代码块的水平中心,点进去
 *  落到 select 上而不是代码里 —— e2e T42「代码块 Tab → 行首两空格」就是这么红的。完整说明放 title。 */
registerMessages({
  'amxcode.langTitle': { zh: '语言', en: 'Language' },
  'amxcode.plainText': { zh: '纯文本', en: 'Plain text' },
  'amxcode.copy': { zh: '复制', en: 'Copy' },
  'amxcode.copyTitle': { zh: '复制代码', en: 'Copy code' },
  'amxcode.copied': { zh: '已复制', en: 'Copied' },
  'amxcode.wrap': { zh: '折行', en: 'Wrap' },
  'amxcode.wrapTitle': { zh: '切换自动折行(视图态,不改内容)', en: 'Toggle line wrap (view only, does not change content)' },
  'amxcode.linenoOff': { zh: '取消行号', en: 'Hide numbers' },
  'amxcode.lineno': { zh: '行号', en: 'Numbers' },
  'amxcode.linenoDisabled': { zh: '折行开着时不显示行号(软换行无独立行号)', en: 'Line numbers are unavailable while wrapping is on (soft-wrapped lines have no number of their own)' },
  'amxcode.linenoTitle': { zh: '切换行号(视图态,不改内容)', en: 'Toggle line numbers (view only, does not change content)' },
  'amxcode.expand': { zh: '展开', en: 'Unfold' },
  'amxcode.collapse': { zh: '折叠', en: 'Fold' },
  'amxcode.collapseTitle': { zh: '折叠代码块(限高 8 行,视图态)', en: 'Fold the code block (8-line limit, view only)' },
})

const lowlight = createLowlight(common)

/** 语言菜单:常用置顶,其余字典序;'' = 纯文本。 */
const TOP = ['javascript', 'typescript', 'python', 'bash', 'json', 'html', 'css', 'sql', 'java', 'go', 'rust', 'c', 'cpp', 'yaml', 'markdown', 'diff']
const LANGS: string[] = [...TOP, ...lowlight.listLanguages().filter((l) => !TOP.includes(l)).sort()]

interface TokenRange {
  from: number
  to: number
  cls: string
}

interface HastText { type: 'text'; value: string }
interface HastElement { type: 'element'; children?: HastAny[]; properties?: { className?: string[] } }
type HastAny = HastText | HastElement

/** hast 树 → 按文本偏移的 class 区间(不认识的语言/解析失败 = 无高亮,绝不炸)。 */
function tokenRanges(code: string, lang: string): TokenRange[] {
  if (!code || !lang) return []
  let children: HastAny[]
  try {
    if (!lowlight.registered(lang)) return []
    children = lowlight.highlight(lang, code).children as HastAny[]
  } catch {
    return []
  }
  const out: TokenRange[] = []
  let off = 0
  const walk = (nodes: HastAny[], classes: string[]): void => {
    for (const n of nodes) {
      if (n.type === 'text') {
        if (classes.length) out.push({ from: off, to: off + n.value.length, cls: classes.join(' ') })
        off += n.value.length
      } else if (n.type === 'element') {
        walk(n.children ?? [], [...classes, ...(n.properties?.className ?? [])])
      }
    }
  }
  walk(children, [])
  return out
}

const codeKey = new PluginKey<CodeUi>('amx-code-block')

/** 三个视图开关都是**会话态**:切页/重开即复位。AFFiNE 那边是持久化块属性(code-model.ts),
 *  我们不往纯 md 里加 amadeus_* 键,这是刻意的偏差。 */
interface CodeUi {
  wrapped: Set<number>
  lineno: Set<number>
  collapsed: Set<number>
}
/** 语言选择的「最近使用」:同一次会话里选过的语言排到列表最前(AFFiNE 同款手感)。 */
const recentLangs: string[] = []

export function codeBlockPlugin() {
  return $prose(
    () =>
      new Plugin({
        key: codeKey,
        state: {
          init: () => ({ wrapped: new Set<number>(), lineno: new Set<number>(), collapsed: new Set<number>() }),
          apply(tr, v) {
            if (!tr.docChanged && !tr.getMeta(codeKey)) return v
            const wrapped = new Set([...v.wrapped].map((p) => tr.mapping.map(p)))
            const lineno = new Set([...v.lineno].map((p) => tr.mapping.map(p)))
            const collapsed = new Set([...v.collapsed].map((p) => tr.mapping.map(p)))
            const meta = tr.getMeta(codeKey) as { toggle?: number; which?: 'wrap' | 'lineno' | 'collapse' } | undefined
            if (meta?.toggle != null) {
              const set = meta.which === 'lineno' ? lineno : meta.which === 'collapse' ? collapsed : wrapped
              if (set.has(meta.toggle)) set.delete(meta.toggle)
              else set.add(meta.toggle)
            }
            return { wrapped, lineno, collapsed }
          },
        },
        props: {
          decorations(state) {
            const decos: Decoration[] = []
            const ui = codeKey.getState(state)
            const wrapped = ui?.wrapped ?? new Set<number>()
            const lineno = ui?.lineno ?? new Set<number>()
            const collapsed = ui?.collapsed ?? new Set<number>()
            state.doc.descendants((node, pos) => {
              if (node.type.name !== 'code_block') return true
              const lang = String((node.attrs as { language?: string }).language ?? '').trim()
              const isWrap = wrapped.has(pos)
              const isNo = lineno.has(pos) && !isWrap // 折行时行号必然错位(软换行没有自己的号),互斥
              const isCollapsed = collapsed.has(pos)
              decos.push(Decoration.node(pos, pos + node.nodeSize, {
                class: `amx-code${isWrap ? ' amx-code-wrap' : ''}${isNo ? ' amx-code-lineno' : ''}${isCollapsed ? ' amx-code-collapsed' : ''}`,
                ...(isNo ? { 'data-lines': String(node.textContent.split('\n').length) } : {}),
              }))
              for (const t of tokenRanges(node.textContent, lang)) {
                decos.push(Decoration.inline(pos + 1 + t.from, pos + 1 + t.to, { class: t.cls }))
              }
              if (isNo) {
                // ⚠️ code_block 是**一个** <pre>,行不是元素 —— CSS 计数器没有可计的东西。
                // 只能自己画一列:与代码同字体同行高(挂在 pre 内部,直接继承),绝对定位在左槽。
                const lines = node.textContent.split('\n').length
                decos.push(
                  Decoration.widget(
                    pos + 1,
                    () => {
                      const col = document.createElement('span')
                      col.className = 'amx-code-nums'
                      col.contentEditable = 'false'
                      col.textContent = Array.from({ length: lines }, (_, i) => String(i + 1)).join('\n')
                      return col
                    },
                    { side: -1, ignoreSelection: true, stopEvent: () => true, key: `cn${pos}:${lines}` },
                  ),
                )
              }
              decos.push(
                Decoration.widget(
                  pos + 1,
                  (view, getPos) => {
                    /** widget 当前位置 = 节点位置 + 1(getPos 随事务映射,比 posAtDOM 猜测可靠)。 */
                    const nodeAt = (): number | null => {
                      const p = getPos()
                      return p === undefined ? null : p - 1
                    }
                    const bar = document.createElement('div')
                    bar.className = 'amx-code-tools'
                    bar.contentEditable = 'false'
                    // 语言选择
                    const sel = document.createElement('select')
                    sel.className = 'amx-code-lang'
                    sel.title = translate('amxcode.langTitle')
                    const opt0 = document.createElement('option')
                    opt0.value = ''
                    opt0.textContent = translate('amxcode.plainText')
                    sel.appendChild(opt0)
                    const known = LANGS.includes(lang) || !lang
                    // 最近用过的排最前(会话内),其余保持原序 —— AFFiNE 选中即 unshift 的同款手感。
                    const ordered = [...recentLangs.filter((l) => LANGS.includes(l)), ...LANGS.filter((l) => !recentLangs.includes(l))]
                    for (const l of known ? ordered : [lang, ...ordered]) {
                      const o = document.createElement('option')
                      o.value = l
                      o.textContent = l
                      sel.appendChild(o)
                    }
                    sel.value = lang
                    sel.addEventListener('change', () => {
                      const at = nodeAt()
                      if (sel.value) {
                        const i = recentLangs.indexOf(sel.value)
                        if (i >= 0) recentLangs.splice(i, 1)
                        recentLangs.unshift(sel.value)
                      }
                      if (at === null) return
                      const n = view.state.doc.nodeAt(at)
                      if (n?.type.name === 'code_block') {
                        view.dispatch(view.state.tr.setNodeMarkup(at, undefined, { ...n.attrs, language: sel.value }))
                      }
                    })
                    // 复制
                    const copy = document.createElement('button')
                    copy.className = 'amx-code-btn'
                    copy.textContent = translate('amxcode.copy')
                    copy.title = translate('amxcode.copyTitle')
                    copy.addEventListener('click', () => {
                      const at = nodeAt()
                      const n = at === null ? null : view.state.doc.nodeAt(at)
                      if (!n) return
                      void navigator.clipboard.writeText(n.textContent).then(() => {
                        copy.textContent = translate('amxcode.copied')
                        setTimeout(() => { copy.textContent = translate('amxcode.copy') }, 1200)
                      })
                    })
                    // 折行
                    const wrap = document.createElement('button')
                    wrap.className = `amx-code-btn${isWrap ? ' on' : ''}`
                    wrap.textContent = translate('amxcode.wrap')
                    wrap.title = translate('amxcode.wrapTitle')
                    wrap.addEventListener('click', () => {
                      const at = nodeAt()
                      if (at !== null) view.dispatch(view.state.tr.setMeta(codeKey, { toggle: at }))
                    })
                    // 行号(与折行互斥:软换行没有自己的号,开着折行时行号必然错位)
                    const nums = document.createElement('button')
                    nums.className = `amx-code-btn${isNo ? ' on' : ''}`
                    nums.textContent = isNo ? translate('amxcode.linenoOff') : translate('amxcode.lineno')
                    nums.title = isWrap ? translate('amxcode.linenoDisabled') : translate('amxcode.linenoTitle')
                    nums.disabled = isWrap
                    nums.addEventListener('click', () => {
                      const at = nodeAt()
                      if (at !== null) view.dispatch(view.state.tr.setMeta(codeKey, { toggle: at, which: 'lineno' }))
                    })
                    // 折叠(限高 8 行 + 底部渐隐,AFFiNE 同款)
                    const fold = document.createElement('button')
                    fold.className = `amx-code-btn${isCollapsed ? ' on' : ''}`
                    fold.textContent = isCollapsed ? translate('amxcode.expand') : translate('amxcode.collapse')
                    fold.title = translate('amxcode.collapseTitle')
                    fold.addEventListener('click', () => {
                      const at = nodeAt()
                      if (at !== null) view.dispatch(view.state.tr.setMeta(codeKey, { toggle: at, which: 'collapse' }))
                    })
                    bar.append(sel, copy, wrap, nums, fold)
                    return bar
                  },
                  // key 带语言与折行态:变更即重建(select 值/按钮态才会刷新)。
                  // 末尾的界面语言同理:切了中英文后下一次重绘会重建工具条,不至于留着旧语言的按钮文案。
                  { side: -1, ignoreSelection: true, stopEvent: () => true, key: `ct${pos}:${lang}:${isWrap ? 1 : 0}:${isNo ? 1 : 0}:${isCollapsed ? 1 : 0}:${currentLocale()}` },
                ),
              )
              return false
            })
            return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty
          },
        },
      }),
  )
}
