/**
 * 共享动效预设(移植自 Forsion-AI-Studio client/components/AnimatedUI.tsx,
 * 布局类改为 base.css 的语义类;弹簧参数原样保留 —— forsion-ui 规范:必须带 scale、
 * damping ratio < 1)。
 */
import React from 'react'
import { motion, AnimatePresence } from 'framer-motion'

/** 折叠展开容器(思考块/工具卡片体)。 */
export const AnimatedCollapse: React.FC<{ open: boolean; children: React.ReactNode }> = ({ open, children }) => (
  <AnimatePresence initial={false}>
    {open && (
      <motion.div
        initial={{ height: 0, opacity: 0 }}
        animate={{ height: 'auto', opacity: 1 }}
        exit={{ height: 0, opacity: 0 }}
        transition={{ duration: 0.22, ease: [0.25, 0.1, 0.25, 1] }}
        style={{ overflow: 'hidden' }}
      >
        {children}
      </motion.div>
    )}
  </AnimatePresence>
)
