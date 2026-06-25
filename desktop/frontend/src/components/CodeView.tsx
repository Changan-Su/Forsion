/**
 * 代码/文本只读视图 —— CodeMirror 6(对齐 AionUI 的 CodeEditor):行号、语法高亮、
 * 搜索(Cmd+F)、代码折叠、可选自动换行。语言按文件名/语言名经 @codemirror/language-data
 * 动态加载(自动分包);>30KB 关高亮免卡。供 WorkspaceFilePreview 懒加载使用。
 */
import React, { useEffect, useMemo, useState } from 'react'
import CodeMirror from '@uiw/react-codemirror'
import { EditorView } from '@codemirror/view'
import type { Extension } from '@codemirror/state'
import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { useIsDark } from '../services/useIsDark'

const HIGHLIGHT_MAX = 30_000 // >30KB 不挂语言扩展(免卡),对齐 AionUI shouldDisableHighlighting

const CodeView: React.FC<{ value: string; fileName?: string; language?: string; wrap?: boolean }> = ({ value, fileName, language, wrap }) => {
  const dark = useIsDark()
  const [langExt, setLangExt] = useState<Extension[]>([])
  const disableHighlight = value.length > HIGHLIGHT_MAX

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

  const extensions = useMemo<Extension[]>(() => (wrap ? [EditorView.lineWrapping, ...langExt] : langExt), [wrap, langExt])

  return (
    <CodeMirror
      className="wsfile-cm"
      value={value}
      height="100%"
      theme={dark ? 'dark' : 'light'}
      readOnly
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
