/**
 * 组合头像 `<AvatarStack>`(方案 §3.3,仓内零先例)
 *
 * 一枚 30×30 圆角方框(radius 9,底 `--overlay-medium`,内边距 2 → 内区 26)里装 1..4 枚圆头像,
 * 人数 >4 时第 4 格换成「+N」徽章。侧栏的团队行用它,群聊 pill / 收件箱发件人组同样可以复用 ——
 * 组件**不绑团队**,只认 `{slug, name, avatarUrl?, emoji?}` 这一组事实。
 *
 * 三条纪律:
 * 1. **几何全走内联样式**,不开 CSS 文件 —— 尺寸是入参的函数(`size` 可变),写进样式表就只剩一档,
 *    且会与 `.t2o-` 作用域覆盖块抢特异性。
 * 2. **`<img>` 必须显式写 width/height 属性**(不只是 style)。`check:listsrc` 的教训:漏了属性的
 *    `<img>` 会按原始 32/48px 撑爆行,而几何断言在套了容器的台架里照样全绿。
 * 3. 根节点带 `data-n`(= 传入人数,不是渲染出的格数),给 `check:orbitside` 当锚点。
 *
 * 缺头像的格退首字,**中性底色**(09-25 用户拍板:Orbit 侧栏首字头像不按 slug 上彩色);
 * 格底取 `--overlay-strong`,比外框的 `--overlay-medium` 深一档,n≥2 时各格才不会糊进外框。
 * 取字走 `initialFor`(与选择条 / 私聊行同一规则):同一组成员首字相同时跳过公共前缀。
 */
import React from 'react'
import { registerMessages, useI18n } from '../i18n'
import { initialFor } from './agentInitial'

registerMessages({
  'avatarStack.members': { zh: '{n} 位成员', en: '{n} members' },
  'avatarStack.more': { zh: '另外 {n} 位', en: '{n} more' },
})

export interface AvatarStackItem {
  slug: string
  name: string
  avatarUrl?: string
}

/** 一格的几何。`more` 有值 = 这格不是头像而是「+N」徽章。 */
export interface AvatarStackCell {
  x: number
  y: number
  size: number
  more?: number
}

/** 外框边长(= `.ribbon-account .account-avatar` 那一档,仓内头像只有 18 / 26 / 30 三档)。 */
export const AVATAR_STACK_SIZE = 30
/** 外框到内区的内边距:30 - 2×2 = 26。 */
export const AVATAR_STACK_PAD = 2
/** 圆角方框的半径(方案 §3.2 团队图标那行定死 9,与项目行的方块 8 区分重量)。 */
const AVATAR_STACK_RADIUS = 9
/** 2×2 格的格距。 */
const GRID_GAP = 2

/**
 * 纯几何:n 个头像在 `inner` 见方的内区里怎么摆。
 *
 * 默认 `inner = 26`(= 30 外框 - 2×2 内边距)时精确落在方案 §3.3 的表上:
 * n=1 单圆 26;n=2 两枚 17 于 (0,0)/(9,9);n=3 三枚 13 于 (0,0)/(13,0)/(6.5,13);
 * n≥4 2×2 格、12px、格距 2 → (0,0)/(14,0)/(0,14)/(14,14),n>4 时第 4 格 `more = n-3`。
 *
 * 各档的尺寸都由 `inner` 推导(不写死 17 / 13 / 12),所以换一档外框边长仍然填满内区;
 * 不变式:`max(x + size) === max(y + size) === inner`。n ≤ 0 返回空布局(0 成员不画假头像)。
 */
export function avatarStackLayout(n: number, inner = 26): AvatarStackCell[] {
  const count = Math.floor(n)
  if (!(count > 0) || !(inner > 0)) return []
  if (count === 1) return [{ x: 0, y: 0, size: inner }]
  if (count === 2) {
    // 两枚各占内区的 2/3 并沿对角错开,错位量 = inner - size,保证第二枚的右下角正好压在内区边界上。
    const size = Math.round((inner * 2) / 3)
    const off = inner - size
    return [{ x: 0, y: 0, size }, { x: off, y: off, size }]
  }
  if (count === 3) {
    // 上二下一:下面那枚居中(x = size/2),半格 6.5 是设计给的,别为了整数把它挪到 6 或 7。
    const size = inner / 2
    return [{ x: 0, y: 0, size }, { x: size, y: 0, size }, { x: size / 2, y: size, size }]
  }
  const size = (inner - GRID_GAP) / 2
  const step = size + GRID_GAP
  const cells: AvatarStackCell[] = [
    { x: 0, y: 0, size },
    { x: step, y: 0, size },
    { x: 0, y: step, size },
    { x: step, y: step, size },
  ]
  // 恰好 4 人 = 四张脸,没有徽章;>4 才把第 4 格让给「+N」(N = 未画出来的人数 = n - 3)。
  if (count > 4) cells[3] = { x: step, y: step, size, more: count - 3 }
  return cells
}

/** 首字字号:26 格 13px(方案 §3.2),小格收到 8px(= 「+N」徽章那一档),两端夹住。 */
function initialFontSize(size: number): number {
  return Math.min(13, Math.max(8, Math.round(size / 2)))
}

// 0 模糊的分隔环:n=2 时第二枚压在第一枚上,靠一圈 sidebar-bg 把两枚分开。
// 手法镜像 `.t2s-lead .t2s-dot`(sidebar2.css)—— 那里的状态点也是这么从图标上「抠」出来的。
// 零模糊描边不是空间高程,统一阴影调整不该改写它;闸门的标注必须与 boxShadow 同行(见下)。
const SEPARATOR_RING: React.CSSProperties = { boxShadow: '0 0 0 1.5px var(--sidebar-bg)' } // shadow-contract: effect

export const AvatarStack: React.FC<{
  items: AvatarStackItem[]
  /** 外框边长,缺省 30。内区 = size - 2×`AVATAR_STACK_PAD`。 */
  size?: number
  className?: string
  /** 整体 emoji(独立团队 config.toml 的 avatar):非空则整格显示 emoji、不合成成员头像(§3.3)。与成员数无关。 */
  emoji?: string
  /** 整体图片(团队上传头像的 objectURL):优先于 emoji,铺满外框、同一 9 圆角。 */
  imageUrl?: string
}> = ({ items, size = AVATAR_STACK_SIZE, className, emoji, imageUrl }) => {
  const { t } = useI18n()
  const inner = size - AVATAR_STACK_PAD * 2
  const cells = avatarStackLayout(items.length, inner)
  const soloEmoji = emoji && emoji.trim() ? emoji.trim() : undefined
  return (
    <div
      className={className ? `t2o-avstack ${className}` : 't2o-avstack'}
      data-n={items.length}
      {...(items.length
        ? { role: 'img', 'aria-label': t('avatarStack.members', { n: items.length }) }
        : { 'aria-hidden': true })}
      style={{
        position: 'relative',
        boxSizing: 'border-box',
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: AVATAR_STACK_RADIUS,
        background: 'var(--overlay-medium)',
      }}
    >
      {/* 内区容器:绝对定位的子元素以**包含块的 padding 盒**为原点,所以内边距不能写在根上
          (写在根上 left:0 仍落在外框边缘,内区 2px 白拿不到),必须由这一层把原点挪进去。 */}
      <div
        style={{
          position: 'absolute',
          left: AVATAR_STACK_PAD,
          top: AVATAR_STACK_PAD,
          width: inner,
          height: inner,
          ...(soloEmoji ? { display: 'flex', alignItems: 'center', justifyContent: 'center' } : null),
        }}
      >
        {imageUrl ? null : soloEmoji ? (
          <span style={{ fontSize: Math.round(inner * 0.62), lineHeight: 1 }}>{soloEmoji}</span>
        ) : (
          cells.map((cell, i) => {
            const box: React.CSSProperties = {
              position: 'absolute',
              boxSizing: 'border-box',
              left: cell.x,
              top: cell.y,
              width: cell.size,
              height: cell.size,
              borderRadius: '50%',
              // 只有 n=2 那一档会互相压,别的档位相切不相交,不需要抠环。
              ...(cells.length === 2 && i === 1 ? SEPARATOR_RING : null),
            }
            if (cell.more != null) {
              const label = t('avatarStack.more', { n: cell.more })
              return (
                <span
                  key="more"
                  title={label}
                  aria-label={label}
                  style={{
                    ...box,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    background: 'var(--overlay-medium)',
                    color: 'var(--text)',
                    fontSize: 'var(--ui-font-caption, 11px)',
                    fontWeight: 600,
                    lineHeight: 1,
                  }}
                >
                  +{cell.more}
                </span>
              )
            }
            const item = items[i]
            if (!item) return null
            if (item.avatarUrl) {
              return (
                <img
                  key={`${item.slug}-${i}`}
                  src={item.avatarUrl}
                  alt=""
                  title={item.name}
                  draggable={false}
                  width={cell.size}
                  height={cell.size}
                  style={{ ...box, display: 'block', objectFit: 'cover' }}
                />
              )
            }
            return (
              <span
                key={`${item.slug}-${i}`}
                title={item.name}
                style={{
                  ...box,
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  background: 'var(--overlay-strong)',
                  color: 'var(--text-muted)',
                  fontSize: initialFontSize(cell.size),
                  fontWeight: 600,
                  lineHeight: 1,
                }}
              >
                {initialFor(item.name, items.map((x) => x.name))}
              </span>
            )
          })
        )}
      </div>
      {imageUrl && <img src={imageUrl} alt="" draggable={false} width={size} height={size} style={{ position: 'absolute', inset: 0, display: 'block', width: size, height: size, borderRadius: AVATAR_STACK_RADIUS, objectFit: 'cover' }} />}
    </div>
  )
}
