/** 共享动效入口:入场门控与折叠容器(真身都在 base.css 的 data-motion,插件同一份)。 */
import React from 'react'

/** 「点了才出现」那块的入场(base.css 的 data-motion="enter",插件同一份):挂上 / 恢复时不动(DESIGN §3 动效规矩 6),
 *  用户动过一次之后每次换出来的那一版都淡入上来。缺省收着、只在点了之后才挂上的内容不用它,直接写 data-motion="enter"。 */
export function useEnterMotion(): readonly ['enter' | undefined, () => void] {
  const [on, setOn] = React.useState(false)
  return [on ? 'enter' : undefined, () => setOn(true)] as const
}

/** 折叠展开容器(思考块/工具卡片体/侧栏会话列表):真身在 LCL(@lcl/components 的 AnimatedCollapse,
 *  base.css 的 data-motion="collapse"),插件同一份。调用处照旧写 open={x}>{x && …}。 */
export { AnimatedCollapse } from '@lcl/components'
