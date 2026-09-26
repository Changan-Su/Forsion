/**
 * 应用层 Agent 头像(评审 U-22):有上传头像 → `<img>`;没有 → **中性**首字兜底(09-25 用户拍板,不按 slug 上彩色)。
 * 收掉原先选择条 / Orbit 侧栏 / 状态条各自的首字副本,以及档案页拿 `<Bot>` 充当 Agent 头像的写法
 * (Bot 专属 Tangu 本体,见评审 U-22)。不进 LCL:它读的是应用层的 Agent 名册语义。
 *
 * 尺寸与底色由**调用方的容器类**决定(`.agent-pill-initial` 18px、`.t2o-avatar` 30px …),
 * 这里只管取字与中性前景;`fill` = 铺满一个已定尺寸的肖像框(档案页),字号按容器查询随框缩放。
 */
import React from 'react'
import { initialFor } from './agentInitial'
import './agentAvatar.css'

export { initialFor, initialOf } from './agentInitial'

export interface AgentAvatarProps {
  name: string
  /** 上传头像的 URL;缺省 = 首字兜底。 */
  url?: string | null
  /** 同屏其他名字(去撞字用,见 initialFor)。 */
  siblings?: ReadonlyArray<string | null | undefined>
  /** 两种形态共用的类(几何锚点,台架按它找)。 */
  className?: string
  imgClassName?: string
  initialClassName?: string
  /** `<img>` 的显式宽高属性(check:listsrc 的教训:不写就按原图像素撑爆行)。 */
  size?: number
  /** 铺满父级肖像框(档案页用)。 */
  fill?: boolean
  title?: string
  style?: React.CSSProperties
  /** 台架 / 状态锚点(如 `data-work`)原样落到根元素上。 */
  [data: `data-${string}`]: string | undefined
}

const cx = (...parts: Array<string | false | null | undefined>): string | undefined => parts.filter(Boolean).join(' ') || undefined

export function AgentAvatar({ name, url, siblings, className, imgClassName, initialClassName, size, fill, title, style, ...data }: AgentAvatarProps): React.ReactElement {
  if (url) {
    return <img {...data} className={cx(className, imgClassName)} src={url} alt="" title={title} draggable={false} width={size} height={size} style={style} />
  }
  return (
    <span {...data} className={cx('agent-avatar-initial', fill && 'agent-avatar-fill', className, initialClassName)} title={title} aria-hidden="true" style={style}>
      <span className="agent-avatar-glyph">{initialFor(name, siblings)}</span>
    </span>
  )
}
