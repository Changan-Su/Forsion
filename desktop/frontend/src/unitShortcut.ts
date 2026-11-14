/**
 * 设备「添加到桌面」的渲染层那半(账号面板 Unit 段右键):把设备图标(用户设的 emoji,没有就按平台的缺省线条图标)
 * 画成 1024px App 图标,连同兜底名交给主进程。**设备名不从这里传**:主进程按名册核对 id 后取名册里的名字(electron/unitShortcut.ts)。
 */
import { Laptop, Monitor, Smartphone } from 'lucide-react'
import type { SpaceDefinition } from '@lcl/engine'
import { renderAppIconPng, type AppIconGlyph } from './spaceShortcut'
import { useApp } from './stores/appStore'
import { registerMessages, translate } from './i18n'
import type { UnitInfo } from './types'

registerMessages({
  'unitShortcut.fallbackName': { zh: 'Forsion 设备', en: 'Forsion device' },
  'unitShortcut.toast.ok': { zh: '已添加到桌面，双击即可在独立窗口中打开「{name}」', en: 'Added to desktop. Double-click it to open {name} in its own window' },
  'unitShortcut.toast.unpackaged': { zh: '桌面快捷方式只在安装版里可用（开发模式下不生成）', en: 'Desktop shortcuts only work in the installed app, not in development mode' },
  'unitShortcut.toast.notFound': { zh: '这台设备不在当前账号名下', en: "This device isn't on your current account" },
  'unitShortcut.toast.signedOut': { zh: '先在 Forsion 里登录', en: 'Sign in to Forsion first' },
  'unitShortcut.toast.rosterUnavailable': { zh: '暂时连不上 Forsion 云端，稍后再试', en: "Can't reach Forsion cloud right now. Try again later" },
  'unitShortcut.toast.failed': { zh: '添加到桌面失败：{detail}', en: 'Could not add to desktop: {detail}' },
})

type IconComponent = NonNullable<SpaceDefinition['icon']>

/** 设备图标的字形:emoji 原样;否则跟设备行同一套缺省(手机 / 显示器 / 笔记本)。 */
export function unitIconGlyph(u: Pick<UnitInfo, 'icon' | 'platform'>): AppIconGlyph {
  const emoji = typeof u.icon === 'string' ? u.icon.trim() : ''
  if (emoji) return { kind: 'emoji', text: Array.from(emoji).slice(0, 8).join('') }
  const Icon = u.platform === 'android' || u.platform === 'ios' ? Smartphone : u.platform === 'win32' || u.platform === 'linux' ? Monitor : Laptop
  return { kind: 'component', Icon: Icon as unknown as IconComponent }
}

/** 账号面板右键「添加到桌面」。结果一律 toast。 */
export async function addUnitToDesktop(u: Pick<UnitInfo, 'id' | 'name' | 'icon' | 'platform'>): Promise<void> {
  const make = window.tangu?.unitsAddToDesktop
  if (!make) return
  const toast = (text: string, error = false): void => useApp.getState().toast(text, error)
  try {
    const iconPng = await renderAppIconPng(unitIconGlyph(u)).catch(() => undefined)
    const result = await make({ id: u.id, fallbackName: translate('unitShortcut.fallbackName'), iconPng })
    if (result.ok) toast(translate('unitShortcut.toast.ok', { name: u.name }))
    else if (result.code === 'unpackaged') toast(translate('unitShortcut.toast.unpackaged'), true)
    else if (result.code === 'not_found') toast(translate('unitShortcut.toast.notFound'), true)
    else if (result.code === 'signed_out') toast(translate('unitShortcut.toast.signedOut'), true)
    else if (result.code === 'roster_unavailable') toast(translate('unitShortcut.toast.rosterUnavailable'), true)
    else toast(translate('unitShortcut.toast.failed', { detail: result.detail || result.code }), true)
  } catch (e) {
    toast(translate('unitShortcut.toast.failed', { detail: e instanceof Error ? e.message : String(e) }), true)
  }
}
