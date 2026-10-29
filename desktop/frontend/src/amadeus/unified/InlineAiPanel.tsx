/** 正文 AI 的预览面板(评审 G3-07),也是划线条上「翻译」和插件动作的结果卡。结果**先进预览**:流式显示,生成完才给
 *  「替换 / 插入下方 / 插入 / 丢弃」;点了才写(写法由宿主 UnifiedPage 经 inlineAi.applyAiResult 落成一个事务)。
 *  丢弃 / Esc = 文档一个字不动。宿主不给 onApply = **只读**(聊天、插件视图):只有「复制 / 重试 / 关闭」,点卡外面就收。
 *  纯展示 + 请求生命周期:请求怎么发(内置动作走 readTangu().complete,插件项走它自己的 run)由宿主给的 run 决定。
 *  样式在同目录 inlineAiPanel.css(聊天不加载 Amadeus 那份大样式表,所以单拎出来由本文件自己带)。 */
import { useEffect, useRef, useState, type ReactElement } from 'react'
import { Languages, Sparkles } from 'lucide-react'
import { OverlayAt } from '../lib/clampMenu'
import { registerMessages, useI18n } from '../../i18n'
import { TRANSLATE_LANGUAGES } from '../../translateTarget'
import type { AiApply } from './inlineAi'
import { Markdown } from '../../components/Markdown'
import './inlineAiPanel.css'

registerMessages({
  'inlineai.action.improve': { zh: '润色', en: 'Improve writing' },
  'inlineai.action.fix': { zh: '修正拼写与语法', en: 'Fix spelling and grammar' },
  'inlineai.action.shorter': { zh: '精简', en: 'Make shorter' },
  'inlineai.action.longer': { zh: '扩写', en: 'Make longer' },
  'inlineai.action.summarize': { zh: '总结', en: 'Summarize' },
  'inlineai.action.translate': { zh: '翻译', en: 'Translate' },
  'inlineai.action.continue': { zh: '续写', en: 'Continue writing' },
  'inlineai.action.custom': { zh: '自定义指令…', en: 'Custom instruction…' },
  'inlineai.label': { zh: 'AI 写作', en: 'AI writing' },
  'inlineai.placeholder': { zh: '告诉 Tangu 要写什么，留空则续写', en: 'Tell Tangu what to write, or leave empty to continue' },
  'inlineai.placeholderSel': { zh: '告诉 Tangu 怎么改选中的文字', en: 'Tell Tangu how to change the selection' },
  'inlineai.send': { zh: '生成', en: 'Generate' },
  'inlineai.generating': { zh: '正在生成…', en: 'Generating…' },
  'inlineai.stop': { zh: '停止', en: 'Stop' },
  'inlineai.replace': { zh: '替换', en: 'Replace' },
  'inlineai.insertBelow': { zh: '插入下方', en: 'Insert below' },
  'inlineai.insert': { zh: '插入', en: 'Insert' },
  'inlineai.discard': { zh: '丢弃', en: 'Discard' },
  'inlineai.retry': { zh: '重试', en: 'Try again' },
  'inlineai.hint': { zh: '预览：确认后才写入笔记', en: 'Preview: nothing is written until you confirm' },
  'inlineai.toolText': { zh: '模型写出了工具调用的样子，但这里什么都没有执行', en: 'The model wrote something that looks like a tool call, but nothing was run' },
  'inlineai.errEmptyResult': { zh: '没有生成任何内容', en: 'Nothing was generated' },
  'inlineai.unavailable': { zh: '这里用不了正文 AI', en: 'In-note AI is not available here' },
  'inlineai.targetChanged': { zh: '选中的文字在生成期间被改过，结果已插入到下方', en: 'The selection changed while generating, so the result was inserted below it' },
  'inlineai.copy': { zh: '复制', en: 'Copy' },
  'inlineai.copied': { zh: '已复制', en: 'Copied' },
  'inlineai.close': { zh: '关闭', en: 'Close' },
  'inlineai.targetLang': { zh: '目标语言', en: 'Target language' },
  'inlineai.byMt': { zh: '机器翻译 · {name}', en: 'Machine translation · {name}' },
})

/** model = 这次实际是谁出的结果(翻译才给;readTangu().complete 的返回值可以原样交回来)。 */
export type InlineAiRun = (instruction: string | undefined, onDelta: (d: string) => void, signal: AbortSignal) => Promise<{ text: string; toolCallText?: boolean; model?: { name: string; mt: boolean } }>

export function InlineAiPanel({ x, y, anchorTop, title, hasSelection, askFirst, run, onApply, onClose, editorEl, language }: {
  /** 视口坐标:目标末尾下方(y)/ 目标起点上方(anchorTop);下方放不下时翻上去(同工具栏)。 */
  x: number
  y: number
  anchorTop: number
  /** 面板头:动作名(「润色」「翻译」…)或「AI 写作」。 */
  title: string
  /** 有选区:给「替换 / 插入下方」;光标模式:给「插入」。 */
  hasSelection: boolean
  /** 先要一句指令(自定义 / `/ai` / 空行空格)再生成;否则打开即生成。 */
  askFirst: boolean
  run: InlineAiRun
  /** 不给 = 只读卡:没有写回去的按钮,回车不做事,点卡外面关掉。 */
  onApply?: (how: AiApply, text: string) => void
  onClose: () => void
  /** 目标所在编辑器的根:焦点在它里面时 Enter / Esc 归面板管(见下方键盘闸)。 */
  editorEl?: HTMLElement | null
  /** 翻译:卡头上能临时换目标语言。换了由宿主换 key 重开这张卡(在飞的请求随卸载中止)。 */
  language?: { value: string; onChange: (id: string) => void }
}): ReactElement {
  const { t } = useI18n()
  const [phase, setPhase] = useState<'ask' | 'running' | 'done' | 'error'>(askFirst ? 'ask' : 'running')
  const [instruction, setInstruction] = useState('')
  const [text, setText] = useState('')
  const [error, setError] = useState('')
  const [toolText, setToolText] = useState(false)
  const [by, setBy] = useState('')
  const [copied, setCopied] = useState(false)
  const ac = useRef<AbortController | null>(null)
  const acc = useRef('')
  const lastInstruction = useRef<string | undefined>(undefined)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)
  const panelRef = useRef<HTMLDivElement | null>(null)
  const editorRef = useRef(editorEl)
  editorRef.current = editorEl

  const start = (instr: string | undefined): void => {
    ac.current?.abort()
    const ctl = new AbortController()
    ac.current = ctl
    lastInstruction.current = instr
    acc.current = ''
    setText('')
    setError('')
    setToolText(false)
    setPhase('running')
    run(instr, (d) => {
      if (ctl.signal.aborted) return
      acc.current += d
      setText(acc.current)
    }, ctl.signal).then((r) => {
      if (ctl.signal.aborted) return
      const out = String(r.text ?? '')
      setText(out)
      setToolText(!!r.toolCallText)
      setBy(r.model ? (r.model.mt ? t('inlineai.byMt', { name: r.model.name }) : r.model.name) : '')
      if (out.trim()) setPhase('done')
      else { setError(t('inlineai.errEmptyResult')); setPhase('error') }
    }).catch((e: unknown) => {
      if (ctl.signal.aborted) return
      setError(String((e as Error)?.message || e))
      setPhase('error')
    })
  }
  /** 停止:已经流出来的那截留作预览(Notion 同款),一个字都没有就回到输入 / 关掉。 */
  const stop = (): void => {
    ac.current?.abort()
    if (acc.current.trim()) { setText(acc.current); setPhase('done') }
    else if (askFirst) setPhase('ask')
    else onClose()
  }

  useEffect(() => {
    if (!askFirst) start(undefined)
    else requestAnimationFrame(() => inputRef.current?.focus())
    return () => ac.current?.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const primary: AiApply = hasSelection ? 'replace' : 'insert'
  // Esc = 丢弃(任何阶段);预览完成后 Enter = 主动作。捕获期拦,别让它们落进编辑器(Enter 会插一个换行)。
  // 组字中一律放行(输入法的 Enter 是上屏)。⚠️ 只在焦点「归这块面板管」时接管:在本编辑器里、面板容器上、或没有焦点
  // (body)。面板不自动关 —— 用户可能转头去侧栏聊天框 / 搜索框 / 属性框打字,那里的回车若被这里抢走,
  // 会把 AI 结果写进笔记、消息却没发出去。面板里的按钮聚焦时让按钮自己响应回车(Tab 到「丢弃」按回车不能变成替换)。
  const ownsFocus = (forEnter: boolean): boolean => {
    const a = document.activeElement as HTMLElement | null
    if (!a || a === document.body || a === document.documentElement) return true
    if (panelRef.current?.contains(a)) return !forEnter || a === panelRef.current
    // 只读卡(聊天 / 插件视图)没有「所属编辑器」:点过消息之后焦点在标签组容器这类可聚焦的祖先上,不在 body。
    // 只要不是在别处的输入框里打字,Esc 就归这张卡。
    if (!onApply) return !a.matches('input, textarea, select, [contenteditable]:not([contenteditable="false"])')
    return !!editorRef.current?.contains(a)
  }
  const keyRef = useRef({ phase, text, primary })
  keyRef.current = { phase, text, primary }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.isComposing || e.keyCode === 229) return
      if (e.key === 'Escape' && ownsFocus(false)) {
        e.preventDefault()
        e.stopPropagation()
        onClose()
      } else if (onApply && e.key === 'Enter' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey && keyRef.current.phase === 'done' && ownsFocus(true)) {
        e.preventDefault()
        e.stopPropagation()
        onApply(keyRef.current.primary, keyRef.current.text)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose, onApply])

  // 只读卡手里没有待确认的改动,点到卡外面就收(可写的那张不自动关:结果还没落笔,见上)。
  useEffect(() => {
    if (onApply) return
    const onDown = (e: MouseEvent): void => { if (!panelRef.current?.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', onDown, true)
    return () => document.removeEventListener('mousedown', onDown, true)
  }, [onApply, onClose])

  const copy = (): void => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1500)
    }).catch(() => { /* 剪贴板不可用:按钮不变成「已复制」就是提示 */ })
  }
  const copyBtn = (primaryBtn: boolean): ReactElement => (
    <button type="button" className={`btn sm${primaryBtn ? ' primary' : ''}`} data-act="copy" onClick={copy}>{t(copied ? 'inlineai.copied' : 'inlineai.copy')}</button>
  )

  return (
    <OverlayAt innerRef={(el) => { panelRef.current = el }} className="ui-popover am-ai-panel" x={x} y={y} anchorTop={anchorTop} prefer="below" role="dialog" aria-label={onApply ? t('inlineai.label') : title} data-testid="inline-ai-panel" data-phase={phase} data-readonly={onApply ? undefined : ''}>
      <div className="am-ai-head">
        {language ? <Languages size={14} aria-hidden /> : <Sparkles size={14} aria-hidden />}
        <span className="am-ai-title">{title}</span>
        {language && (
          <select className="am-ai-lang" aria-label={t('inlineai.targetLang')} data-testid="inline-ai-lang" value={language.value} onChange={(e) => language.onChange(e.target.value)}>
            {TRANSLATE_LANGUAGES.map((l) => <option key={l.id} value={l.id}>{l.label}</option>)}
          </select>
        )}
        {/* 右侧:生成中 → 进度;翻译完 → 这次是谁译的;别的可写结果 → 「确认后才写入」。 */}
        {phase !== 'ask' && <span className="am-ai-hint" data-testid="inline-ai-hint">{phase === 'running' ? t('inlineai.generating') : (phase === 'done' && by) || (onApply ? t('inlineai.hint') : '')}</span>}
      </div>
      {phase === 'ask' && (
        <div className="am-ai-ask">
          <textarea
            ref={inputRef}
            className="am-ai-input"
            rows={2}
            value={instruction}
            placeholder={hasSelection ? t('inlineai.placeholderSel') : t('inlineai.placeholder')}
            onChange={(e) => setInstruction(e.target.value)}
            onKeyDown={(e) => {
              // 组字中的 Enter 是输入法上屏,不是发送(G4-02 同一条教训)。
              if (e.key !== 'Enter' || e.shiftKey || e.nativeEvent.isComposing || e.keyCode === 229) return
              e.preventDefault()
              e.stopPropagation()
              const v = instruction.trim()
              if (!v && hasSelection) return // 选区的自定义指令必须有内容;光标模式空着 = 续写
              start(v || undefined)
            }}
          />
          <div className="am-ai-actions">
            <button type="button" className="btn sm primary" data-act="send" disabled={hasSelection && !instruction.trim()} onClick={() => start(instruction.trim() || undefined)}>{t('inlineai.send')}</button>
            <button type="button" className="btn sm" data-act="discard" onClick={onClose}>{t('inlineai.discard')}</button>
          </div>
        </div>
      )}
      {phase !== 'ask' && (
        <>
          <div className="am-ai-preview md-body" data-testid="inline-ai-preview"><Markdown content={text || (phase === 'running' ? '…' : '')} allowRun={false} /></div>
          {phase === 'error' && <div className="am-ai-error" role="alert">{error}</div>}
          {toolText && phase === 'done' && <div className="am-ai-error">{t('inlineai.toolText')}</div>}
          <div className="am-ai-actions">
            {phase === 'running' && <button type="button" className="btn sm" data-act="stop" onClick={stop}>{t('inlineai.stop')}</button>}
            {phase === 'done' && onApply && hasSelection && (
              <>
                <button type="button" className="btn sm primary" data-act="replace" onClick={() => onApply('replace', text)}>{t('inlineai.replace')}</button>
                <button type="button" className="btn sm" data-act="below" onClick={() => onApply('below', text)}>{t('inlineai.insertBelow')}</button>
              </>
            )}
            {phase === 'done' && onApply && !hasSelection && (
              <button type="button" className="btn sm primary" data-act="insert" onClick={() => onApply('insert', text)}>{t('inlineai.insert')}</button>
            )}
            {phase === 'done' && copyBtn(!onApply)}
            {(phase === 'done' || phase === 'error') && (
              <button type="button" className="btn sm" data-act="retry" onClick={() => start(lastInstruction.current)}>{t('inlineai.retry')}</button>
            )}
            <button type="button" className="btn sm" data-act="discard" onClick={onClose}>{t(onApply ? 'inlineai.discard' : 'inlineai.close')}</button>
          </div>
        </>
      )}
    </OverlayAt>
  )
}
