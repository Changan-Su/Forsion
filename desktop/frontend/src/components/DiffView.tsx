/**
 * unified diff → diff2html 渲染(懒加载;暗色加 d2h-dark-color-scheme)。
 * 独立小模块:文件预览与聊天流工具卡/审批卡共用——聊天路径 import 这里,
 * 不必拉上 WorkspaceFilePreview 的重顶层(Webview/pdf.js/framer-motion)。
 * 渲染失败回退裸 diff 文本(它本来就是文本,比报错框有用)。
 */
import React, { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { useIsDark } from '../services/useIsDark'
import 'diff2html/bundles/css/diff2html.min.css'

export const DiffView: React.FC<{ text: string; side: boolean }> = ({ text, side }) => {
  const dark = useIsDark()
  const [html, setHtml] = useState<string | null>(null)
  const [err, setErr] = useState(false)
  useEffect(() => {
    let cancelled = false
    setHtml(null); setErr(false)
    void (async () => {
      try {
        const d2h: any = await import('diff2html')
        const out: string = (d2h.html || d2h.default?.html)(text, { outputFormat: side ? 'side-by-side' : 'line-by-line', drawFileList: false, matching: 'lines' })
        if (!cancelled) setHtml(out)
      } catch { if (!cancelled) setErr(true) }
    })()
    return () => { cancelled = true }
  }, [text, side])
  if (err) return <pre className="wsfile-diff-raw">{text}</pre>
  if (html == null) return <Loader2 size={14} className="spin" style={{ color: 'var(--text-faint)', margin: 8 }} />
  return <div className={`wsfile-doc wsfile-diff${dark ? ' d2h-dark-color-scheme' : ''}`} dangerouslySetInnerHTML={{ __html: html }} />
}
