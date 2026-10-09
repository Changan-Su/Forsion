/**
 * 安卓桌面图标跟随「设置 → 外观 → 应用图标」。原生那半在 LauncherIconPlugin.kt。
 *
 * 桌面上的图标是安装包清单里的一个入口,Android 只允许在声明过的入口之间切换:内置图标各有一个入口,
 * 上传的图片 / 插件图标没有(原生侧对不认识的 id 一律回到默认入口),它们只在 App 内显示。
 * 启动时也对一次:清了数据、换了设备之后,桌面图标与设置重新一致(上次没等到离开 App 就被杀掉的,也靠这一次补上)。
 */
import { Capacitor, registerPlugin } from '@capacitor/core'
import { useAppearance } from '@/appearance/store'
import type { StartupAppearance } from '../../desktop/shared/startupAppearance'

const Native = registerPlugin<{ set(o: { id: string | null }): Promise<{ changed: boolean }> }>('LauncherIcon')

function sync(value: StartupAppearance): void {
  // 这里只是「说一声要哪个」:真正切换等用户离开 App(在前台切,系统会把正用着的任务关掉),快捷方式由原生侧先搬到
  // 新入口 —— 两条都见 LauncherIconPlugin 顶部的 ⚠️。
  void Native.set({ id: value.nativeIcon ? value.icon?.id ?? null : null })
    .catch(() => { /* 受限的工作资料 / 不让改组件状态的 ROM:桌面图标保持原样 */ })
}

let installed = false
export function installLauncherIcon(): void {
  if (installed || !Capacitor.isNativePlatform()) return
  installed = true
  sync(useAppearance.getState().value)
  useAppearance.subscribe((s, prev) => { if (s.value !== prev.value) sync(s.value) })
}
