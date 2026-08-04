/**
 * 骨架屏 + 面板级错误边界(引擎层;desktop/web 经 WorkspaceHost、mobile 经 SingleColumnHost 共用,
 * feature 层也可从 @lcl/engine 引 Skeleton 直接用在数据加载分支)。
 * 三种变体:list(侧栏/列表)/ document(笔记/文档)/ chat(会话气泡)。
 * 外观契约:低对比主题色灰块 + 1.5s Shimmer 流光;出现自带 150ms 延迟(快加载整个骨架不闪);
 * 明暗/配色跟随 token(--accent-rgb/--text 等),reduced-motion 下静止。样式见 skeleton.css。
 */
import React, { Component, type ReactNode } from 'react'
import './skeleton.css'

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

interface GuardState { err: Error | null; n: number }

/** 面板级错误边界:视图渲染 / 懒 chunk 拉取失败只塌**本面板**并给出重试,
 *  不再冒泡到根 ErrorBoundary 把整个应用换成错误页(弱网下点开重视图 = 全 app 白屏的根因)。 */
export class ViewErrorBoundary extends Component<{ children: ReactNode }, GuardState> {
  state: GuardState = { err: null, n: 0 }
  static getDerivedStateFromError(err: Error): Partial<GuardState> {
    return { err }
  }
  render() {
    const { err, n } = this.state
    if (!err) return <React.Fragment key={n}>{this.props.children}</React.Fragment>
    const zh = document.documentElement.lang.startsWith('zh')
    return (
      <div className="sk-error" role="alert">
        <div className="sk-error-title">{zh ? '此视图加载失败' : 'Failed to load this view'}</div>
        <div className="sk-error-msg">{String(err?.message || err)}</div>
        <button className="sk-error-btn" onClick={() => this.setState((s) => ({ err: null, n: s.n + 1 }))}>
          {zh ? '重试' : 'Retry'}
        </button>
      </div>
    )
  }
}
