// The markdown BlockType: a per-block Milkdown (WYSIWYG) editor.
// Milkdown is built on ProseMirror + remark, so a block's content serializes back to
// markdown through the SAME AST the compiler speaks — no lossy export into main.md.
//
// Editing model (per user spec):
//  - Enter           → native in-block newline (NEVER creates a block)
//  - Shift+Enter     → create a new block below and focus it
//  - Backspace at start of an empty block → delete it, focus the previous
//  - ArrowUp/Down past the top/bottom line → move the caret to the neighbour
//  - Mod+Shift+Up/Down → reorder the block within its column
//  - "/" at line start or after a space → slash menu (filterable)
//  - paste/drop an image → save under the page's .amadeus/ and embed it
// Keys/paste go through editorViewOptionsCtx, which ProseMirror checks before plugin
// keymaps, so these overrides win over the commonmark defaults.
//
// Images are stored as PORTABLE page-relative links (![](.amadeus/x.png)); for display
// they are rewritten to the amadeus-asset:// protocol and back on save (see @amadeus-shared/assets).

import { useEffect, useRef, useState } from 'react'
import {
  Editor,
  defaultValueCtx,
  editorViewCtx,
  editorViewOptionsCtx,
  rootCtx,
} from '@milkdown/kit/core'
import { commonmark } from '@milkdown/kit/preset/commonmark'
import { gfm } from '@milkdown/kit/preset/gfm'
import { history } from '@milkdown/kit/plugin/history'
import { listener, listenerCtx } from '@milkdown/kit/plugin/listener'
import { $prose } from '@milkdown/kit/utils'
import { Plugin, Selection } from '@milkdown/kit/prose/state'
import { Decoration, DecorationSet, type EditorView } from '@milkdown/kit/prose/view'
import { Milkdown, MilkdownProvider, useEditor, useInstance } from '@milkdown/react'
import { joinRel, toAssetUrl, toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'
import { unescapeWikiOutsideFences } from '@amadeus-shared/links'
import { emptyDb, serializeDb } from '@amadeus-shared/db/schema'
import { amadeus } from '../../api'
import { getAttachmentPrefs } from '../../lib/attachments'
import { usePageStore } from '../../store/pageStore'
import { registerBlockType, type BlockEditorProps, type FocusPlace } from '../registry'
import { usePluginStore } from '../../plugins/pluginStore'
import { wikilinkPlugin } from './wikilink'
import { mentionSuggestPlugin, wikiSuggestPlugin, type WikiQuery } from './wikiAutocomplete'
import { getRecentPages } from '../../lib/recents'
import { WikiSuggest } from './WikiSuggest'
import { taskCheckboxPlugin } from './taskList'
import { calloutPlugin } from './callout'
import { math } from '@milkdown/plugin-math'
import 'katex/dist/katex.min.css' // LaTeX 数学公式渲染样式($…$ 行内 / $$…$$ 块,经 plugin-math + katex)

const PLACEHOLDER = '输入文字，或按 “/” 选择类型…'
// Sentinel slash scaffold: insert a cross-note embed cell from a copied `![[ ]]` ref.
const EMBED_SENTINEL = '\u0000__amadeus_embed__'
// 同族 sentinel：模板选择 / 图片选取 / 分栏（触发动作，不插入文本，\u0000 开头保证不与真实文本撞车）。
const TEMPLATE_SENTINEL = '\u0000__amadeus_template__'
const IMAGE_SENTINEL = '\u0000__amadeus_image__'
const COLUMN_SENTINEL = '\u0000__amadeus_column__'
const DATABASE_SENTINEL = '\u0000__amadeus_database__'

interface BlockKeys {
  insertAfter(content?: string): void
  deleteEmpty(): void
  mergePrev(): void
  arrow(dir: 'prev' | 'next'): void
  moveDir(dir: 'up' | 'down'): void
  /** 返回 false = 不接管 '/'(整篇宿主 PlainMarkdownEditor 用,让 '/' 正常落字);void = 接管弹菜单。 */
  slash(): boolean | void
}

function placeholderPlugin(text: string) {
  return $prose(
    () =>
      new Plugin({
        props: {
          decorations(state) {
            const { doc } = state
            const empty =
              doc.childCount === 1 && !!doc.firstChild?.isTextblock && doc.firstChild.content.size === 0
            if (!empty || !doc.firstChild) return null
            return DecorationSet.create(doc, [
              Decoration.node(0, doc.firstChild.nodeSize, { class: 'is-empty', 'data-placeholder': text }),
            ])
          },
        },
      }),
  )
}

function imageFromTransfer(dt: DataTransfer | null): File | null {
  if (!dt) return null
  for (const f of Array.from(dt.files)) if (f.type.startsWith('image/')) return f
  return null
}

function MilkdownInner({
  initial,
  onChange,
  keys,
  saveImage,
  saveFiles,
  onOpenWiki,
  getPageNames,
  focusPlace,
  onFocused,
  readOnly = false,
}: {
  initial: string
  onChange: (md: string) => void
  keys: BlockKeys
  saveImage: (file: File) => Promise<string | null>
  saveFiles: (files: File[]) => Promise<void>
  onOpenWiki: (name: string) => void
  getPageNames: () => string[]
  focusPlace: FocusPlace | null
  onFocused: () => void
  readOnly?: boolean
}) {
  const ready = useRef(false)
  const keysRef = useRef(keys)
  keysRef.current = keys
  const saveImageRef = useRef(saveImage)
  saveImageRef.current = saveImage
  const saveFilesRef = useRef(saveFiles)
  saveFilesRef.current = saveFiles
  const wikiRef = useRef(onOpenWiki)
  wikiRef.current = onOpenWiki
  const [wiki, setWiki] = useState<WikiQuery | null>(null)
  const [mention, setMention] = useState<WikiQuery | null>(null) // "@" 提及页面
  // Esc 闩锁:记住被关掉的那个 '@' 锚点,同锚点不再弹(否则下一击键 plugin 又 report → 关不掉)。
  const mentionDismissedFrom = useRef<number | null>(null)
  // handleKeyDown 闭包只建一次读不到 state → 用 ref 镜像弹窗开启态,供 '/' 分支避让。
  const wikiOpenRef = useRef(false)
  const mentionOpenRef = useRef(false)
  const [loading, getInstance] = useInstance()

  useEditor((root) => {
    const handleKeyDown = (view: EditorView, event: KeyboardEvent): boolean => {
      const { state } = view
      const sel = state.selection

      if (event.key === 'Enter') {
        if (event.shiftKey) {
          keysRef.current.insertAfter()
          return true
        }
        return false
      }
      if (event.key === 'Backspace') {
        if (!sel.empty) return false
        if (sel.$head.pos !== Selection.atStart(state.doc).$head.pos) return false
        if (state.doc.textContent.trim() === '') keysRef.current.deleteEmpty()
        else keysRef.current.mergePrev()
        return true
      }
      if (event.key === 'ArrowUp') {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
          keysRef.current.moveDir('up')
          return true
        }
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && view.endOfTextblock('up')) {
          keysRef.current.arrow('prev')
          return true
        }
        return false
      }
      if (event.key === 'ArrowDown') {
        if ((event.metaKey || event.ctrlKey) && event.shiftKey) {
          keysRef.current.moveDir('down')
          return true
        }
        if (!event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && view.endOfTextblock('down')) {
          keysRef.current.arrow('next')
          return true
        }
        return false
      }
      if (event.key === '/' && sel.empty) {
        // [[ / @ 弹窗开着时 '/' 是查询字符,不叠开 SlashMenu(否则一次 Enter 触发两个菜单)。
        if (wikiOpenRef.current || mentionOpenRef.current) return false
        const before = state.doc.textBetween(Math.max(0, sel.from - 1), sel.from)
        if (state.doc.textContent === '' || before === '' || before === ' ' || before === ' ') {
          return keysRef.current.slash() !== false
        }
      }
      return false
    }

    const insertImage = async (view: EditorView, file: File): Promise<void> => {
      const url = await saveImageRef.current(file)
      if (!url) return
      const imageType = view.state.schema.nodes.image
      if (!imageType) return
      view.dispatch(view.state.tr.replaceSelectionWith(imageType.create({ src: url })).scrollIntoView())
    }
    const handlePaste = (view: EditorView, event: ClipboardEvent): boolean => {
      const file = imageFromTransfer(event.clipboardData)
      if (file) {
        event.preventDefault()
        void insertImage(view, file)
        return true
      }
      // 非图片文件(PDF/压缩包/音视频…):存为附件 → 独立 ![[base]] 嵌入块(与拖入同形态)。
      const files = Array.from(event.clipboardData?.files ?? [])
      if (!files.length) return false
      event.preventDefault()
      void saveFilesRef.current(files)
      return true
    }
    // 文件拖入(含图片)统一交给编辑器级附件处理(AmadeusEditorView.onDrop),按笔记设置存放 → 不在块内内联,
    // 故此处不设 handleDrop(ProseMirror 默认对文件拖放不作插入,事件冒泡到编辑器容器被 preventDefault)。

    return Editor.make()
      .config((ctx) => {
        ctx.set(rootCtx, root)
        ctx.set(defaultValueCtx, initial)
        ctx.update(editorViewOptionsCtx, (prev) => ({
          ...prev,
          editable: () => !readOnly,
          handleKeyDown: readOnly ? undefined : handleKeyDown,
          handlePaste: readOnly ? undefined : handlePaste,
        }))
        ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
          if (!ready.current || readOnly) return
          // 新打的 [[链接]] 在重解析成 wikilink 节点前仍是纯文本,remark 序列化会把它转义成 \[\[ ——
          // 索引的 /\[\[…\]\]/ 就永远抽不到(后加双链全部失联,反链/关系图空)。落盘前统一去转义。
          onChange(unescapeWikiOutsideFences(markdown))
        })
      })
      .use(commonmark)
      .use(gfm)
      .use(math)
      .use(history)
      .use(listener)
      .use(placeholderPlugin(PLACEHOLDER))
      .use(wikilinkPlugin((name) => wikiRef.current(name)))
      .use(wikiSuggestPlugin((q) => { wikiOpenRef.current = !!q; setWiki(q) }))
      .use(mentionSuggestPlugin((q) => {
        if (!q) {
          mentionDismissedFrom.current = null
          mentionOpenRef.current = false
          setMention(null)
          return
        }
        if (mentionDismissedFrom.current === q.from) { mentionOpenRef.current = false; return }
        mentionOpenRef.current = true
        setMention(q)
      }))
      .use(taskCheckboxPlugin())
      .use(calloutPlugin())
  })

  useEffect(() => {
    const id = requestAnimationFrame(() => {
      ready.current = true
    })
    return () => cancelAnimationFrame(id)
  }, [])

  useEffect(() => {
    if (focusPlace == null || loading) return
    const editor = getInstance()
    if (!editor) return
    editor.action((ctx) => {
      const view = ctx.get(editorViewCtx)
      const target =
        focusPlace === 'end' ? Selection.atEnd(view.state.doc) : Selection.atStart(view.state.doc)
      view.focus()
      view.dispatch(view.state.tr.setSelection(target).scrollIntoView())
    })
    onFocused()
  }, [focusPlace, loading, getInstance, onFocused])

  const pickWiki = (name: string): void => {
    const w = wiki
    if (w) {
      const editor = getInstance()
      editor?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.insertText(`${name}]]`, w.from, w.to))
        view.focus()
      })
    }
    setWiki(null)
  }

  // @ 提及:把 "@query"(含 @ 本身)整体替换成 [[name]] 双链。
  const pickMention = (name: string): void => {
    const m = mention
    if (m) {
      const editor = getInstance()
      editor?.action((ctx) => {
        const view = ctx.get(editorViewCtx)
        view.dispatch(view.state.tr.insertText(`[[${name}]]`, m.from - 1, m.to))
        view.focus()
      })
    }
    setMention(null)
  }

  // @ 候选:最近打开的页面排最前(宿主经 setRecentsProvider 注入),其余页面跟后;空查询即按此序展示。
  const mentionPageNames = (): string[] => {
    const all = getPageNames()
    const inVault = new Set(all)
    const rec = getRecentPages().filter((p) => inVault.has(p))
    const recSet = new Set(rec)
    return [...rec, ...all.filter((p) => !recSet.has(p))]
  }

  return (
    <>
      <Milkdown />
      {wiki && !readOnly && (
        <WikiSuggest
          query={wiki.query}
          left={wiki.left}
          top={wiki.top}
          getPageNames={getPageNames}
          onPick={pickWiki}
          onClose={() => setWiki(null)}
        />
      )}
      {!wiki && mention && !readOnly && (
        <WikiSuggest
          query={mention.query}
          left={mention.left}
          top={mention.top}
          getPageNames={mentionPageNames}
          onPick={pickMention}
          allowCreate={false}
          onClose={() => {
            mentionDismissedFrom.current = mention.from // Esc:同一 '@' 不再弹
            mentionOpenRef.current = false
            setMention(null)
          }}
        />
      )}
    </>
  )
}

export function MarkdownBlock({
  blockId,
  content,
  pagePath,
  onChange,
  onInsertAfter,
  onDeleteEmpty,
  onMergePrev,
  onArrowOut,
  onMoveDir,
  focusPlace,
  onFocused,
  requestSelfFocus,
  onOpenWiki,
  onInsertEmbed,
  getPageNames,
  readOnly = false,
}: BlockEditorProps) {
  const pageDir = pagePath.split('/').slice(0, -1).join('/')
  const emitted = useRef(content)
  const [rev, setRev] = useState(0)
  const [slashOpen, setSlashOpen] = useState(false)

  useEffect(() => {
    if (content !== emitted.current) {
      emitted.current = content
      setRev((r) => r + 1)
    }
  }, [content])

  // The editor speaks DISPLAY markdown (protocol image urls); we store the PORTABLE form.
  const handleChange = (displayMd: string): void => {
    const stored = toStoredMarkdown(displayMd, pageDir)
    emitted.current = stored
    onChange(stored)
  }

  const saveImage = async (file: File): Promise<string | null> => {
    if (!pagePath) return null
    try {
      const bytes = new Uint8Array(await file.arrayBuffer())
      // 粘贴图片同样遵循 设置→笔记 的附件存放位置(旧 saveAsset 恒写 .amadeus/)。
      const { opts } = await getAttachmentPrefs()
      const { pageRel } = await amadeus.saveAttachment(pagePath, file.name || 'pasted.png', bytes, opts)
      return toAssetUrl(joinRel(pageDir, pageRel))
    } catch {
      return null
    }
  }

  /** 粘贴的非图片文件:逐个存附件,成一串 ![[base]] 嵌入块(保持粘贴顺序)。 */
  const saveFiles = async (files: File[]): Promise<void> => {
    if (!pagePath) return
    const mds: string[] = []
    for (const f of files) {
      try {
        const bytes = new Uint8Array(await f.arrayBuffer())
        const { opts } = await getAttachmentPrefs()
        const { base } = await amadeus.saveAttachment(pagePath, f.name || 'file', bytes, opts)
        mds.push(`![[${base}]]`)
      } catch { /* 保存失败静默跳过 */ }
    }
    if (!mds.length) return
    if (content.trim() === '') {
      onChange(mds[0])
      if (mds.length > 1) usePageStore.getState().insertBlocksAfter(blockId, mds.slice(1))
    } else {
      usePageStore.getState().insertBlocksAfter(blockId, mds)
    }
  }

  const keys: BlockKeys = {
    insertAfter: onInsertAfter,
    deleteEmpty: onDeleteEmpty,
    mergePrev: onMergePrev,
    arrow: onArrowOut,
    moveDir: onMoveDir,
    slash: () => setSlashOpen(true),
  }

  const applySlash = async (scaffold: string): Promise<void> => {
    setSlashOpen(false)
    if (scaffold === TEMPLATE_SENTINEL) {
      // 宿主壳(amadeusOverlays)监听该事件弹模板选择器;独立版未挂监听则静默无事。
      window.dispatchEvent(new CustomEvent('amadeus:template-picker', {
        detail: { afterId: blockId, emptyBlock: content.trim() === '' },
      }))
      return
    }
    if (scaffold === IMAGE_SENTINEL) {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.onchange = () => {
        const f = input.files?.[0]
        if (!f) return
        void (async () => {
          try {
            const bytes = new Uint8Array(await f.arrayBuffer())
            const { opts } = await getAttachmentPrefs()
            const { base } = await amadeus.saveAttachment(pagePath, f.name || 'image.png', bytes, opts)
            const md = `![[${base}]]` // 与拖入(开预览)同形态:embed-image 块
            if (content.trim() === '') onChange(md)
            else onInsertAfter(md)
          } catch { /* 保存失败静默跳过 */ }
        })()
      }
      input.click()
      return
    }
    if (scaffold === DATABASE_SENTINEL) {
      // 新建独立 .db 文件(笔记同目录,uniqueName 撞名 -1/-2)→ 插入 ![[base]] 嵌入块。
      void (async () => {
        try {
          const bytes = new TextEncoder().encode(serializeDb(emptyDb('未命名数据库')))
          const { base } = await amadeus.saveAttachment(pagePath, '未命名数据库.db', bytes, { mode: 'same', folder: '' })
          const md = `![[${base}]]`
          if (content.trim() === '') onChange(md)
          else onInsertAfter(md)
        } catch { /* 创建失败静默跳过 */ }
      })()
      return
    }
    if (scaffold === COLUMN_SENTINEL) {
      const st = usePageStore.getState()
      const nid = st.insertBlockAfter(blockId, undefined, '')
      if (nid) st.splitToColumn(nid, 'right')
      return
    }
    if (scaffold === EMBED_SENTINEL) {
      // Insert a cross-note embed from a copied `![[basename]]` (or a bare basename).
      if (!onInsertEmbed) return
      let target = ''
      try {
        const t = await navigator.clipboard.readText()
        const m = /!\[\[([^\]\n]+)\]\]/.exec(t)
        target = (m ? m[1] : t).trim()
      } catch {
        /* clipboard unavailable */
      }
      if (target) onInsertEmbed(target)
      return
    }
    if (content.trim() === '') {
      onChange(scaffold)
      requestSelfFocus('end')
    } else {
      onInsertAfter(scaffold)
    }
  }

  return (
    <div className="md-block">
      <MilkdownProvider key={rev}>
        <MilkdownInner
          initial={toDisplayMarkdown(content, pageDir)}
          onChange={handleChange}
          keys={keys}
          saveImage={saveImage}
          saveFiles={saveFiles}
          onOpenWiki={onOpenWiki}
          getPageNames={getPageNames}
          focusPlace={focusPlace}
          onFocused={onFocused}
          readOnly={readOnly}
        />
      </MilkdownProvider>
      {slashOpen && !readOnly && <SlashMenu onPick={applySlash} onClose={() => setSlashOpen(false)} />}
    </div>
  )
}

/** 整篇 markdown 的独立 Milkdown 宿主(工作区外部 .md 编辑用):字符串进出,零 vault/pageStore 依赖。
 *  块级机关全部降级:无 slash 菜单('/' 正常落字,markdown 输入规则仍生效)、粘贴图片/文件忽略、
 *  双链建议无候选(输入 [[ 仅作纯文本)。资源不做 display/stored 变换 —— 外部文件原文往返无损。 */
export function PlainMarkdownEditor({ initial, onChange, readOnly = false }: {
  initial: string
  onChange: (md: string) => void
  readOnly?: boolean
}) {
  const noop = (): void => {}
  const keys: BlockKeys = {
    insertAfter: noop, deleteEmpty: noop, mergePrev: noop, arrow: noop, moveDir: noop,
    slash: () => false,
  }
  return (
    <div className="md-block md-plain">
      <MilkdownProvider>
        <MilkdownInner
          initial={initial}
          onChange={onChange}
          keys={keys}
          saveImage={async () => null}
          saveFiles={async () => {}}
          onOpenWiki={noop}
          getPageNames={() => []}
          focusPlace={null}
          onFocused={noop}
          readOnly={readOnly}
        />
      </MilkdownProvider>
    </div>
  )
}

interface SlashItem {
  key: string
  label: string
  hint: string
  icon: string
  group: string
  scaffold: string
  kw: string
}

const SLASH_ITEMS: SlashItem[] = [
  { key: 'text', label: '文本', hint: '', icon: '¶', group: '基础', scaffold: '', kw: 'text 文本 paragraph zhengwen 正文' },
  { key: 'h1', label: '标题 1', hint: '#', icon: 'H1', group: '基础', scaffold: '# ', kw: 'h1 heading 标题 biaoti title 大标题' },
  { key: 'h2', label: '标题 2', hint: '##', icon: 'H2', group: '基础', scaffold: '## ', kw: 'h2 heading 标题 biaoti 中标题' },
  { key: 'h3', label: '标题 3', hint: '###', icon: 'H3', group: '基础', scaffold: '### ', kw: 'h3 heading 标题 biaoti 小标题' },
  { key: 'ul', label: '无序列表', hint: '-', icon: '•', group: '列表', scaffold: '- ', kw: 'ul bullet list 无序 列表 liebiao' },
  { key: 'ol', label: '有序列表', hint: '1.', icon: '1.', group: '列表', scaffold: '1. ', kw: 'ol number list 有序 列表 编号' },
  { key: 'todo', label: '待办', hint: '[ ]', icon: '☑', group: '列表', scaffold: '- [ ] ', kw: 'todo task check 待办 任务 复选框 daiban renwu' },
  { key: 'quote', label: '引用', hint: '>', icon: '❝', group: '高级', scaffold: '> ', kw: 'quote 引用 yinyong blockquote' },
  { key: 'code', label: '代码块', hint: '```', icon: '</>', group: '高级', scaffold: '```\n\n```', kw: 'code 代码 daima codeblock' },
  { key: 'table', label: '表格', hint: '⊞', icon: '⊞', group: '高级', scaffold: '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |', kw: 'table 表格 biaoge grid 网格' },
  { key: 'divider', label: '分割线', hint: '---', icon: '—', group: '高级', scaffold: '---\n\n', kw: 'divider hr 分割线 分隔 fenge' },
  { key: 'math', label: '数学公式', hint: '$$', icon: '∑', group: '高级', scaffold: '$$\n\n$$', kw: 'math latex katex formula 数学 公式 gongshi' },
  { key: 'wikilink', label: '链接笔记', hint: '[[', icon: '⧉', group: '高级', scaffold: '[[', kw: 'link wiki note 链接 笔记 双链 lianjie shuanglian' },
  { key: 'image', label: '图片', hint: '', icon: '🖼', group: '高级', scaffold: IMAGE_SENTINEL, kw: 'image picture photo 图片 tupian 插图' },
  { key: 'columns', label: '分栏', hint: '⫿', icon: '⫿', group: '高级', scaffold: COLUMN_SENTINEL, kw: 'column split 分栏 分列 fenlan 并排' },
  { key: 'database', label: '数据库', hint: '.db', icon: '𝄜', group: '高级', scaffold: DATABASE_SENTINEL, kw: 'database db 数据库 shujuku 表格 base notion' },
  { key: 'template', label: '模板', hint: 'templates/', icon: '⧫', group: '高级', scaffold: TEMPLATE_SENTINEL, kw: 'template 模板 muban 套用' },
  { key: 'embed', label: '嵌入块引用', hint: '![[ ]]', icon: '↪', group: '高级', scaffold: EMBED_SENTINEL, kw: 'embed 嵌入 引用 transclude block 块 qianru yinyong 复用' },
]

function SlashMenu({ onPick, onClose }: { onPick: (scaffold: string) => void; onClose: () => void }) {
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const pluginSlash = usePluginStore((s) => s.slashItems)

  const allItems: SlashItem[] = [
    ...SLASH_ITEMS,
    ...pluginSlash.map(({ item }) => ({
      key: item.id,
      label: item.label,
      hint: item.hint ?? '',
      icon: item.icon ?? '·',
      group: item.group ?? '插件',
      scaffold: item.scaffold,
      kw: `${item.keywords ?? ''} ${item.label}`,
    })),
  ]

  const q = query.trim().toLowerCase()
  const items = q
    ? allItems.filter((it) => it.kw.toLowerCase().includes(q) || it.label.toLowerCase().includes(q))
    : allItems

  useEffect(() => {
    setActive(0)
  }, [query])

  useEffect(() => {
    const stop = (e: KeyboardEvent): void => {
      e.preventDefault()
      e.stopPropagation()
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        stop(e)
        onClose()
      } else if (e.key === 'ArrowDown') {
        stop(e)
        setActive((a) => Math.min(a + 1, items.length - 1))
      } else if (e.key === 'ArrowUp') {
        stop(e)
        setActive((a) => Math.max(a - 1, 0))
      } else if (e.key === 'Enter') {
        stop(e)
        const it = items[active]
        if (it) onPick(it.scaffold)
        else onClose()
      } else if (e.key === 'Backspace') {
        stop(e)
        setQuery((s) => s.slice(0, -1))
      } else if (e.key.length === 1 && !e.metaKey && !e.ctrlKey && !e.altKey) {
        stop(e)
        setQuery((s) => s + e.key)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [items, active, onPick, onClose])

  const renderItem = (it: SlashItem, i: number) => (
    <button
      key={it.key}
      className="slash-item"
      data-active={i === active || undefined}
      onMouseEnter={() => setActive(i)}
      onClick={() => onPick(it.scaffold)}
      role="menuitem"
    >
      <span className="slash-icon" aria-hidden>
        {it.icon}
      </span>
      <span className="slash-label">{it.label}</span>
      <span className="slash-hint">{it.hint}</span>
    </button>
  )

  // Browsing (no query) → grouped with section labels; filtering → flat list.
  const grouped: Array<{ name: string; rows: Array<{ it: SlashItem; idx: number }> }> = []
  items.forEach((it, idx) => {
    let g = grouped.find((x) => x.name === it.group)
    if (!g) {
      g = { name: it.group, rows: [] }
      grouped.push(g)
    }
    g.rows.push({ it, idx })
  })

  return (
    <>
      <div className="slash-backdrop" onMouseDown={onClose} />
      <div className="slash-menu" role="menu">
        {query && <div className="slash-query">/{query}</div>}
        {items.length === 0 && <div className="slash-empty">无匹配项</div>}
        <div className="slash-scroll">
          {q
            ? items.map((it, i) => renderItem(it, i))
            : grouped.map((g) => (
                <div key={g.name} className="slash-group">
                  <div className="slash-group-label">{g.name}</div>
                  {g.rows.map(({ it, idx }) => renderItem(it, idx))}
                </div>
              ))}
        </div>
        {items.length > 0 && (
          <div className="slash-foot">
            <span>↑↓ 选择</span>
            <span>↵ 插入</span>
            <span>esc 关闭</span>
          </div>
        )}
      </div>
    </>
  )
}

registerBlockType({ id: 'markdown', fileExtensions: ['.md'], Editor: MarkdownBlock })
