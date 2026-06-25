import { useEffect, useState } from 'react'

/** 暗色跟随:Tangu 暗色 = `<html class="dark">`(见 theme/loader.ts)。独立小模块,
 *  避免从懒加载的 CodeView 导入而把 CodeMirror 拽进主 bundle。 */
export function useIsDark(): boolean {
  const [dark, setDark] = useState(() => document.documentElement.classList.contains('dark'))
  useEffect(() => {
    const root = document.documentElement
    const obs = new MutationObserver(() => setDark(root.classList.contains('dark')))
    obs.observe(root, { attributes: true, attributeFilter: ['class'] })
    return () => obs.disconnect()
  }, [])
  return dark
}
