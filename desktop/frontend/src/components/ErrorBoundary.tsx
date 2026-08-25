/**
 * 渲染崩溃兜底:没有它时任意一处 render 抛错 = 整窗白屏,且「导出会话」只带后端日志、
 * 抓不到前端异常 → 无从诊断。包住外壳与聊天区(聊天区按 sessionId 重挂可逃离坏会话)。
 * 故意全程内联样式 + 读 document.lang:崩溃时主题 CSS/i18n 可能也已坏,兜底界面不能再依赖它们。
 */
import React from 'react'

type Props = { children: React.ReactNode }
type State = { error: Error | null }

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = { error: null }
  static getDerivedStateFromError(error: Error): State { return { error } }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    console.error('[tangu] render crash:', error, info?.componentStack)
  }
  render() {
    const { error } = this.state
    if (!error) return this.props.children
    const zh = (document.documentElement.lang || '').startsWith('zh')
    const detail = `${error.message}\n\n${error.stack || ''}`.trim()
    return (
      <div style={{ padding: 24, maxWidth: 720, margin: '0 auto', overflow: 'auto', height: '100%', boxSizing: 'border-box' }}>
        <h3 style={{ margin: '8px 0' }}>{zh ? '界面渲染出错' : 'Something broke while rendering'}</h3>
        <p style={{ opacity: 0.8, fontSize: 13, margin: '4px 0 12px' }}>
          {zh ? '这一部分崩溃了。可重试、或切换/新建会话避开它;请把下面的错误发给开发者。'
              : 'This view crashed. Retry, or switch/start a new chat to avoid it; send the error below to the developer.'}
        </p>
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 12, background: 'var(--danger-light)', color: 'var(--danger)', padding: 12, borderRadius: 8, maxHeight: 280, overflow: 'auto' }}>{detail}</pre>
        <div style={{ display: 'flex', gap: 8, marginTop: 12 }}>
          <button style={{ padding: '6px 12px' }} onClick={() => this.setState({ error: null })}>{zh ? '重试' : 'Retry'}</button>
          <button style={{ padding: '6px 12px' }} onClick={() => { try { void navigator.clipboard.writeText(detail) } catch { /* ignore */ } }}>{zh ? '复制错误' : 'Copy error'}</button>
          <button style={{ padding: '6px 12px' }} onClick={() => location.reload()}>{zh ? '重新加载' : 'Reload'}</button>
        </div>
      </div>
    )
  }
}
