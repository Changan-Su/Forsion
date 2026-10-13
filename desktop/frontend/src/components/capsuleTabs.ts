/**
 * 胶囊分段切换的滑块:选中项底下那块底色不再是「这一格亮、那一格灭」,而是一块从旧位置滑到新位置的滑块。
 * 用法:容器加 class `cap-tabs` 并挂上返回的 ref,里面的选项是 `role="tab"` + `aria-selected`(笔记斜杠菜单、
 * 聊天引用菜单共用)。滑块是容器的 ::before,位置由这里量出来写成 CSS 变量;首次摆位不走过渡。
 * 减少动态效果时直接到位(capsuleTabs.css)。
 *
 * tabs = 选项集合的指纹(如 `cats.join()`)。选项是异步到齐的菜单必须传:分类条晚于菜单出现、或中途多出一类时,
 * 选中项没变但位置变了,只看 selected 的话滑块永远摆不上(实测聊天引用菜单就是这样没了动效)。
 */
import { useLayoutEffect, useRef, type RefObject } from 'react'
import './capsuleTabs.css'

export function useCapsuleSlide<T extends HTMLElement>(selected: string, tabs = ''): RefObject<T | null> {
  const ref = useRef<T | null>(null)
  useLayoutEffect(() => {
    const box = ref.current
    if (!box) return
    const place = (): void => {
      const tab = box.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]')
      if (!tab) return
      box.style.setProperty('--cap-x', `${tab.offsetLeft}px`)
      box.style.setProperty('--cap-y', `${tab.offsetTop}px`)
      box.style.setProperty('--cap-w', `${tab.offsetWidth}px`)
      box.style.setProperty('--cap-h', `${tab.offsetHeight}px`)
      // 下一帧才交给滑块:第一次是「摆上去」,不该看到它从左上角滑过来
      if (!box.hasAttribute('data-cap-ready')) requestAnimationFrame(() => box.setAttribute('data-cap-ready', ''))
    }
    place()
    const ro = new ResizeObserver(place) // 换语言 / 容器变宽后选项位置会变
    ro.observe(box)
    return () => ro.disconnect()
  }, [selected, tabs])
  return ref
}
