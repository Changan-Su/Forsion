import { useEffect, useRef, useState } from 'react'

/** 把高频变化的值降到每 ms 一次(尾沿取最新):流式参数 → 预览重绘用(Coding Space 边写边显、sketch 草稿卡)。 */
export function useThrottled<T>(value: T, ms = 80): T {
  const [display, setDisplay] = useState(value)
  const last = useRef(0)
  useEffect(() => {
    const wait = Math.max(0, ms - (Date.now() - last.current))
    const timer = setTimeout(() => { last.current = Date.now(); setDisplay(value) }, wait)
    return () => clearTimeout(timer)
  }, [value, ms])
  return display
}
