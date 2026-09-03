// v4 统一编辑器的标题小节折叠(AFFiNE 对齐,2026-08-14 用户拍板:**会话内状态,不落盘**)。
// 折叠 = 纯装饰:标题后的小节(到下一个 level ≤ 本级的标题,或文末)整段 display:none;
// 锚 = 标题节点的文档 pos(**任意深度**:顶层、卡内、分栏格内都算),随事务 mapping 存活,
// 标题被删/降不成标题即丢。小节边界在标题**自己那个容器**里算,不跨出去。序列化零影响,
// md 原样;编辑器重建(切源码/重开笔记)后全展开 —— 这是拍板的取舍,不是缺陷。
// 交互两个入口:hover 把手的折叠钮(blockLayer 渲染,调这里的 API)+ 折叠标题行首的常驻
// 展开钮(widget 装饰,不折叠时不出现,不占别的行的版面)。
import { $prose } from '@milkdown/kit/utils'
import { Plugin, PluginKey, Selection } from '@milkdown/kit/prose/state'
import type { EditorState } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet } from '@milkdown/kit/prose/view'
import type { EditorView } from '@milkdown/kit/prose/view'
import type { Node as ProseNode } from '@milkdown/kit/prose/model'
import type { MilkdownPlugin } from '@milkdown/kit/ctx'
import { registerMessages, translate } from '../../i18n'

registerMessages({
  'headfold.expandSection': { zh: '展开小节', en: 'Expand section' },
})

interface FoldState {
  folded: number[]
  decos: DecorationSet
}

export const headingFoldKey = new PluginKey<FoldState>('AMX_HEADING_FOLD')

/** 标题在**它自己那个容器**里的落点。⚠️ 容器不一定是 doc:卡(amadeusCanvasCard)、
 *  分栏格里的标题一样要能折 —— 2026-08-20 用户报「各级别标题还是没能折叠」,探针实测
 *  顶层标题出钮、卡内标题不出钮,病根就是这里原本只按 doc 的直接子节点找 index。
 *  小节的边界也随之只在**同一个容器内**算:卡里的 `# 甲` 折不到卡外面去,天然正确。 */
interface HeadingSite {
  parent: ProseNode
  index: number
  /** 容器内容起点(顶层容器 = 0);容器内第 i 个子节点的前位 = base + 前 i 个的 nodeSize 之和 */
  base: number
}

function headingSiteAt(doc: ProseNode, pos: number): HeadingSite | null {
  // ⚠️ 边界守卫不能省:folded 锚是 mapping 过来的,可能落到范围外或节点当中,resolve 会抛。
  if (!Number.isInteger(pos) || pos < 0 || pos > doc.content.size) return null
  let $p
  try {
    $p = doc.resolve(pos)
  } catch {
    return null
  }
  // nodeAfter 非空即说明 pos 正落在容器的子节点边界上(落在文本块中间时 parent 是文本块,
  // 那里不可能有 heading 直系子节点),所以这一条同时兼作「pos 是块前位」的判据。
  const node = $p.nodeAfter
  if (!node || node.type.name !== 'heading') return null
  return { parent: $p.parent, index: $p.index(), base: $p.start() }
}

/** 容器内每个子节点的前位。 */
function childPositions(site: HeadingSite): number[] {
  const out: number[] = []
  let at = site.base
  site.parent.forEach((n) => {
    out.push(at)
    at += n.nodeSize
  })
  return out
}

/** 小节末 index:从标题往后,到下一个 level ≤ 本级的标题(或容器末)为止;
 *  空小节(紧跟同级/更高级标题或容器末)返回 null = 没东西可折。 */
function sectionEndIndex(parent: ProseNode, headIndex: number): number | null {
  const head = parent.child(headIndex)
  const level = Number(head.attrs.level) || 1
  let end = headIndex
  for (let i = headIndex + 1; i < parent.childCount; i++) {
    const n = parent.child(i)
    if (n.type.name === 'heading' && (Number(n.attrs.level) || 1) <= level) break
    end = i
  }
  return end === headIndex ? null : end
}

function build(doc: ProseNode, folded: number[]): DecorationSet {
  const decos: Decoration[] = []
  for (const fp of folded) {
    const site = headingSiteAt(doc, fp)
    if (!site) continue
    const end = sectionEndIndex(site.parent, site.index)
    if (end == null) continue
    const at = childPositions(site)
    decos.push(Decoration.node(fp, fp + site.parent.child(site.index).nodeSize, { class: 'amx-heading-folded' }))
    for (let i = site.index + 1; i <= end; i++)
      decos.push(Decoration.node(at[i], at[i] + site.parent.child(i).nodeSize, { class: 'amx-fold-hidden' }))
    decos.push(
      Decoration.widget(
        fp + 1,
        (view: EditorView, getPos: () => number | undefined) => {
          const b = document.createElement('button')
          b.type = 'button'
          b.className = 'amx-fold-caret'
          b.textContent = '▸'
          b.contentEditable = 'false'
          b.title = translate('headfold.expandSection')
          b.addEventListener('mousedown', (e) => {
            e.preventDefault()
            e.stopPropagation()
            const at = getPos()
            if (at == null) return
            // widget 在标题内容首 → 标题节点前位 = 它**所在那一层**的 before。
            // ⚠️ 不能写死 before(1):卡内标题的 depth 是 2,写死 1 拿到的是**卡**的前位,
            //    展开钮当场变哑巴(2026-08-20 与折叠钮不出现同一批修)。
            const $at = view.state.doc.resolve(at)
            toggleFoldAt(view, $at.before($at.depth))
          })
          return b
        },
        { side: -1, ignoreSelection: true, key: `amxfold:${fp}` },
      ),
    )
  }
  return DecorationSet.create(doc, decos)
}

export function toggleFoldAt(view: EditorView, headingPos: number): void {
  view.dispatch(view.state.tr.setMeta(headingFoldKey, { toggle: headingPos }))
}

/** 把手折叠钮的三态:null=非标题/空小节(不显示钮) | 'foldable' | 'folded'。
 *  空小节先于 folded 判(Codex P2:被外部编辑掏空的小节不许报 'folded' 幽灵态)。 */
export function foldStateAt(view: EditorView, pos: number): 'foldable' | 'folded' | null {
  const st = headingFoldKey.getState(view.state)
  const site = headingSiteAt(view.state.doc, pos)
  if (!site || sectionEndIndex(site.parent, site.index) == null) return null
  return st?.folded.includes(pos) ? 'folded' : 'foldable'
}

/** 折叠产生的隐藏区间(顶层文档坐标,[start, after) = 首隐藏节点前位 → 末隐藏节点后位)。 */
export function hiddenRanges(doc: ProseNode, folded: number[]): Array<{ start: number; after: number }> {
  const out: Array<{ start: number; after: number }> = []
  for (const fp of folded) {
    const site = headingSiteAt(doc, fp)
    if (!site) continue
    const end = sectionEndIndex(site.parent, site.index)
    if (end == null) continue
    const at = childPositions(site)
    out.push({ start: at[site.index + 1], after: at[end] + site.parent.child(end).nodeSize })
  }
  return out
}

/** 折叠标题的小节末尾之后那个位置(顶层坐标);该标题没折叠或不可折叠返回 null。
 *  键盘层用它把「折叠态标题上回车」的新块插到隐藏区**之后** —— 插在紧邻处会直接掉进 display:none。 */
export function foldedSectionAfter(state: EditorState, headingPos: number): number | null {
  const st = headingFoldKey.getState(state)
  if (!st?.folded.includes(headingPos)) return null
  // ⚠️ 只能算**自己这一段**:hiddenRanges 按 folded 数组顺序产出(apply 是追加,不是文档序),
  //    「第一个 start > headingPos 的区间」可能是**别的**标题的隐藏区(先折 B 再折 A 即复现)。
  const rg = hiddenRanges(state.doc, [headingPos])[0]
  return rg ? rg.after : null
}

/** 某位置是否落在折叠隐藏区里(键盘层缩进前用它决定要不要先展开目标)。 */
export function isHiddenAt(state: EditorState, pos: number): number | null {
  const st = headingFoldKey.getState(state)
  if (!st?.folded.length) return null
  for (const fp of st.folded) {
    for (const rg of hiddenRanges(state.doc, [fp])) if (pos > rg.start && pos < rg.after) return fp
  }
  return null
}

export const headingFoldPlugins: MilkdownPlugin[] = [
  $prose(
    () =>
      new Plugin<FoldState>({
        key: headingFoldKey,
        state: {
          init: () => ({ folded: [], decos: DecorationSet.empty }),
          apply: (tr, prev) => {
            let folded = prev.folded
            if (tr.docChanged)
              // deleted 不等于真删:setBlockType/setNodeMarkup 整节点替换也报 deleted(Codex P2),
              // 映射位仍是顶层标题就保留(H1→H2 折叠不丢);真删的锚经下面标题校验淘汰。
              folded = folded
                .map((p) => tr.mapping.mapResult(p))
                .filter((r) => !r.deleted || headingSiteAt(tr.doc, r.pos) != null)
                .map((r) => r.pos)
            const meta = tr.getMeta(headingFoldKey) as { toggle?: number } | undefined
            if (meta?.toggle != null) {
              const p = meta.toggle
              folded = folded.includes(p) ? folded.filter((x) => x !== p) : [...folded, p]
            }
            // 只留「仍是顶层标题且小节非空」的锚(标题转段落=展开;小节被外部编辑掏空=展开,
            // 否则空小节留幽灵态,后续在标题下新打的内容会被旧状态当场隐藏 —— Codex P2)。
            folded = [...new Set(folded)].filter((p) => {
              const site = headingSiteAt(tr.doc, p)
              return site != null && sectionEndIndex(site.parent, site.index) != null
            })
            if (!tr.docChanged && !meta && folded === prev.folded) return prev
            return { folded, decos: build(tr.doc, folded) }
          },
        },
        // 光标绝不许停在隐藏区里(Codex P1:方向键能走进 display:none 的段落,继续输入=
        // 不可见编辑)。事后矫正而非 filterTransaction:覆盖一切入径(方向键/Cmd+End/程序化)。
        // 只管空选区光标;跨隐藏区的范围选择(Cmd+A/Shift 扩选)是合法操作不动。
        appendTransaction: (_trs, oldState, state) => {
          const st = headingFoldKey.getState(state)
          if (!st?.folded.length || !state.selection.empty) return null
          const from = state.selection.from
          for (const rg of hiddenRanges(state.doc, st.folded)) {
            if (from <= rg.start || from >= rg.after) continue
            const dir = from >= oldState.selection.from ? 1 : -1
            let sel = Selection.near(state.doc.resolve(dir === 1 ? Math.min(rg.after, state.doc.content.size) : rg.start), dir)
            if (sel.from > rg.start && sel.from < rg.after)
              sel = Selection.near(state.doc.resolve(rg.start), -1) // 无处可去(隐藏区在文末):退回标题内
            return state.tr.setSelection(sel)
          }
          return null
        },
        props: {
          decorations(state) {
            return headingFoldKey.getState(state)?.decos ?? null
          },
        },
      }),
  ),
].flat()
