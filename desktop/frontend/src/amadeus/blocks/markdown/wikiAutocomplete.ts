// A ProseMirror plugin that watches for an in-progress [[ … and reports the query,
// its document range, and caret screen coords so a React popup can suggest pages.
// The query lives in the document (unlike the slash menu), so the popup lets letters
// pass through and only intercepts navigation keys.

import { $inputRule, $prose } from '@milkdown/kit/utils'
import { InputRule } from '@milkdown/kit/prose/inputrules'
import { Plugin, PluginKey, NodeSelection, type EditorState } from '@milkdown/kit/prose/state'
import type { EditorView } from '@milkdown/kit/prose/view'
import { blockLabel, type BlockNode } from './blockTriggers'
import { editContextAt, editContextOf, slashAvailable, toolbarShape, type EditContext, type ToolbarShape } from './menuContext'
import { registerMessages, translate } from '../../../i18n'
import { AT_BLOCKED_BEFORE } from '@amadeus-shared/mdMarks'

registerMessages({
  'wikiac.multiBlocks': { zh: '多个块', en: 'Multiple blocks' },
})

/** 全角【【 当场换成半角 [[(AFFiNE 的 convertTriggerKey 同款,它的触发键表就是 ['@','[[','【【'])。
 *  中文输入法下打 `[` 得先切回英文键盘 —— 不给这条,双链在中文写作里天然多两次切换。
 *  换完由既有的 wikiSuggestPlugin 照常接管(它只认半角,不必改)。 */
export const fullWidthWikiRule = $inputRule(
  // inCodeMark:false —— 行内代码里的【【是字面(代码块本来就不跑输入规则),同 L-03。
  () => new InputRule(/【【$/, (state, _match, start, end) => state.tr.insertText('[[', start, end), { inCodeMark: false }),
)

/** 触发串([[ / @ / '/')到光标这一段落在代码里:代码块,或带 code 标记(行内代码)的文字。
 *  代码里这些字符恒字面(`if [[ -f x ]]`、Java 的 `@Test`、路径里的 `/`),弹面板还会劫持
 *  Enter/Tab(L-03)。判的是**触发串本身**而不只是光标处的 marks:光标刚出行内代码、`[[` 却在里面也算。 */
export function inCode(state: EditorState, from: number, to: number): boolean {
  if (state.selection.$head.parent.type.spec.code) return true
  let hit = false
  state.doc.nodesBetween(from, to, (n) => {
    if (n.isInline && n.marks.some((m) => m.type.spec.code)) hit = true
  })
  return hit
}

/** 补全上报回调。`blurred` = 因编辑器失焦而关(L-04):调用方只藏面板、**不清 Esc 闩锁** ——
 *  失焦再回来,被 Esc 掉的同一个 `@` / `/` 不该重弹。 */
export type SuggestReport = (q: WikiQuery | null, blurred?: boolean) => void

/** 失焦即关(L-04):面板在 window 捕获阶段拦 ↑↓/Enter/Tab,编辑器不持焦时还挂着,就会劫持
 *  标题框、侧栏聊天框等别处输入框的按键(甚至把 Enter 变成往正文插链接、把焦点拽回正文)。
 *  update 里的 hasFocus 闸管「失焦后的任何事务」,这里的 blur 管「失焦本身不派事务」的情形。 */
export const closeOnBlur = (report: SuggestReport) => ({
  handleDOMEvents: {
    blur: () => {
      report(null, true)
      return false
    },
  },
})

export interface WikiQuery {
  /** Text typed after the opening "[[". */
  query: string
  /** Document position just after "[[". */
  from: number
  /** Document position of the caret. */
  to: number
  left: number
  /** 光标行下沿(视口 px):菜单默认展开点。 */
  top: number
  /** 光标行上沿(视口 px):下方放不下时菜单翻到这条线之上,不盖住正在打字的行。 */
  anchorTop: number
  /** 仅 [[:光标所在链接**已闭合**时,收尾 `]]` 的文档位置 —— 选中候选只替换目标名这一段
   *  (见 wikiRetarget),不再插入第二个 `]]`。缺省 = 新写的未闭合链接。 */
  closeAt?: number
  /** 仅 slash:触发点的编辑上下文(菜单据此只列这里做得成的项,B-18)。 */
  ctx?: EditContext
}

export function wikiSuggestPlugin(report: SuggestReport) {
  return $prose(
    () =>
      new Plugin({
        props: closeOnBlur(report),
        view: () => ({
          update(view, prevState) {
            if (!view.hasFocus()) return report(null, true)
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock) return report(null)
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const open = before.lastIndexOf('[[')
            if (open < 0) return report(null)
            const q = before.slice(open + 2)
            if (/[\]\n]/.test(q)) return report(null) // the [[ was closed or aborted
            if (inCode(view.state, $head.start() + open, selection.head)) return report(null)
            // ⚠️ 光标**后面**已经有配对的 `]]` = 这条双链早就写完了。这种情况下**只有用户真的在里面
            // 打字才补全,单纯移动光标不弹**:
            //  · 不加这道闸 → 「↑ 从下一行走进 [[某笔记]] 那一行」会当场弹出候选面板,而面板要吃掉
            //    ↑/↓ 做菜单选择,光标从此困死在这一行(用户实报「双链引用行上不去」)。
            //  · 只按「闭合就不弹」一刀切 → 用户想改已有链接的目标名时再也拿不到候选(Codex 评审指出的
            //    UX 回归)。所以判据是「文档有没有变」而不是「链接闭没闭合」。
            // 仪器:scripts/arrow-trap.check.cjs(路过不弹) + editor-triggers 的 T38(打字仍弹)。
            const after = $head.parent.textBetween($head.parentOffset, $head.parent.content.size, undefined, '￼')
            const line = after.split('\n', 1)[0]
            const close = line.indexOf(']]')
            const nextOpen = line.indexOf('[[')
            const closed = close >= 0 && (nextOpen < 0 || close < nextOpen)
            if (closed && (!prevState || prevState.doc.eq(view.state.doc))) return report(null)
            // 已闭合链接里光标已越过目标名(在 `#锚点` / `|别名` 里打字)→ 不给目标候选,
            // 否则选中会拿页面名盖掉用户正在改的锚点/别名(L-02)。
            if (closed && /[#|]/.test(q)) return report(null)
            const from = $head.start() + open + 2
            const to = selection.head
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            // textBetween 的 leaf 占位是 1 字符 = 1 位置,块内偏移与文档位置一一对应。
            const closeAt = closed ? to + close : undefined
            report({ query: q, from, to, left: coords.left, top: coords.bottom, anchorTop: coords.top, closeAt })
          },
        }),
      }),
  )
}

/** Same shape for an in-progress "/" slash command (Notion/AFFiNE 式):
 *  triggers when "/" sits at line start or after whitespace; aborts on ANY whitespace /
 *  newline / "]" in the query, or an over-long query. Crucially the query lives IN THE
 *  DOCUMENT (like [[ and @, unlike the old keystroke-sink menu) — so letters fall through
 *  to the editor and never get swallowed, and typing a space just leaves "/foo " as literal
 *  text (the menu vanishes). `from` = position just after "/"; the picker deletes the
 *  "/query" range via slashRange (blockTriggers) before applying the item. */
export function slashSuggestPlugin(report: SuggestReport) {
  return $prose(
    () =>
      new Plugin({
        props: closeOnBlur(report),
        view: () => ({
          update(view) {
            if (!view.hasFocus()) return report(null, true)
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock) return report(null)
            if ($head.parent.type.name === 'code_block') return report(null) // 代码块内 '/' 恒字面(路径/正则/注释)
            const ctx = editContextAt($head)
            if (!slashAvailable(ctx)) return report(null) // 单元格里一项都做不成(B-18),'/' 恒字面
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const slash = before.lastIndexOf('/')
            if (slash < 0) return report(null)
            if (inCode(view.state, $head.start() + slash, selection.head)) return report(null) // 行内代码同理
            if (slash > 0 && !/\s/.test(before[slash - 1])) return report(null) // 词中的 '/'(TCP/IP、路径)不触发
            const q = before.slice(slash + 1)
            // 空格(含 nbsp)/换行/']' → 关菜单留字面;'￼' = 行内图片/公式 leaf 占位,命中即关
            // (否则 slashRange 从 '/' 删到光标会把图片/公式一起删掉,Codex)。
            if (q.length > 40 || /[\s\]\n￼]/.test(q)) return report(null)
            const from = $head.start() + slash + 1
            const to = selection.head
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            report({ query: q, from, to, left: coords.left, top: coords.bottom, anchorTop: coords.top, ctx })
          },
        }),
      }),
  )
}

/** Same shape for an in-progress "@" mention (Notion 式提及页面):
 *  triggers unless "@" follows an ASCII email-ish char (AT_BLOCKED_BEFORE, shared with mdMarks —
 *  so `开会@明天` / `请联系@Me` trigger, `foo@bar` doesn't; L-18 / 拍板 #18); aborts on brackets/newline
 *  or an over-long query (an "@" far behind the caret is prose, not a mention).
 *  `from` = position just after "@" — the picker replaces [from-1, to) with "[[name]]". */
export function mentionSuggestPlugin(report: SuggestReport) {
  return $prose(
    () =>
      new Plugin({
        props: closeOnBlur(report),
        view: () => ({
          update(view) {
            if (!view.hasFocus()) return report(null, true)
            const { selection } = view.state
            if (!selection.empty) return report(null)
            const $head = selection.$head
            if (!$head.parent.isTextblock) return report(null)
            const before = $head.parent.textBetween(0, $head.parentOffset, undefined, '￼')
            const at = before.lastIndexOf('@')
            if (at < 0) return report(null)
            if (inCode(view.state, $head.start() + at, selection.head)) return report(null)
            // 邮箱 / 词中 `@`:前一个字是 ASCII 邮箱字符才不触发;汉字、中文标点之后照弹(与 mdMarks 标记解析同一个字符类)
            if (at > 0 && AT_BLOCKED_BEFORE.test(before[at - 1])) return report(null)
            const q = before.slice(at + 1)
            // 空格(含 nbsp)/换行/方括号/'￼' → 退出提及语义,留成字面文本(同 slash)。空格这条是
            // 用户实报:`@张三 你好` 整句被当成提及查询,面板赖着不走 → Enter 被它劫持,换不了行。
            // 多词页面照样提及:fuzzyScore 是子序列匹配,`@MeetingNotes` 命中 “Meeting Notes”。
            // '￼' = 行内图片/公式 leaf 占位:pickMention 替换 [from-1, to),夹在中间会被一并删掉。
            if (q.length > 30 || /[\s[\]\n￼]/.test(q)) return report(null)
            const from = $head.start() + at + 1
            const to = selection.head
            let coords: { left: number; top: number; bottom: number }
            try {
              coords = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            report({ query: q, from, to, left: coords.left, top: coords.bottom, anchorTop: coords.top })
          },
        }),
      }),
  )
}

/** 非空选区 → 上浮格式工具栏(选中文字的“快捷编辑”,同 Notion/AFFiNE)。与 [[ / @ / 斜杠三个补全
 *  互斥:它们只在光标折叠(空选区)时触发,这个只在有选区时触发。报告选区两端中点上方的屏幕坐标。 */
export interface SelRect {
  from: number
  to: number
  left: number
  /** 选区行上沿(视口 px):工具栏默认浮在它之上。 */
  top: number
  /** 选区行下沿(视口 px):上方没空间时翻到它之下。 */
  bottom: number
  /** 选区所在块的类型名(「正文」/「标题 2」/「无序列表」…),给工具栏的「转换为」按钮显示当前类型。 */
  kind: string
  /** **全覆盖**的行内格式名集合(AFFiNE 判据:选区内每一段都带这个格式才算激活;
   *  「粗体半句 + 普通半句」显示未激活,再按一次是整段加粗而不是取消)。 */
  active: string[]
  /** 选区覆盖文本块的共同对齐；不一致时缺省。 */
  align?: 'left' | 'center' | 'right'
  /** 这个上下文里工具栏该露哪几区(I-19:代码块 / 单元格里不列点了无效或会劈表的按钮,见 menuContext)。 */
  shape: ToolbarShape
  /** 选区**处处相同**的文字色 / 背景色(A▾ 按钮据此显示当前颜色);不一致或没有 = 缺省。 */
  fg?: string
  bg?: string
}
/** 选中的是不是「一张图」—— 两种形态都算:md 图片节点(NodeSelection),以及 `![[pic.png|200]]`
 *  那段被整体选中的源码文本(wikilink.ts 的选中态就是这么表示的)。
 *  行内格式工具栏据此让位:对图片来说 B/I/U 毫无意义,浮条还会盖住正文(截图自查发现)。 */
const IMG_EMBED_SEL_RE = /^!\[\[[^\]\n|]+\.(png|jpe?g|gif|webp|svg|avif|bmp)(\|\d+)?\]\]$/i
const toolbarFocused = (): boolean => !!(document.activeElement as Element | null)?.closest?.('.inline-toolbar')

function isImageSelection(state: EditorState): boolean {
  const sel = state.selection
  if (sel instanceof NodeSelection) return sel.node.type.name === 'image'
  return IMG_EMBED_SEL_RE.test(state.doc.textBetween(sel.from, sel.to))
}

/** Esc 关掉工具栏 = 这个选区不再弹(直到选区变了):宿主派一笔带此 meta 的空事务(I-20)。
 *  不设这道闩,焦点从工具栏还给编辑器的那一拍 update 又把它弹回来。 */
export const toolbarDismissKey = new PluginKey<boolean>('amx-toolbar-dismissed')

export function selectionToolbarPlugin(report: (r: SelRect | null) => void) {
  return $prose(() => {
    // 鼠标按住期间(拖选中)不出工具栏,松手才出(I-12,对标 Notion / Google Docs):按住时就上报,
    // 向上拖选时工具栏正好浮在指针要去的那一行上,指针落到工具栏上 → 第一段选不进来;向下拖则一路闪。
    // 键盘产生的选区(Shift+方向键 / ⌘A)没有按住这回事,照旧即时显示。
    let held = false
    const compute = (view: EditorView): void => {
            if (held || toolbarDismissKey.getState(view.state)) return report(null)
            const { selection, doc } = view.state
            // hasFocus:编辑器失焦(点到别处/别的块)时 blur 会派空事务触发 update、选区仍非空 →
            // 不判此条会留下过期工具栏,点它会对已离开的块施格式(Codex L2)。
            if (selection.empty || !view.editable) return report(null)
            // 焦点在工具栏自己身上(Alt+F10 进去的键盘用户,I-20)不算失焦 —— 否则一进工具栏它就被卸载。
            // ⚠️ blur 那一拍 activeElement 还是 body(焦点没落到目标上),当场判会把「正要进工具栏」误判成失焦:
            //    失焦时推迟一拍再判,真去了别处才收。
            if (!view.hasFocus() && !toolbarFocused()) {
              setTimeout(() => { if (!view.isDestroyed && !view.hasFocus() && !toolbarFocused()) report(null) }, 0)
              return
            }
            // 选中的是一张图片(md 图片节点 / `![[pic.png|200]]` 整段源码)→ 让位:B/I/U 对图片
            // 没有意义,浮条还正好盖住上一段正文(2026-08-27 观感自查揪出来的)。
            if (isImageSelection(view.state)) return report(null)
            const { from, to } = selection
            const $from = doc.resolve(from)
            if (!$from.parent.isTextblock) return report(null) // 节点选区不服务行内格式化
            // 跨块选区(段落拖到标题)行内格式仍然可用,但**不能谎报**成起点块的类型 —— 标成「多个块」。
            const spans = !$from.sameParent(doc.resolve(to))
            let a: { left: number; top: number; bottom: number }
            let b: { left: number; top: number; bottom: number }
            try {
              a = view.coordsAtPos(from)
              b = view.coordsAtPos(to)
            } catch {
              return report(null)
            }
            // 祖先链(内→外),attrs 各随各的节点 → 当前块类型名(此前工具栏恒显示「正文」)。
            const chain: BlockNode[] = []
            for (let d = $from.depth; d > 0; d--) {
              const n = $from.node(d)
              chain.push({ name: n.type.name, level: n.attrs.level as number | undefined, checked: (n.attrs.checked as boolean | null | undefined) ?? null })
            }
            // 全覆盖判定:rangeHasMark 是「有没有一处带」,这里要的是「是不是处处都带」——
            // 逐个文本片段问,任一片段没有即不算激活。
            const active: string[] = []
            // ⚠️ 下划线的 **mark** 名是 amadeusUnderline(amadeusU 是 mdast 节点名 —— 用它查 schema 恒查不到,U 从来不亮)。
            for (const name of ['strong', 'emphasis', 'inlineCode', 'strike_through', 'amadeusUnderline', 'link']) {
              const type = view.state.schema.marks[name]
              if (!type) continue
              let all = true
              let seen = false
              doc.nodesBetween(from, to, (node) => {
                if (!node.isText) return true
                seen = true
                if (!type.isInSet(node.marks)) all = false
                return true
              })
              if (seen && all) active.push(name)
            }
            const aligns = new Set<string>()
            doc.nodesBetween(from, to, (node) => {
              if (node.type.name === 'paragraph' || node.type.name === 'heading') aligns.add(node.attrs.align === 'center' || node.attrs.align === 'right' ? node.attrs.align : 'left')
              return true
            })
            if (!aligns.size && ($from.parent.type.name === 'paragraph' || $from.parent.type.name === 'heading')) {
              aligns.add($from.parent.attrs.align === 'center' || $from.parent.attrs.align === 'right' ? $from.parent.attrs.align : 'left')
            }
            const align = aligns.size === 1 ? [...aligns][0] as 'left' | 'center' | 'right' : undefined
            // 颜色:每个文本片段都带同一个值才算(半段红半段默认 = 不显示当前色)。
            const uniform = (mark: string, attr: string): string | undefined => {
              const type = view.state.schema.marks[mark]
              if (!type) return undefined
              const vals = new Set<string>()
              doc.nodesBetween(from, to, (node) => {
                if (node.isText) vals.add(String(type.isInSet(node.marks)?.attrs[attr] ?? ''))
                return true
              })
              return vals.size === 1 ? [...vals][0] || undefined : undefined
            }
            report({ from, to, active, align, shape: toolbarShape(editContextOf(selection)), fg: uniform('amadeusColor', 'color'), bg: uniform('amadeusBg', 'bg'), left: (a.left + b.left) / 2, top: Math.min(a.top, b.top), bottom: Math.max(a.bottom, b.bottom), kind: spans ? translate('wikiac.multiBlocks') : blockLabel(chain) })
    }
    return new Plugin({
      key: toolbarDismissKey,
      state: {
        init: () => false,
        apply: (tr, prev, oldState, newState) => (tr.getMeta(toolbarDismissKey) ? true : prev && newState.selection.eq(oldState.selection)),
      },
      props: {
        handleDOMEvents: {
          mousedown: (view, e) => {
            if (e.button !== 0) return false
            held = true
            report(null)
            // 松手在窗口外收不到 mouseup:窗口失焦(非捕获 —— 捕获期会收到页内任何元素的 blur)也算松手。
            const release = (): void => {
              window.removeEventListener('mouseup', release, true)
              window.removeEventListener('pointercancel', release, true)
              window.removeEventListener('blur', release)
              held = false
              // 等 PM 自己的 mouseup / selectionchange 把最终选区落进 state 再算(它们与这里同在这一拍)。
              setTimeout(() => { if (!view.isDestroyed) compute(view) }, 0)
            }
            window.addEventListener('mouseup', release, true)
            window.addEventListener('pointercancel', release, true)
            window.addEventListener('blur', release)
            return false
          },
        },
      },
      view: () => ({ update: compute }),
    })
  })
}
