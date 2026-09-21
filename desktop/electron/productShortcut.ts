/**
 * Creations(造物)Space 的「添加到桌面」—— 给一个 web 产物在系统桌面放一个快捷方式。
 *
 * ⚠️ 快捷方式里**永远不写 http URL**:预览源(codePreview 的 127.0.0.1:随机端口)是**每次启动才有**的,
 * 写进桌面文件第二天就指向空端口甚至别的进程。里面只有 deep link `forsion://open?view=product&id=<id>`,
 * 由 Forsion 拉起/唤醒后自己解析 id 去找产物 —— 项目改名、挪位置都不影响(id 在 sidecar 文件里,不在路径里)。
 *
 * 无 Electron 依赖(纯 node),宿主注入 isPackaged / desktopDir / execPath / shell.writeShortcutLink。
 * ponytail: 只管「放一个能点的文件」,不管注册表/开始菜单/Dock,也不做删除与改名同步。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import type { ShortcutResult } from '../shared/products'

/** 产物 id 白形态。与 productsRegistry 生成的 `p_<12hex>` 同口径;URL 里唯一的动态部分。 */
const ID = /^p_[0-9a-f]{12}$/
/** Windows 保留设备名。⚠️ 带扩展名也照样保留 —— `aux.log` 在 Win32 上解析到 AUX 设备,
 *  所以判的是**第一个点之前**那一段(于是 `console.log` 仍然放行)。 */
const RESERVED = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i
/** 文件名非法字符:控制字符(\p{Cc} 含 C1 段,比 U+0000-U+001F 多盖 U+0080-U+009F)
 *  + 双向覆写/隔离符 + Windows 禁用集(`/` 同时是三个平台的路径分隔,必须走)。
 *  双向那几个单列出来写、而**不是**整片 \p{Cf}:U+202E 之流会让资源管理器把 `x.lnk` 倒着渲染成 `knl.x`
 *  (经典 LNK-RTLO 伪装);但 \p{Cf} 里还有 ZWJ(U+200D),剥了就把组合 emoji 拆散,所以整片不能碰。
 *  源码里不留真控制字节(见 productsRegistry 同款纪律),这里一律写 \u 转义。 */
const ILLEGAL = /[\p{Cc}\u200e\u200f\u202a-\u202e\u2066-\u2069<>:"/\\|?*]/gu
/** 只用来判「这名字是不是等于没有」。⚠️ 有 /g 就只准 replace,别拿去 test(lastIndex 有状态,隔次调用会假阴性)。 */
const FORMAT = /\p{Cf}/gu
/** 最后一道兜底。⚠️ 落盘产物名按 CLAUDE.md 要跟界面语言走,正常路径是调用方传本地化的 fallbackName 进来;
 *  这个英文串只在「没传 / 传进来的那个也脏」时才露面。 */
const FALLBACK = 'Forsion App'
const MAX_STEM = 80
/** NAME_MAX 是 255 **字节**不是字符:80 个四字节 emoji = 320,加扩展名和 ` (99)` 必 ENAMETOOLONG。 */
const MAX_STEM_BYTES = 240
const MAX_SUFFIX = 99

/** 产物 deep link。id 之外没有任何可变部分 —— **产物名永远不进 URL**(名字只决定文件名)。 */
export function productDeepLink(id: string): string {
  if (typeof id !== 'string' || !ID.test(id)) throw new Error(`Invalid product id: ${String(id)}`)
  return `forsion://open?view=product&id=${id}`
}

/** 洗成一个跨平台可用的单段文件名主干;洗不出能用的(空 / 只剩格式字符 / Windows 保留设备名)就返回空串。 */
function cleanStem(name: string): string {
  const cleaned = (typeof name === 'string' ? name : '')
    .normalize('NFC')
    .replace(ILLEGAL, '')
    .replace(/\s+/g, ' ')
    .trim()
  // 按码点截断:slice() 会把 emoji / 生僻字的代理对劈成孤立半码元,落盘要么失败要么是乱码。
  const capped = Array.from(cleaned).slice(0, MAX_STEM)
  while (capped.length && Buffer.byteLength(capped.join('')) > MAX_STEM_BYTES) capped.pop()
  const stem = capped.join('').replace(/^[.\s]+/, '').replace(/[.\s]+$/, '')
  // trim() 抓不住零宽:U+200B 之流不在 JS 的 \s 里,剥掉格式字符再看还剩不剩东西 ——
  // 全零宽的名字落到桌面上就是一个光秃秃的 `.webloc`,跟没名字一样,得走兜底。
  // 组合记号(\p{M},含 VS16 U+FE0F)同理:只剩它们的名字渲染出来也是空的。
  if (!stem.replace(FORMAT, '').replace(/\p{M}/gu, '').trim()) return ''
  // Win32 按「第一个点之前、去掉尾随空格」判保留名:`con .txt` 同样解析到 CON 设备。
  return RESERVED.test(stem.split('.')[0].trim()) ? '' : stem
}

/** 跨平台可用的单段文件名主干(不含扩展名)。中日韩原样保留,只砍真正会出事的字符。
 *  fallbackName = 调用方给的本地化兜底名(跟界面语言走),它自己也要过同一把筛子。 */
export function safeShortcutName(name: string, fallbackName?: string): string {
  return cleanStem(name) || cleanStem(fallbackName ?? '') || FALLBACK
}

/** plist 里的 URL 文本。 */
const xml = (value: string): string =>
  value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')

/** Desktop Entry 的 string 值转义(spec §Value types):反斜杠与换行。换行不转义 = 可注入新的 key 行。 */
const desktopValue = (value: string): string =>
  value.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\r/g, '\\r')

// Exec 的引号参数是**两层**转义:先按引号规则给 " ` $ \ 前置一个反斜杠,再按 string 值规则把反斜杠翻倍
// (spec 明说字面反斜杠要写成四个)。`%` 是 field code 引导符,字面 % 必须写成 %%,否则整行被 glib 吃掉一截。
const EXEC_ESCAPE: Record<string, string> = {
  '"': '\\\\"', '`': '\\\\`', $: '\\\\$', '\\': '\\\\\\\\', '\n': '\\n', '\r': '\\r', '%': '%%',
}
const execArg = (value: string): string => `"${value.replace(/["`$\\\n\r%]/g, (c) => EXEC_ESCAPE[c])}"`

/** content 为 null = 该平台不是「写文件」而是由 writeShortcutLink 生成(Windows .lnk)。 */
export interface ShortcutFile {
  fileName: string
  content: string | null
  mode?: number
}

/** 纯函数:算出该平台要落的文件名与内容。返回 null = 平台不支持。
 *  ponytail: 相对契约多收一个可选 iconPath —— 否则 Linux 的 `Icon=` 只能由调用方再拼一遍 .desktop 文本。 */
export function shortcutFileFor(
  platform: NodeJS.Platform,
  opts: { id: string; name: string; execPath: string; appImage?: string; iconPath?: string; fallbackName?: string },
): ShortcutFile | null {
  const link = productDeepLink(opts.id)
  const stem = safeShortcutName(opts.name, opts.fallbackName)
  if (platform === 'darwin') {
    const content = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
      '<plist version="1.0">',
      '<dict>',
      '\t<key>URL</key>',
      `\t<string>${xml(link)}</string>`,
      '</dict>',
      '</plist>',
    ].join('\n') + '\n'
    return { fileName: `${stem}.webloc`, content }
  }
  if (platform === 'win32') return { fileName: `${stem}.lnk`, content: null }
  if (platform === 'linux') {
    // AppImage 里 process.execPath 指向挂载点(下次启动就没了),$APPIMAGE 才是磁盘上那个文件。
    const lines = [
      '[Desktop Entry]',
      'Type=Application',
      `Name=${desktopValue(stem)}`,
      `Exec=${execArg(opts.appImage || opts.execPath)} ${execArg(link)}`,
      'Terminal=false',
      'Categories=Utility;', // list 类型的值按 spec 以 `;` 收尾
    ]
    if (opts.iconPath) lines.push(`Icon=${desktopValue(opts.iconPath)}`)
    return { fileName: `${stem}.desktop`, content: lines.join('\n') + '\n', mode: 0o755 }
  }
  return null
}

export interface CreateShortcutDeps {
  platform?: NodeJS.Platform
  isPackaged: boolean
  desktopDir: string
  execPath: string
  /** Linux AppImage 构建的 process.env.APPIMAGE。 */
  appImage?: string
  /** 可选图标:win 传 .ico,linux 传 .png。 */
  iconPath?: string
  /** 产物名洗不出东西时用的兜底名,由渲染层按界面语言 translate 后经 IPC 传进来
   *  (落盘产物名必须跟随语言,本模块不碰 i18n)。没传 / 它自己也脏 → 退回内置的 'Forsion App'。 */
  fallbackName?: string
  /** electron shell.writeShortcutLink,由宿主注入(本模块不碰 Electron)。 */
  writeShortcutLink?: (path: string, options: { target: string; args: string; description?: string; icon?: string; iconIndex?: number }) => boolean
}

const detailOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/** 路径上已经有东西(含指向不存在目标的断链)就算被占。 */
async function taken(target: string): Promise<boolean> {
  try { await fs.lstat(target); return true }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e }
}

/**
 * 在系统桌面创建产物快捷方式。同名文件**绝不覆盖**,改用 `名字 (1)`、`(2)`…… 递增。
 * dev 下恒拒:未打包时 process.execPath 是裸 electron 二进制,且 forsion:// scheme 只在打包安装时注册。
 */
export async function createProductShortcut(product: { id: string; name: string }, deps: CreateShortcutDeps): Promise<ShortcutResult> {
  if (!deps.isPackaged) return { ok: false, code: 'unpackaged' }
  const platform = deps.platform ?? process.platform
  let link: string
  let plan: ShortcutFile | null
  try {
    link = productDeepLink(product.id)
    plan = shortcutFileFor(platform, {
      id: product.id, name: product.name, execPath: deps.execPath,
      appImage: deps.appImage, iconPath: deps.iconPath, fallbackName: deps.fallbackName,
    })
  } catch (e) { return { ok: false, code: 'error', detail: detailOf(e) } }
  if (!plan) return { ok: false, code: 'unsupported' }

  const base = path.resolve(deps.desktopDir)
  const ext = path.extname(plan.fileName)
  const stem = plan.fileName.slice(0, plan.fileName.length - ext.length)
  try {
    // 先确认桌面目录真的在:不然 Windows 那条分支只会看到「文件名没被占」,然后对着不存在的目录报成功。
    if (!(await fs.stat(base)).isDirectory()) return { ok: false, code: 'error', detail: `Desktop path is not a directory: ${base}` }
    for (let n = 0; n <= MAX_SUFFIX; n++) {
      const target = path.join(base, n === 0 ? `${stem}${ext}` : `${stem} (${n})${ext}`)
      // 文件名已被 safeShortcutName 去掉了分隔符与首尾点;这里再钉一次,防日后放宽过滤时悄悄越出桌面。
      if (path.dirname(target) !== base) return { ok: false, code: 'error', detail: 'Shortcut name escaped the desktop directory' }
      if (plan.content === null) {
        // ponytail: writeShortcutLink 默认 op=create 会**覆盖**,只能先查再写 —— 两步之间的竞态接受
        // (桌面不是并发写入的地方),换不覆盖的原子写就得自己拼 .lnk 二进制。
        if (await taken(target)) continue
        if (!deps.writeShortcutLink) return { ok: false, code: 'error', detail: 'Shortcut writer is unavailable' }
        const options = deps.iconPath
          ? { target: deps.execPath, args: `"${link}"`, description: stem, icon: deps.iconPath, iconIndex: 0 }
          : { target: deps.execPath, args: `"${link}"`, description: stem }
        if (!deps.writeShortcutLink(target, options)) return { ok: false, code: 'error', detail: 'Windows refused to write the shortcut' }
        return { ok: true, path: target }
      }
      // O_CREAT|O_EXCL:软链、目录、普通文件占位一律 EEXIST,不会顺着别人的软链把文件写飞。
      const fh = await fs.open(target, 'wx', plan.mode ?? 0o644).catch((e: NodeJS.ErrnoException) => {
        if (e.code === 'EEXIST') return null
        throw e
      })
      if (!fh) continue
      try {
        await fh.writeFile(plan.content)
        // open 的 mode 过 umask,可执行位会被吃掉;补 chmod 走**句柄**不走路径 —— 按路径就是第二次解析,又开一个 TOCTOU 窗口。
        if (plan.mode !== undefined) await fh.chmod(plan.mode)
      } finally { await fh.close() }
      return { ok: true, path: target }
    }
    return { ok: false, code: 'error', detail: `More than ${MAX_SUFFIX} shortcuts named ${stem}` }
  } catch (e) { return { ok: false, code: 'error', detail: detailOf(e) } }
}
