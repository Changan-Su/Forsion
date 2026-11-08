/**
 * Space「添加到桌面」的渲染层那半:把 Space 图标画成一张 1024px 的 App 图标(PNG),连同名字交给主进程落盘
 * (electron/spaceShortcut.ts)。双击快捷方式 = 这个 Space 开在它自己的独立窗口里,不露出主窗。
 *
 * 图标三种来源,跟 Ribbon 上画的是同一个:
 *   · lucide 线条图标 → 现场挂一次拿到 <svg>,墨色画在纸色圆角底板上;
 *   · space.json 的 iconFile 是 SVG(单色蒙版)→ 同上,按轮廓填墨色;
 *   · iconFile 是 PNG(原色小图)→ 铺满底板。
 * 画不出来(没图标 / 解码失败)就不带图标,主进程照样建快捷方式。
 */
import { createElement } from 'react'
import { createRoot } from 'react-dom/client'
import { flushSync } from 'react-dom'
import { label, useSpaceStore } from '@lcl/engine'
import type { SpaceDefinition } from '@lcl/engine'
import { useApp } from './stores/appStore'
import { registerMessages, translate } from './i18n'

registerMessages({
  'spaceShortcut.fallbackName': { zh: 'Forsion Space', en: 'Forsion Space' },
  'spaceShortcut.toast.ok': { zh: '已添加到桌面，双击即可在独立窗口中打开「{name}」', en: 'Added to desktop. Double-click it to open {name} in its own window' },
  'spaceShortcut.toast.unpackaged': { zh: '桌面快捷方式只在安装版里可用（开发模式下不生成）', en: 'Desktop shortcuts only work in the installed app, not in development mode' },
  'spaceShortcut.toast.failed': { zh: '添加到桌面失败：{detail}', en: 'Could not add to desktop: {detail}' },
})

const SIZE = 1024
const INK = '#3a332d'

/** 底板几何:mac 照 Big Sur 图标栅格(824 / 1024,圆角 ≈ 22.5%,四周留阴影位);Windows / Linux 小尺寸也要看得清,底板铺得满一些。 */
function plateRect(platform: string | undefined): { x: number; size: number; radius: number } {
  return platform === 'darwin' ? { x: 100, size: 824, radius: 185 } : { x: 40, size: 944, radius: 200 }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = () => reject(new Error('icon image failed to load'))
    img.src = src
  })
}

/** 挂一次图标组件,取出它画出的 <svg> 序列化成独立的 SVG 文档(currentColor 换成墨色)。 */
function svgMarkupOf(Icon: NonNullable<SpaceDefinition['icon']>): string | null {
  const host = document.createElement('div')
  host.style.cssText = 'position:fixed;left:-10000px;top:0;width:0;height:0;overflow:hidden;pointer-events:none'
  document.body.appendChild(host)
  const root = createRoot(host)
  try {
    flushSync(() => root.render(createElement(Icon, { size: 24 })))
    const svg = host.querySelector('svg')
    if (!svg) return null
    const copy = svg.cloneNode(true) as SVGSVGElement
    copy.setAttribute('xmlns', 'http://www.w3.org/2000/svg')
    copy.setAttribute('width', '512')
    copy.setAttribute('height', '512')
    copy.removeAttribute('class')
    copy.setAttribute('color', INK)
    return new XMLSerializer().serializeToString(copy).replace(/currentColor/g, INK)
  } finally {
    root.unmount()
    host.remove()
  }
}

/** 画好的图标(PNG data URL);画不出来返回 undefined。 */
export async function renderSpaceIconPng(space: SpaceDefinition, platform = window.tangu?.platform): Promise<string | undefined> {
  const Icon = space.icon
  if (!Icon) return undefined
  const canvas = document.createElement('canvas')
  canvas.width = SIZE
  canvas.height = SIZE
  const ctx = canvas.getContext('2d')
  if (!ctx) return undefined
  const { x, size, radius } = plateRect(platform)
  const plate = (): void => { ctx.beginPath(); ctx.roundRect(x, x, size, size, radius) }

  // 纸色底板 + 一层很淡的落影(mac 图标栅格本来就给阴影留了位)。
  ctx.save()
  ctx.shadowColor = 'rgba(40, 30, 20, 0.22)'
  ctx.shadowBlur = platform === 'darwin' ? 28 : 12
  ctx.shadowOffsetY = platform === 'darwin' ? 12 : 4
  const paper = ctx.createLinearGradient(0, x, 0, x + size)
  paper.addColorStop(0, '#fffdf9')
  paper.addColorStop(1, '#efe8de')
  ctx.fillStyle = paper
  plate()
  ctx.fill()
  ctx.restore()

  const imageUrl = Icon.imageUrl
  try {
    if (imageUrl?.startsWith('data:image/png')) {
      // 原色小图:铺满底板(按底板圆角裁)。
      const img = await loadImage(imageUrl)
      ctx.save()
      plate()
      ctx.clip()
      ctx.drawImage(img, x, x, size, size)
      ctx.restore()
    } else {
      const glyph = Math.round(size * 0.56)
      const at = Math.round(x + (size - glyph) / 2)
      if (imageUrl?.startsWith('data:image/svg+xml')) {
        // 单色蒙版:先把轮廓画进离屏画布,再按轮廓填墨色。
        const img = await loadImage(imageUrl)
        const mask = document.createElement('canvas')
        mask.width = glyph
        mask.height = glyph
        const m = mask.getContext('2d')
        if (!m) return undefined
        m.drawImage(img, 0, 0, glyph, glyph)
        m.globalCompositeOperation = 'source-in'
        m.fillStyle = INK
        m.fillRect(0, 0, glyph, glyph)
        ctx.drawImage(mask, at, at)
      } else {
        const markup = svgMarkupOf(Icon)
        if (!markup) return undefined
        const img = await loadImage(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(markup)}`)
        ctx.drawImage(img, at, at, glyph, glyph)
      }
    }
  } catch (e) {
    console.warn('[space-shortcut] icon render failed:', e)
    return undefined
  }
  return canvas.toDataURL('image/png')
}

/** Ribbon 右键「添加到桌面」。结果一律 toast 告诉用户。 */
export async function addSpaceToDesktop(spaceId: string): Promise<void> {
  const make = window.tangu?.addSpaceToDesktop
  const space = useSpaceStore.getState().spaces.find((s) => s.id === spaceId)
  if (!make || !space) return
  const toast = (text: string, error = false): void => useApp.getState().toast(text, error)
  const name = label(space.name)
  try {
    const iconPng = await renderSpaceIconPng(space).catch(() => undefined)
    // fallbackName = 名字洗空时的桌面文件名,落盘产物命名跟界面语言走,由这边翻好再传。
    const result = await make({ id: space.id, name, fallbackName: translate('spaceShortcut.fallbackName'), iconPng })
    if (result.ok) toast(translate('spaceShortcut.toast.ok', { name }))
    else if (result.code === 'unpackaged') toast(translate('spaceShortcut.toast.unpackaged'), true)
    else toast(translate('spaceShortcut.toast.failed', { detail: result.detail || result.code }), true)
  } catch (e) {
    toast(translate('spaceShortcut.toast.failed', { detail: e instanceof Error ? e.message : String(e) }), true)
  }
}
