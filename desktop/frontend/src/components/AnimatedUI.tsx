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
  const ref = React.useRef<HTMLDivElement>(null)
  const clip = (on: boolean): void => { if (ref.current) ref.current.style.overflow = on ? 'hidden' : '' }
  return (
    <AnimatePresence initial={false}>
      {open && (
        // 只在长出 / 收起途中裁切;展开好了放开,否则行上探出去的拖动落点线(top:-4px 之类)被裁掉(10-25 Codex 评审)。
        // 直接改元素:退场时 AnimatePresence 画的是留下的那一帧,改 props 够不着;framer 的 transitionEnd 实测不落地。
        // flow-root 保住原来 overflow:hidden 带来的块级格式化上下文,外边距不会在动画结束那一下改折叠方式而跳一下。
        // 调用处请写成 open={x}>{x && …}:收起时不必把整棵子树算一遍,退场用的是 AnimatePresence 留下的那一帧。
        <motion.div
          ref={ref}
          initial={rm ? false : { height: 0, opacity: 0, overflow: 'hidden' }} // 减少动态效果:直接出现、不裁切(瞬时动画不回调完成,裁了就放不开)
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: rm ? 0 : 0.24, ease: [0.2, 0.8, 0.3, 1] }}
          onAnimationStart={() => clip(!rm)}
          onAnimationComplete={(def) => clip((def as { height?: unknown }).height !== 'auto')}
          style={{ display: 'flow-root' }}
        >
          {children}
        </motion.div>
      )}
    </AnimatePresence>
  )
}
