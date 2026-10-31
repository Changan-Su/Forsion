/**
 * 骨架屏 + 面板级错误边界(引擎层;desktop/web 经 WorkspaceHost、mobile 经 SingleColumnHost 共用,
 * feature 层也可从 @lcl/engine 引 Skeleton 直接用在数据加载分支)。
 * 三种变体:list(侧栏/列表)/ document(笔记/文档)/ chat(会话气泡)。
 * 外观契约:低对比主题色灰块 + 1.5s Shimmer 流光;出现自带 150ms 延迟(快加载整个骨架不闪);
 * 明暗/配色跟随 token(--accent-rgb/--text 等),reduced-motion 下静止。样式见 skeleton.css。
 */
import React, { Component, useState, type ReactNode } from 'react'
import { CircleAlert, RotateCw } from 'lucide-react'
import './skeleton.css'
import { engineTr, useEngineI18n } from './i18nSeam'

export type SkeletonVariant = 'list' | 'document' | 'chat'

/** 视图类型 → 骨架变体的缺省推断:侧栏一律列表;类型名带 chat/session 按会话;其余按文档。 */
export function skeletonVariantOf(type: string, loc?: string): SkeletonVariant {
  if (loc === 'left' || loc === 'right') return 'list'
  if (/chat|session/i.test(type)) return 'chat'
  return 'document'
}

/* 宽度序列写死(伪随机观感、渲染恒定):骨架屏两次出现形状一致,不会自己「跳动」。 */
const LIST_W = [72, 55, 66, 48, 70, 52, 62, 45]
const LIST_W2 = [48, 34, 42, 28, 45, 31, 38, 26]

export function Skeleton({ variant = 'document' }: { variant?: SkeletonVariant }) {
  if (variant === 'list') {
    return (
      <div className="sk sk-list" aria-hidden="true">
        {LIST_W.map((w, i) => (
          <div className="sk-row" key={i}>
            <span className="sk-b sk-dot" />
            <span className="sk-col">
              <span className="sk-b sk-line" style={{ width: `${w}%` }} />
              <span className="sk-b sk-line sk-thin" style={{ width: `${LIST_W2[i]}%` }} />
            </span>
          </div>
        ))}
      </div>
    )
  }
  if (variant === 'chat') {
    return (
      <div className="sk sk-chat" aria-hidden="true">
        <div className="sk-msg">
          <span className="sk-b sk-ava" />
          <span className="sk-col">
            <span className="sk-b sk-line" style={{ width: '82%' }} />
            <span className="sk-b sk-line" style={{ width: '64%' }} />
            <span className="sk-b sk-line" style={{ width: '43%' }} />
          </span>
        </div>
        <div className="sk-msg sk-msg-user"><span className="sk-b sk-bubble" style={{ width: '46%' }} /></div>
        <div className="sk-msg">
          <span className="sk-b sk-ava" />
          <span className="sk-col">
            <span className="sk-b sk-line" style={{ width: '71%' }} />
            <span className="sk-b sk-line" style={{ width: '86%' }} />
            <span className="sk-b sk-line" style={{ width: '32%' }} />
          </span>
        </div>
        <div className="sk-msg sk-msg-user"><span className="sk-b sk-bubble" style={{ width: '33%' }} /></div>
      </div>
    )
  }
  return (
    <div className="sk sk-document" aria-hidden="true">
      <span className="sk-b sk-title" style={{ width: '46%' }} />
      <span className="sk-b sk-line" style={{ width: '92%' }} />
      <span className="sk-b sk-line" style={{ width: '84%' }} />
      <span className="sk-b sk-line" style={{ width: '96%' }} />
      <span className="sk-b sk-line" style={{ width: '61%' }} />
      <span className="sk-gap" />
      <span className="sk-b sk-line" style={{ width: '89%' }} />
      <span className="sk-b sk-line" style={{ width: '94%' }} />
      <span className="sk-b sk-line" style={{ width: '73%' }} />
      <span className="sk-b sk-line" style={{ width: '40%' }} />
    </div>
  )
}

/** 布局里存着、此刻没注册的视图(它的插件还没就位,或者已关掉 / 卸载)原地留的占位:不丢整份布局,
 *  注册上来由 WorkspaceHost 的 FrameHost 订阅注册表就地换回真视图。外观同 ViewErrorBoundary。 */
export function ViewPlaceholder(): React.ReactElement {
  return (
    <div className="sk-error" role="status" data-view-placeholder="">
      <div className="sk-error-title">{engineTr('lcl.view.unavailable')}</div>
      <div className="sk-error-msg">{engineTr('lcl.view.unavailableHint')}</div>
    </div>
  )
}

interface GuardState { err: Error | null; n: number }
interface GuardProps {
  children: ReactNode
  /** 用户看得懂的名字(标签名 / 视图标题),进说明句和「复制详情」。 */
  name?: string
  /** 视图类型,只进「复制详情」。 */
  type?: string
  /** 变了且正处于错误态 → 清掉错误重渲(常驻挂载、只是藏起来的面板,再次露出时给它一次重来的机会;健康的不受影响)。 */
  resetKey?: unknown
}

/** 错误态(走查 5.10):样子同宿主的 EmptyState —— 图标、一句标题、一句话、「重试」+「复制详情」,原始异常默认折起。 */
function ViewError({ err, name, type, onRetry }: { err: Error; name?: string; type?: string; onRetry: () => void }): React.ReactElement {
  const { t } = useEngineI18n()
  const [copied, setCopied] = useState(false)
  const message = String(err?.message || err)
  const copy = async (): Promise<void> => {
    const version = await window.tangu?.appVersion?.().catch(() => '')
    const text = [name && `View: ${name}`, type && `Type: ${type}`, version && `Version: ${version}`, err?.stack || message].filter(Boolean).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { /* 剪贴板被拒:按钮不变,详情仍可手选复制 */ }
  }
  return (
    <div className="sk-error" role="alert" data-view-error="">
      <CircleAlert className="sk-error-icon" size={22} strokeWidth={1.6} aria-hidden />
      <strong className="sk-error-title">{t('lcl.view.errorTitle')}</strong>
      <p className="sk-error-msg">{name ? t('lcl.view.errorLineNamed', { name }) : t('lcl.view.errorLine')}</p>
      <div className="sk-error-actions">
        <button type="button" className="sk-error-btn sk-error-btn--primary" data-action="retry" onClick={onRetry}><RotateCw size={14} aria-hidden />{t('lcl.view.retry')}</button>
        <button type="button" className="sk-error-btn" data-action="copy" onClick={() => void copy()}>{t(copied ? 'lcl.view.copied' : 'lcl.view.copyDetails')}</button>
      </div>
      <details className="sk-error-details">
        <summary>{t('lcl.view.errorDetails')}</summary>
        <pre>{message}</pre>
      </details>
    </div>
  )
}

/** 面板级错误边界:视图渲染 / 懒 chunk 拉取失败只塌**本面板**并给出重试,
 *  不再冒泡到根 ErrorBoundary 把整个应用换成错误页(弱网下点开重视图 = 全 app 白屏的根因)。
 *  视图内也可以再包一层(Agent 详情包在标签内容外),只塌那一格、头部和标签条留着。 */
export class ViewErrorBoundary extends Component<GuardProps, GuardState> {
  state: GuardState = { err: null, n: 0 }
  static getDerivedStateFromError(err: Error): Partial<GuardState> {
    return { err }
  }
  componentDidUpdate(prev: GuardProps) {
    if (this.state.err && prev.resetKey !== this.props.resetKey) this.setState((s) => ({ err: null, n: s.n + 1 }))
  }
  render() {
    const { err, n } = this.state
    if (!err) return <React.Fragment key={n}>{this.props.children}</React.Fragment>
    return <ViewError err={err} name={this.props.name} type={this.props.type} onRetry={() => this.setState((s) => ({ err: null, n: s.n + 1 }))} />
  }
}
