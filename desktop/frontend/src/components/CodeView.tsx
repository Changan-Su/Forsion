/**
 * 代码/文本视图 —— CodeMirror 6(对齐 AionUI 的 CodeEditor):行号、语法高亮、
 * 搜索(Cmd+F)、代码折叠、可选自动换行。语言按文件名/语言名经 @codemirror/language-data
 * 动态加载(自动分包);>30KB 关高亮免卡。默认只读(供 WorkspaceFilePreview 懒加载预览);
 * 传 editable + onChange 则可编辑(Coding Space 的代码面板)。
 */
import React, { useEffect, useMemo, useRef, useState } from 'react'
import CodeMirror, { type ReactCodeMirrorRef } from '@uiw/react-codemirror'
import { Decoration, EditorView } from '@codemirror/view'
import { RangeSetBuilder, type Extension } from '@codemirror/state'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { useIsDark } from '../services/useIsDark'

const HIGHLIGHT_MAX = 30_000 // >30KB 不挂语言扩展(免卡),对齐 AionUI shouldDisableHighlighting

/** 聊天行号引用的落点:滚到 line(–end)并整行高亮(GitHub #L 式,视图存续期间常驻);
 *  nonce 变化 = 用户滚走后又点了同一条引用,重新居中。行号越界一律夹到文档边界,绝不抛。 */
export interface FocusLine { line: number; end?: number; nonce?: number }

const CodeView: React.FC<{ value: string; fileName?: string; language?: string; wrap?: boolean; editable?: boolean; onChange?: (v: string) => void; autoScroll?: boolean; focusLine?: FocusLine | null }> = ({ value, fileName, language, wrap, editable, onChange, autoScroll, focusLine }) => {
  const dark = useIsDark()
  const [langExt, setLangExt] = useState<Extension[]>([])
  const disableHighlight = value.length > HIGHLIGHT_MAX
  const cmRef = useRef<ReactCodeMirrorRef>(null)

  // 落地那一刻多挂一个 .cm-citepulse 放一次提醒动画,~1.4s 后摘掉。**必须摘**:CodeMirror 视口
  // 虚拟化,高亮行滚出再滚回是**新建 DOM**,类还留着就会重放动画(滚一下闪一下 = 上一轮被打回的
  // 那种「闪烁」观感)。摘掉后 .cm-citeline 的常驻样式与动画末帧一致,收尾无跳变。
  const [pulse, setPulse] = useState(false)
  useEffect(() => {
    if (!focusLine) { setPulse(false); return }
    setPulse(true)
    const t = setTimeout(() => setPulse(false), 1400)
    return () => clearTimeout(t)
  }, [focusLine])

  // 高亮行装饰:decorations.compute 在 doc 变化时重算,行号夹界后逐行铺 line decoration。
  const citeExt = useMemo<Extension[]>(() => {
    if (!focusLine) return []
    const { line, end } = focusLine
    const cls = pulse ? 'cm-citeline cm-citepulse' : 'cm-citeline'
    return [EditorView.decorations.compute(['doc'], (state) => {
      const b = new RangeSetBuilder<Decoration>()
      const from = Math.min(Math.max(1, Math.trunc(line)), state.doc.lines)
      const to = Math.min(Math.max(from, Math.trunc(end ?? from)), state.doc.lines)
      for (let n = from; n <= to; n++) b.add(state.doc.line(n).from, state.doc.line(n).from, Decoration.line({ class: cls }))
      return b.finish()
    })]
  }, [focusLine, pulse])

  // 滚动居中:视图由 react-codemirror 在自己的 effect 里异步创建,且首次 measure(height:100%)
  // 还没跑完时 scrollIntoView 会落错位置 —— rAF 轮询到视图就绪再派发(上限 ~20 帧,拿不到就算了)。
  useEffect(() => {
    if (!focusLine) return
    let tries = 0
    let raf = 0
    const go = (): void => {
      const view = cmRef.current?.view
      if (!view) {
        if (++tries < 20) raf = requestAnimationFrame(go)
        return
      }
      const ln = Math.min(Math.max(1, Math.trunc(focusLine.line)), view.state.doc.lines)
      view.dispatch({ effects: EditorView.scrollIntoView(view.state.doc.line(ln).from, { y: 'center' }) })
    }
    raf = requestAnimationFrame(go)
    return () => cancelAnimationFrame(raf)
  }, [focusLine])

  // 流式生成时钉在底部(跟随最新一行,AI Studio 式)。
  useEffect(() => {
    if (!autoScroll) return
    const view = cmRef.current?.view
    if (view) view.dispatch({ effects: EditorView.scrollIntoView(Math.max(0, view.state.doc.length - 1)) })
  }, [value, autoScroll])

  useEffect(() => {
    let cancelled = false
    if (disableHighlight) { setLangExt([]); return }
    const desc =
      (language ? LanguageDescription.matchLanguageName(languages, language, true) : null) ||
      (fileName ? LanguageDescription.matchFilename(languages, fileName) : null)
    if (!desc) { setLangExt([]); return }
    void desc.load().then((support) => { if (!cancelled) setLangExt([support]) }).catch(() => { if (!cancelled) setLangExt([]) })
    return () => { cancelled = true }
  }, [language, fileName, disableHighlight])

  const extensions = useMemo<Extension[]>(() => [...(wrap ? [EditorView.lineWrapping] : []), ...langExt, ...citeExt], [wrap, langExt, citeExt])

  return (
    <CodeMirror
      ref={cmRef}
      className="wsfile-cm"
      value={value}
      height="100%"
      theme={dark ? 'dark' : 'light'}
      readOnly={!editable}
      editable={editable}
      onChange={editable ? onChange : undefined}
      extensions={extensions}
      basicSetup={{
        lineNumbers: true,
        highlightActiveLine: true,
        highlightActiveLineGutter: true,
        foldGutter: !disableHighlight,
        searchKeymap: true,
      }}
    />
  )
}

export default CodeView
