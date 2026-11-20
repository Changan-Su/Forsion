/**
 * 右上角浮钮组(.dv-edge-actions)最前面的一格宿主附件:窗口级的标识与操作(如插件沙箱的「沙箱 · 插件名 / 重置 / 安装」)放这里。
 * 放进浮钮组的流内,WorkspaceHost 现成的几何让位(被压住的标签头补右内边距、放不下落到第二行、Windows 系统按钮让位)就一并算上它;
 * 自己 position: fixed 浮在标签栏上会和标签叠字(11-20 沙箱窗口实踩)。
 * 只给宿主用,不开给插件(插件的界面走 ctx.ui);同一时间只有一格,后设的替换先设的,传 null 清掉。
 */
import type { ReactNode } from 'react'
import { create } from 'zustand'

export const useEdgeAccessory = create<{ node: ReactNode | null }>(() => ({ node: null }))

export function setEdgeAccessory(node: ReactNode | null): void {
  useEdgeAccessory.setState({ node })
}
