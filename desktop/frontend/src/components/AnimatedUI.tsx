/**
 * 共享动效预设(移植自 Forsion-AI-Studio client/components/AnimatedUI.tsx,
 * 布局类改为 base.css 的语义类;弹簧参数原样保留 —— forsion-ui 规范:必须带 scale、
 * damping ratio < 1)。
 */
import React from 'react'
import { motion, AnimatePresence, useReducedMotion } from 'framer-motion'

/** 「点了才出现」那块的入场(base.css 的 data-motion="enter",插件同一份):挂上 / 恢复时不动(DESIGN §3 动效规矩 6),
 *  用户动过一次之后每次换出来的那一版都淡入上来。缺省收着、只在点了之后才挂上的内容不用它,直接写 data-motion="enter"。 */
export function useEnterMotion(): readonly ['enter' | undefined, () => void] {
  const [on, setOn] = React.useState(false)
  return [on ? 'enter' : undefined, () => setOn(true)] as const
}

/** 折叠展开容器(思考块/工具卡片体/侧栏会话列表)。easing 取「agent 切换」同款 spring 曲线;
 *  尊重系统的「减少动态效果」(reduced motion → 瞬时)。 */
export const AnimatedCollapse: React.FC<{ open: boolean; children: React.ReactNode }> = ({ open, children }) => {
  const rm = useReducedMotion()
  return (
    <AnimatePresence initial={false}>
      {open && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: rm ? 0 : 0.24, ease: [0.2, 0.8, 0.3, 1] }}
          style={{ overflow: 'hidden' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
