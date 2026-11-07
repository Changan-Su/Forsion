/**
 * Space 的「添加到桌面」—— 双击它,这个 Space 开在**它自己的独立窗口**里(不露出 Forsion 主窗)。
 *
 * 快捷方式里只有一条 deep link `forsion://space/<id>?window=standalone`,由主进程截下来直接开 Space 窗
 * (见 spaceWindowIdFromUrl 与 main.ts 的 openSpaceWindowFromLink),不交给主窗的渲染层。老版本不认 `window`
 * 参数,同一条链接退化成「主窗切到这个 Space」,不会报未知链接。
 *
 * 各平台落什么:
 *   · Windows:`.lnk`(shell.writeShortcutLink),目标 = Forsion.exe + 链接,图标 = 落在 userData 的 .ico,
 *     并带一个按 Space 分的 AppUserModelID —— Space 窗口用同一个 id(setAppDetails),任务栏上就是单独的一格、能单独固定。
 *   · macOS:一个**小 .app**(Info.plist + 一行 `open <链接>` 的脚本 + AppIcon.icns)。不用造物那种 .webloc:
 *     .webloc 是文档图标,不像一个 App,也放不进 Dock 左侧。脚本 .app 本机写出来不带隔离属性(quarantine),
 *     Gatekeeper 不审它,能直接双击;LSUIElement 让它跑那一下不在 Dock 里冒头。
 *     ⚠️ 限制:窗口归 Forsion 进程所有,Dock 上亮的是 Forsion 的图标,不会另起一个 Space 的 Dock 图标(Electron 做不到按窗分 Dock)。
 *   · Linux:`.desktop`,Icon 指向 userData 里的 png。
 *
 * 无 Electron 依赖(纯 node,可测);图标缩放、写 .lnk 由宿主注入。
 * ponytail: 只管放一个能点的东西,不做删除 / 改名同步;Space 被删了,快捷方式打开的窗会停在「这个 Space 还没准备好」。
 */
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ShortcutResult } from '../shared/products'
import { SPACE_ID_RE } from '../shared/spaceAppearance'
import { desktopValue, detailOf, execArg, safeShortcutName, taken, xml } from './productShortcut'

/** 链接上标「开成独立窗」的参数。 */
export const SPACE_WINDOW_PARAM = 'window'
export const SPACE_WINDOW_VALUE = 'standalone'
const MAX_SUFFIX = 99

export const isSpaceId = (id: unknown): id is string => typeof id === 'string' && SPACE_ID_RE.test(id)

/** 快捷方式里的那条链接。id 之外没有可变部分 —— Space 名字只决定文件名,永远不进链接。 */
export function spaceWindowLink(id: string): string {
  if (!isSpaceId(id)) throw new Error(`Invalid space id: ${String(id)}`)
  return `forsion://space/${id}?${SPACE_WINDOW_PARAM}=${SPACE_WINDOW_VALUE}`
}

/** 这条 forsion:// 是不是「把某个 Space 开成独立窗」;是 → Space id,否则 null(交回普通 deep link 流程)。 */
export function spaceWindowIdFromUrl(raw: unknown): string | null {
  if (typeof raw !== 'string' || raw.length > 4096) return null
  let u: URL
  try { u = new URL(raw.trim()) } catch { return null }
  if (u.protocol !== 'forsion:' || u.hostname.toLowerCase() !== 'space') return null
  if (u.searchParams.get(SPACE_WINDOW_PARAM) !== SPACE_WINDOW_VALUE) return null
  let id: string
  try { id = decodeURIComponent(u.pathname.replace(/^\//, '')) } catch { return null }
  return isSpaceId(id) ? id : null
}

/** 太长的 id 换成哈希,保证系统标识的长度上限(Windows AUMID ≤128)。 */
const shortId = (id: string, max: number): string =>
  id.length <= max ? id : createHash('sha256').update(id).digest('hex').slice(0, 32)

/** Windows:Space 窗与它的 .lnk 共用的 AppUserModelID(任务栏单独成组)。只用字母数字和点。 */
export function spaceAppUserModelId(id: string): string {
  return `Forsion.Space.${shortId(id, 100).replace(/[^A-Za-z0-9.]/g, '-')}`
}

/** macOS:小 .app 的 CFBundleIdentifier(只许字母数字、连字符、点)。 */
export function spaceBundleId(id: string): string {
  return `net.forsion.space-shortcut.${shortId(id, 100).replace(/[^A-Za-z0-9.-]/g, '-')}`
}

/** 图标文件在 userData 下的位置(Windows .ico / Linux .png;mac 的图标装在 .app 里,不落这里)。 */
export function spaceIconFile(iconDir: string, id: string, platform: NodeJS.Platform): string | null {
  if (!isSpaceId(id)) return null
  const ext = platform === 'win32' ? '.ico' : platform === 'linux' ? '.png' : null
  if (!ext) return null
  return path.join(iconDir, `${shortId(id, 100)}${ext}`)
}

/** Windows:记下快捷方式的显示名,Space 窗按它设任务栏的「固定」名(relaunchDisplayName)。有它 = 这个 Space 加过快捷方式。 */
export function spaceShortcutMetaFile(iconDir: string, id: string): string {
  return path.join(iconDir, `${shortId(id, 100)}.json`)
}

// ── 图标容器:都是「PNG 原样塞进去」的现代格式,不做像素转换 ─────────────────────────────

export interface SizedPng { size: number; png: Buffer }

export const MAC_ICON_SIZES = [16, 32, 64, 128, 256, 512, 1024]
export const WIN_ICON_SIZES = [16, 24, 32, 48, 64, 128, 256]
export const LINUX_ICON_SIZE = 512

/** 像素尺寸 → ICNS 条目类型(PNG 载荷,10.7+ 全认)。同一张图可以挂两个类型(1x 的 32 也是 16@2x)。 */
const ICNS_TYPES: Record<number, string[]> = {
  16: ['icp4'], 32: ['icp5', 'ic11'], 64: ['icp6', 'ic12'], 128: ['ic07'], 256: ['ic08', 'ic13'], 512: ['ic09', 'ic14'], 1024: ['ic10'],
}

export function buildIcns(images: SizedPng[]): Buffer {
  const parts: Buffer[] = []
  for (const { size, png } of images) {
    for (const type of ICNS_TYPES[size] ?? []) {
      const head = Buffer.alloc(8)
      head.write(type, 0, 'ascii')
      head.writeUInt32BE(png.length + 8, 4)
      parts.push(head, png)
    }
  }
  if (!parts.length) throw new Error('No icon sizes usable for icns')
  const body = Buffer.concat(parts)
  const head = Buffer.alloc(8)
  head.write('icns', 0, 'ascii')
  head.writeUInt32BE(body.length + 8, 4)
  return Buffer.concat([head, body])
}

/** PNG 载荷的 ICO(Vista 起全认)。宽高字段 0 = 256。 */
export function buildIco(images: SizedPng[]): Buffer {
  const list = images.filter((i) => i.size >= 1 && i.size <= 256)
  if (!list.length) throw new Error('No icon sizes usable for ico')
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(list.length, 4)
  const dir = Buffer.alloc(16 * list.length)
  let offset = 6 + dir.length
  list.forEach(({ size, png }, i) => {
    const o = i * 16
    dir.writeUInt8(size >= 256 ? 0 : size, o)
    dir.writeUInt8(size >= 256 ? 0 : size, o + 1)
    dir.writeUInt8(0, o + 2) // 调色板
    dir.writeUInt8(0, o + 3)
    dir.writeUInt16LE(1, o + 4) // planes
    dir.writeUInt16LE(32, o + 6) // bpp
    dir.writeUInt32LE(png.length, o + 8)
    dir.writeUInt32LE(offset, o + 12)
    offset += png.length
  })
  return Buffer.concat([header, dir, ...list.map((i) => i.png)])
}

// ── 规划:算出该平台要落什么(纯函数)──────────────────────────────────────────────

export type SpaceShortcutPlan =
  /** macOS .app:目录名 + 包内文件(相对路径)。 */
  | { kind: 'bundle'; name: string; files: Array<{ rel: string; content: string | Buffer; mode?: number }> }
  /** 单个文本文件(Linux .desktop)。 */
  | { kind: 'file'; name: string; content: string; mode?: number }
  /** Windows .lnk,由 writeShortcutLink 生成。 */
  | { kind: 'lnk'; name: string; args: string; description: string; appUserModelId: string }

export interface SpaceShortcutOpts {
  id: string
  name: string
  fallbackName?: string
  execPath: string
  appImage?: string
  /** mac:装进 .app 的图标;没有就是无图标的 .app(Finder 画通用 App 图标)。 */
  icns?: Buffer
  /** linux:Icon= 指向的 png 路径。 */
  iconPath?: string
}

/** 返回 null = 平台不支持。名字(stem)不含扩展名,写盘时再拼后缀与 ` (n)`。 */
export function spaceShortcutPlan(platform: NodeJS.Platform, opts: SpaceShortcutOpts): SpaceShortcutPlan | null {
  const link = spaceWindowLink(opts.id)
  const stem = safeShortcutName(opts.name, opts.fallbackName)
  if (platform === 'darwin') {
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>CFBundleExecutable</key>\t<string>launch</string>',
      `\t<key>CFBundleIdentifier</key>\t<string>${xml(spaceBundleId(opts.id))}</string>`,
      `\t<key>CFBundleName</key>\t<string>${xml(stem)}</string>`,
      `\t<key>CFBundleDisplayName</key>\t<string>${xml(stem)}</string>`,
      '\t<key>CFBundlePackageType</key>\t<string>APPL</string>',
      '\t<key>CFBundleShortVersionString</key>\t<string>1.0</string>',
      '\t<key>CFBundleVersion</key>\t<string>1</string>',
      ...(opts.icns ? ['\t<key>CFBundleIconFile</key>\t<string>AppIcon</string>'] : []),
      '\t<key>LSUIElement</key>\t<true/>',
      '\t<key>NSHighResolutionCapable</key>\t<true/>',
      `\t<key>ForsionSpaceId</key>\t<string>${xml(opts.id)}</string>`,
      '</dict>',
      '</plist>',
    ].join('\n') + '\n'
    // id 已过 SPACE_ID_RE(只有字母数字 . _ -),放进双引号里没有可展开的字符;名字绝不进脚本。
    const script = [
      '#!/bin/sh',
      '# Forsion Space shortcut: opens this Space in its own Forsion window.',
      `exec /usr/bin/open "${link}"`,
    ].join('\n') + '\n'
    const files: Array<{ rel: string; content: string | Buffer; mode?: number }> = [
      { rel: 'Contents/Info.plist', content: plist },
      { rel: 'Contents/PkgInfo', content: 'APPL????' },
      { rel: 'Contents/MacOS/launch', content: script, mode: 0o755 },
    ]
    if (opts.icns) files.push({ rel: 'Contents/Resources/AppIcon.icns', content: opts.icns })
    return { kind: 'bundle', name: stem, files }
  }
  if (platform === 'win32') {
    return { kind: 'lnk', name: stem, args: `"${link}"`, description: stem, appUserModelId: spaceAppUserModelId(opts.id) }
  }
  if (platform === 'linux') {
    const lines = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${desktopValue(stem)}`,
      `Exec=${execArg(opts.appImage || opts.execPath)} ${execArg(link)}`,
      'Terminal=false',
      'Categories=Utility;',
    ]
    if (opts.iconPath) lines.push(`Icon=${desktopValue(opts.iconPath)}`)
    return { kind: 'file', name: stem, content: lines.join('\n') + '\n', mode: 0o755 }
  }
  return null
}

// ── 落盘 ─────────────────────────────────────────────────────────────────────────────

export interface CreateSpaceShortcutDeps {
  platform?: NodeJS.Platform
  isPackaged: boolean
  desktopDir: string
  execPath: string
  appImage?: string
  fallbackName?: string
  /** 存 .ico / .png 的目录(userData 下),快捷方式与 Space 窗口都指向这里的图标。 */
  iconDir: string
  /** 渲染层画好的源图,按尺寸给出 PNG(宿主用 nativeImage 缩放);没有图标就不传。 */
  iconPng?: (size: number) => Buffer | undefined
  writeShortcutLink?: (path: string, options: { target: string; args: string; description?: string; icon?: string; iconIndex?: number; appUserModelId?: string }) => boolean
}

const pngs = (sizes: number[], iconPng: CreateSpaceShortcutDeps['iconPng']): SizedPng[] => {
  if (!iconPng) return []
  const out: SizedPng[] = []
  for (const size of sizes) {
    const png = iconPng(size)
    if (png?.length) out.push({ size, png })
  }
  return out
}

/** 把图标(及 Windows 的名字记录)写到 userData,原子换掉旧的:同一个 Space 再加一次 = 换新图。失败不挡快捷方式,只是没有自定义图标。 */
async function writeIconFile(file: string | null, data: Buffer | undefined): Promise<string | undefined> {
  if (!file || !data) return undefined
  try {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.tmp`
    await fs.writeFile(tmp, data)
    await fs.rename(tmp, file)
    return file
  } catch (e) {
    console.warn('[space-shortcut] icon not written:', detailOf(e))
    return undefined
  }
}

/**
 * 在系统桌面创建 Space 快捷方式。同名绝不覆盖,改用 `名字 (1)`、`(2)`……
 * dev 下恒拒:未打包时 execPath 是裸 electron,forsion:// 也只在安装版注册。
 */
/** 一次只建一个:Windows 那条是「先查名字没占、再写 .lnk」(writeShortcutLink 会覆盖),两个同名 Space 并发会写到同一个文件上(Codex 评审)。 */
let queue: Promise<unknown> = Promise.resolve()
export function createSpaceShortcut(space: { id: string; name: string }, deps: CreateSpaceShortcutDeps): Promise<ShortcutResult> {
  const run = queue.then(() => createSpaceShortcutNow(space, deps))
  queue = run.catch(() => {})
  return run
}

async function createSpaceShortcutNow(space: { id: string; name: string }, deps: CreateSpaceShortcutDeps): Promise<ShortcutResult> {
  if (!deps.isPackaged) return { ok: false, code: 'unpackaged' }
  const platform = deps.platform ?? process.platform
  if (!isSpaceId(space.id)) return { ok: false, code: 'not_found' }
  let plan: SpaceShortcutPlan | null
  let iconPath: string | undefined
  try {
    let icns: Buffer | undefined
    if (platform === 'darwin') {
      const list = pngs(MAC_ICON_SIZES, deps.iconPng)
      icns = list.length ? buildIcns(list) : undefined
    } else if (platform === 'win32') {
      const list = pngs(WIN_ICON_SIZES, deps.iconPng)
      iconPath = await writeIconFile(spaceIconFile(deps.iconDir, space.id, platform), list.length ? buildIco(list) : undefined)
    } else if (platform === 'linux') {
      iconPath = await writeIconFile(spaceIconFile(deps.iconDir, space.id, platform), deps.iconPng?.(LINUX_ICON_SIZE))
    }
    plan = spaceShortcutPlan(platform, {
      id: space.id, name: space.name, fallbackName: deps.fallbackName,
      execPath: deps.execPath, appImage: deps.appImage, icns, iconPath,
    })
  } catch (e) { return { ok: false, code: 'error', detail: detailOf(e) } }
  if (!plan) return { ok: false, code: 'unsupported' }

  const base = path.resolve(deps.desktopDir)
  const ext = plan.kind === 'bundle' ? '.app' : plan.kind === 'lnk' ? '.lnk' : '.desktop'
  try {
    if (!(await fs.stat(base)).isDirectory()) return { ok: false, code: 'error', detail: `Desktop path is not a directory: ${base}` }
    for (let n = 0; n <= MAX_SUFFIX; n++) {
      const target = path.join(base, n === 0 ? `${plan.name}${ext}` : `${plan.name} (${n})${ext}`)
      if (path.dirname(target) !== base) return { ok: false, code: 'error', detail: 'Shortcut name escaped the desktop directory' }
      if (plan.kind === 'lnk') {
        // writeShortcutLink 的 create 会覆盖:先查再写(同造物那条,竞态接受)。
        if (await taken(target)) continue
        if (!deps.writeShortcutLink) return { ok: false, code: 'error', detail: 'Shortcut writer is unavailable' }
        const options = {
          target: deps.execPath, args: plan.args, description: plan.description, appUserModelId: plan.appUserModelId,
          ...(iconPath ? { icon: iconPath, iconIndex: 0 } : {}),
        }
        if (!deps.writeShortcutLink(target, options)) return { ok: false, code: 'error', detail: 'Windows refused to write the shortcut' }
        // 任务栏身份要的名字;写不下只是 Space 窗不单独成组,快捷方式本身照样能用。
        await writeIconFile(spaceShortcutMetaFile(deps.iconDir, space.id), Buffer.from(JSON.stringify({ name: plan.name })))
        return { ok: true, path: target }
      }
      if (plan.kind === 'file') {
        const fh = await fs.open(target, 'wx', plan.mode ?? 0o644).catch((e: NodeJS.ErrnoException) => {
          if (e.code === 'EEXIST') return null
          throw e
        })
        if (!fh) continue
        try {
          await fh.writeFile(plan.content)
          if (plan.mode !== undefined) await fh.chmod(plan.mode)
        } finally { await fh.close() }
        return { ok: true, path: target }
      }
      // .app 是目录:mkdir 不带 recursive,已存在(文件 / 目录 / 软链)一律 EEXIST → 换下一个名字。
      try { await fs.mkdir(target) } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'EEXIST') continue
        throw e
      }
      try {
        for (const f of plan.files) {
          const file = path.join(target, f.rel)
          await fs.mkdir(path.dirname(file), { recursive: true })
          const fh = await fs.open(file, 'wx', f.mode ?? 0o644)
          try {
            await fh.writeFile(f.content)
            if (f.mode !== undefined) await fh.chmod(f.mode)
          } finally { await fh.close() }
        }
      } catch (e) {
        // 写了一半的 .app 双击会报「已损坏」:整个删掉再报错。只删自己刚建的这个目录。
        await fs.rm(target, { recursive: true, force: true }).catch(() => {})
        throw e
      }
      return { ok: true, path: target }
    }
    return { ok: false, code: 'error', detail: `More than ${MAX_SUFFIX} shortcuts named ${plan.name}` }
  } catch (e) { return { ok: false, code: 'error', detail: detailOf(e) } }
}
