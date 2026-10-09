/**
 * 安卓桌面图标跟随「设置 → 外观 → 应用图标」。原生那半在 LauncherIconPlugin.kt。
 *
 * 桌面上的图标是安装包清单里的一个入口,Android 只允许在声明过的入口之间切换:内置图标各有一个入口,
 * 上传的图片 / 插件图标没有(原生侧对不认识的 id 一律回到默认入口),它们只在 App 内显示。
 * 启动时也对一次:清了数据、换了设备之后,桌面图标与设置重新一致。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useAppearance } from '@/appearance/store'
import type { StartupAppearance } from '../../desktop/shared/startupAppearance'
import { publishSpaceShortcuts } from './spaceShortcuts'

const Native = registerPlugin<{ set(o: { id: string | null }): Promise<{ changed: boolean }> }>('LauncherIcon')

function sync(value: StartupAppearance): void {
  void Native.set({ id: value.nativeIcon ? value.icon?.id ?? null : null })
    // Space 快捷方式挂在入口上:入口换了,系统会停用旧入口名下的那些 → 重发一遍,挂到新入口。
    .then((r) => { if (r.changed) publishSpaceShortcuts() })
    .catch(() => { /* 受限的工作资料 / 不让改组件状态的 ROM:桌面图标保持原样 */ })
}

let installed = false
export function installLauncherIcon(): void {
  if (installed || !Capacitor.isNativePlatform()) return
  installed = true
  sync(useAppearance.getState().value)
  useAppearance.subscribe((s, prev) => { if (s.value !== prev.value) sync(s.value) })
}
