import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { promises as fs, writeFileSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { createProductShortcut, productDeepLink, safeShortcutName, shortcutFileFor, type CreateShortcutDeps } from './productShortcut'

/** 注入的 shell.writeShortcutLink 签名;不带它 vi.fn 会推成零参,mock.calls[0][1] 取不到。 */
type Writer = NonNullable<CreateShortcutDeps['writeShortcutLink']>

const ID = 'p_0123456789ab'
const LINK = 'forsion://open?view=product&id=p_0123456789ab'
const EXEC = '/Applications/Forsion.app/Contents/MacOS/Forsion'
const WIN_HOST = process.platform === 'win32'
/** 组合 emoji:中间的 ZWJ 属于 \p{Cf},被当成格式字符剥掉就散成三个单人。 */
const FAMILY = '\u{1F468}\u200D\u{1F469}\u200D\u{1F467}'
/** 红心 + VS16:VS16 不是 \p{Cf},剥错了会从彩色 emoji 退回黑白符号。 */
const HEART = '\u2764\uFE0F'

let home: string
let desktop: string
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'product-shortcut-')))
  desktop = path.join(home, 'Desktop')
  await fs.mkdir(desktop)
})
afterEach(async () => {
  vi.restoreAllMocks()
  await fs.rm(home, { recursive: true, force: true })
})

const deps = (extra: Partial<CreateShortcutDeps> = {}): CreateShortcutDeps =>
  ({ isPackaged: true, desktopDir: desktop, execPath: EXEC, ...extra })
const product = (name = 'My Product'): { id: string; name: string } => ({ id: ID, name })
const read = (file: string): Promise<string> => fs.readFile(file, 'utf8')
/** 桌面上真实躺着的文件名。文件系统可能按 NFD 存(HFS+),读回来先归一再比 ——
 *  这里要钉的是模块没把字弄丢,不是文件系统的归一化口径。 */
const onDesktop = async (): Promise<string[]> => (await fs.readdir(desktop)).map((e) => e.normalize('NFC')).sort()
/** 有没有落单的半个码元:Array.from 会把孤立代理当成一个「字符」吐出来,劈开的代理对这里抓得到。 */
const hasLoneSurrogate = (v: string): boolean =>
  Array.from(v).some((c) => { const cp = c.codePointAt(0) ?? 0; return cp >= 0xd800 && cp <= 0xdfff })

describe('productDeepLink', () => {
  it('只含 id,不含任何 http 源', () => {
    expect(productDeepLink(ID)).toBe(LINK)
    expect(productDeepLink('p_ffffffffffff')).toBe('forsion://open?view=product&id=p_ffffffffffff')
  })

  it('拒绝一切非 `p_<12hex>`', () => {
    const bad = ['', 'p_', ID.toUpperCase(), 'p_0123456789a', 'p_0123456789abc', 'x_0123456789ab', 'p_0123456789ag',
      `${ID} `, `${ID}&view=evil`, 'p_0123456789ab/../x', '../../etc/passwd']
    for (const id of bad) expect(() => productDeepLink(id)).toThrow(/Invalid product id/)
    expect(() => productDeepLink(undefined as unknown as string)).toThrow(/Invalid product id/)
    expect(() => productDeepLink(null as unknown as string)).toThrow(/Invalid product id/)
  })
})

describe('safeShortcutName', () => {
  it.each([
    ['My Product', 'My Product'],
    ['  留白  ', '留白'],                          // CJK 原样保留
    ['扶桑 造物 Space', '扶桑 造物 Space'],
    ['日本語のノート', '日本語のノート'],
    ['cafe\u0301', 'caf\u00E9'],                   // NFD 输入归一成 NFC,别在磁盘上留两种写法
    ['a/b\\c:d*e?f"g<h>i|j', 'abcdefghij'],        // 跨平台非法字符
    ['a\nb\tc', 'abc'],                            // 控制字符先被剔除,不留空格
    ['a  b   c', 'a b c'],                         // 空白折叠
    ['...hidden...', 'hidden'],                    // 首尾点
    ['  . a . ', 'a'],
    ['', 'Forsion App'],
    ['   ', 'Forsion App'],
    ['..', 'Forsion App'],
    ['???', 'Forsion App'],                        // 全被剔除 → 兜底
    // 路径穿越:分隔符被剔、首尾点被剥,剩下的只是个普通单段名,出不了桌面目录
    ['../../../../etc/cron.d/x', 'etccron.dx'],
    ['..\\..\\..\\evil', 'evil'],
    ['./../.ssh/authorized_keys', 'sshauthorized_keys'],
    ['con', 'Forsion App'], ['CON', 'Forsion App'], ['PrN', 'Forsion App'], ['aux', 'Forsion App'],
    ['nul', 'Forsion App'], ['com1', 'Forsion App'], ['COM9', 'Forsion App'], ['lpt1', 'Forsion App'], ['lpt9', 'Forsion App'],
    // ⚠️ 保留设备名**带扩展名也保留**:Win32 按第一个点之前的段解析,`aux.log` 照样指向 AUX 设备
    ['con.txt', 'Forsion App'], ['CON.TXT', 'Forsion App'], ['aux.log', 'Forsion App'], ['nul.md', 'Forsion App'],
    // 点之前带尾随空格同样解析到设备;只剩组合记号 / VS16 的名字渲染出来是空的
    ['con .txt', 'Forsion App'], ['aux  .log', 'Forsion App'], ['\uFE0F\uFE0F', 'Forsion App'], ['\u0301', 'Forsion App'],
    ['com1.x', 'Forsion App'], ['CON.TXT.v2', 'Forsion App'], ['con.v2', 'Forsion App'], ['lpt9.tar.gz', 'Forsion App'],
    // 反面:只有「第一个点之前那段」整段相等才算保留名
    ['console', 'console'], ['console.log', 'console.log'], ['com0', 'com0'], ['com10', 'com10'],
    ['nulla', 'nulla'], ['nulla.txt', 'nulla.txt'], ['my con.txt', 'my con.txt'], ['acon.log', 'acon.log'],
  ])('%j → %j', (input, expected) => {
    expect(safeShortcutName(input)).toBe(expected)
  })

  it('截到 80 个码点,且不劈开代理对', () => {
    expect(safeShortcutName('x'.repeat(200))).toBe('x'.repeat(80))
    expect(safeShortcutName('字'.repeat(100))).toBe('字'.repeat(80))
    const capped = safeShortcutName(`${'a'.repeat(79)}😀tail`)
    expect(capped).toBe(`${'a'.repeat(79)}😀`)     // 逐字相等:按码元截断会在这里留下半个 😀
    expect(Array.from(capped)).toHaveLength(80)
    expect(hasLoneSurrogate(capped)).toBe(false)   // 整串扫一遍,不是只看被切掉的那一截
  })

  it('还要按字节收口:NAME_MAX 是 255 字节,四字节 emoji 撑得爆', () => {
    const emoji = safeShortcutName('😀'.repeat(100))
    expect(Buffer.byteLength(emoji)).toBeLessThanOrEqual(240)
    expect(Array.from(emoji).every((c) => c === '😀')).toBe(true) // 只是少了几个,没有半个
    expect(hasLoneSurrogate(emoji)).toBe(false)
    expect(Buffer.byteLength(safeShortcutName('字'.repeat(100)))).toBe(240) // 3 字节 × 80,刚好不动
  })

  it('C0 / C1 控制字符都剔除', () => {
    expect(safeShortcutName('a\u0000b\u001Fc')).toBe('abc')
    expect(safeShortcutName('a\u0085b\u009Fc')).toBe('abc')
    expect(safeShortcutName('a\u007Fb')).toBe('ab')
  })

  it('剥掉双向覆写 / 隔离符:U+202E 能把 .lnk 在资源管理器里显示成 .png', () => {
    expect(safeShortcutName('report\u202Egnp.lnk')).toBe('reportgnp.lnk')
    expect(safeShortcutName('a\u202Ab\u202Bc\u202Cd\u202Ee')).toBe('abcde')
    expect(safeShortcutName('a\u2066b\u2067c\u2068d\u2069e')).toBe('abcde')
    expect(safeShortcutName('a\u200Eb\u200Fc')).toBe('abc')
    expect(shortcutFileFor('win32', { id: ID, name: 'report\u202Egnp.lnk', execPath: EXEC }))
      .toEqual({ fileName: 'reportgnp.lnk.lnk', content: null })
  })

  it('但 ZWJ 与 VS16 必须活着 —— 整片 \\p{Cf} 一剥,组合 emoji 就散架', () => {
    expect(safeShortcutName(FAMILY)).toBe(FAMILY)
    expect(Array.from(safeShortcutName(FAMILY))).toHaveLength(5) // 人 ZWJ 人 ZWJ 人
    expect(safeShortcutName(HEART)).toBe(HEART)
    expect(safeShortcutName(`我的${FAMILY}相册`)).toBe(`我的${FAMILY}相册`)
  })

  it('只剩格式字符 = 等于没有名字,走兜底(否则桌面上是个光秃秃的 .webloc)', () => {
    expect(safeShortcutName('\u200B\u200B\u200B')).toBe('Forsion App')
    expect(safeShortcutName('\u200D')).toBe('Forsion App')
    expect(safeShortcutName('\u200B \u200C ')).toBe('Forsion App')
    expect(safeShortcutName('\uFEFF')).toBe('Forsion App') // BOM 恰好在 JS 的 \s 里,本来就兜得住
    expect(safeShortcutName('a\u200Bb')).toBe('a\u200Bb')  // 有真内容就不动它:只有「全是格式字符」才算空
  })

  it('截断后再剥首尾点与空格', () => {
    expect(safeShortcutName(`${'a'.repeat(78)} . b`)).toBe('a'.repeat(78))
  })
})

describe('safeShortcutName 的本地化兜底名', () => {
  it('名字本身可用时,兜底名完全不参与', () => {
    expect(safeShortcutName('My Product', '扶桑应用')).toBe('My Product')
    expect(safeShortcutName('console.log', '扶桑应用')).toBe('console.log')
  })

  it('名字洗不出东西 → 用调用方给的本地化名(而不是写死的英文)', () => {
    expect(safeShortcutName('', '扶桑应用')).toBe('扶桑应用')
    expect(safeShortcutName('   ', '扶桑应用')).toBe('扶桑应用')
    expect(safeShortcutName('???', 'Forsion アプリ')).toBe('Forsion アプリ')
    expect(safeShortcutName('aux.log', '扶桑应用')).toBe('扶桑应用')
    expect(safeShortcutName('\u200B', '扶桑应用')).toBe('扶桑应用')
  })

  it('兜底名自己也过同一把筛子', () => {
    expect(safeShortcutName('', ' 扶桑/应用 ')).toBe('扶桑应用')
    expect(safeShortcutName('', '...x...')).toBe('x')
    expect(safeShortcutName('', 'a\u202Eb')).toBe('ab')
    expect(safeShortcutName('', '字'.repeat(100))).toBe('字'.repeat(80))
  })

  it('兜底名自己也脏 → 才退回内置英文名', () => {
    expect(safeShortcutName('', '???')).toBe('Forsion App')
    expect(safeShortcutName('', '   ')).toBe('Forsion App')
    expect(safeShortcutName('', 'con')).toBe('Forsion App')
    expect(safeShortcutName('', 'aux.log')).toBe('Forsion App')
    expect(safeShortcutName('', '\u200B\u200B')).toBe('Forsion App')
  })

  it('跨 IPC 来的非字符串不当真', () => {
    expect(safeShortcutName('', 123 as unknown as string)).toBe('Forsion App')
    expect(safeShortcutName('', null as unknown as string)).toBe('Forsion App')
    expect(safeShortcutName('', undefined)).toBe('Forsion App')
  })

  it('shortcutFileFor 与 createProductShortcut 都吃这个兜底', async () => {
    expect(shortcutFileFor('win32', { id: ID, name: '', execPath: EXEC, fallbackName: '扶桑应用' }))
      .toEqual({ fileName: '扶桑应用.lnk', content: null })
    expect(shortcutFileFor('linux', { id: ID, name: '???', execPath: EXEC, fallbackName: '扶桑应用' })?.fileName)
      .toBe('扶桑应用.desktop')
    const got = await createProductShortcut(product('   '), deps({ platform: 'darwin', fallbackName: '扶桑应用' }))
    expect(got).toEqual({ ok: true, path: path.join(desktop, '扶桑应用.webloc') })
    expect(await onDesktop()).toEqual(['扶桑应用.webloc'])
  })

  it('没传 fallbackName 时还是内置英文名(向后兼容)', async () => {
    const got = await createProductShortcut(product('   '), deps({ platform: 'darwin' }))
    expect(got).toEqual({ ok: true, path: path.join(desktop, 'Forsion App.webloc') })
  })
})

describe('shortcutFileFor(纯函数)', () => {
  it('未知平台返回 null', () => {
    expect(shortcutFileFor('freebsd', { id: ID, name: 'X', execPath: EXEC })).toBeNull()
    expect(shortcutFileFor('aix', { id: ID, name: 'X', execPath: EXEC })).toBeNull()
  })

  it('windows 只给文件名,内容留给 writeShortcutLink', () => {
    expect(shortcutFileFor('win32', { id: ID, name: 'My Product', execPath: EXEC })).toEqual({ fileName: 'My Product.lnk', content: null })
  })

  it('坏 id 直接抛(纯函数不吞)', () => {
    expect(() => shortcutFileFor('darwin', { id: 'nope', name: 'X', execPath: EXEC })).toThrow(/Invalid product id/)
  })
})

describe('macOS .webloc', () => {
  const WEBLOC = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    '<dict>',
    '\t<key>URL</key>',
    '\t<string>forsion://open?view=product&amp;id=p_0123456789ab</string>',
    '</dict>',
    '</plist>',
    '',
  ].join('\n')

  it('落盘内容逐字节固定,URL 的 & 已 XML 转义', async () => {
    const got = await createProductShortcut(product(), deps({ platform: 'darwin' }))
    expect(got).toEqual({ ok: true, path: path.join(desktop, 'My Product.webloc') })
    expect(await read(path.join(desktop, 'My Product.webloc'))).toBe(WEBLOC)
  })

  it('不含任何预览源(每次启动都会变的 127.0.0.1:port)', async () => {
    await createProductShortcut(product(), deps({ platform: 'darwin' }))
    const content = await read(path.join(desktop, 'My Product.webloc'))
    expect(content).not.toContain('127.0.0.1')
    expect(content).not.toContain('localhost')
    expect(content.match(/https?:\/\/[^\s"]+/g)).toEqual(['http://www.apple.com/DTDs/PropertyList-1.0.dtd']) // 只有 DTD
  })

  it('恶意名字只影响文件名,URL 一个字都不变', async () => {
    const got = await createProductShortcut(product(' a"b<c>&\'d$`e '), deps({ platform: 'darwin' }))
    expect(got).toEqual({ ok: true, path: path.join(desktop, "abc&'d$`e.webloc") })
    const content = await read(path.join(desktop, "abc&'d$`e.webloc"))
    expect(content).toBe(WEBLOC)
    expect(content).not.toContain('abc') // 名字永远不进 URL
  })

  // 纯函数层断言过 CJK 了,但契约点名的中日韩恰恰是 NFC/NFD 会出事的那一类,得真落一次盘再读回来。
  it('CJK 名字端到端:写进真目录、readdir 读回来逐字相等,第二次进 (1)', async () => {
    const name = '扶桑 造物 Space'
    const first = await createProductShortcut(product(name), deps({ platform: 'darwin' }))
    expect(first).toEqual({ ok: true, path: path.join(desktop, `${name}.webloc`) })
    expect(await onDesktop()).toEqual([`${name}.webloc`])
    expect(await read(path.join(desktop, `${name}.webloc`))).toBe(WEBLOC) // 返回的 path 本身就能打开
    const second = await createProductShortcut(product(name), deps({ platform: 'darwin' }))
    expect(second).toEqual({ ok: true, path: path.join(desktop, `${name} (1).webloc`) })
    expect(await onDesktop()).toEqual([`${name} (1).webloc`, `${name}.webloc`])
  })

  it('日文与组合 emoji 也能真落盘', async () => {
    const got = await createProductShortcut(product(`日本語のノート${FAMILY}`), deps({ platform: 'darwin' }))
    expect(got).toEqual({ ok: true, path: path.join(desktop, `日本語のノート${FAMILY}.webloc`) })
    expect(await onDesktop()).toEqual([`日本語のノート${FAMILY}.webloc`])
  })
})

describe('Linux .desktop', () => {
  const file = (stem = 'My Product'): string => path.join(desktop, `${stem}.desktop`)
  const DESKTOP = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=My Product',
    `Exec="${EXEC}" "${LINK}"`,
    'Terminal=false',
    'Categories=Utility;',
    '',
  ].join('\n')

  it('落盘内容逐字节固定', async () => {
    const got = await createProductShortcut(product(), deps({ platform: 'linux' }))
    expect(got).toEqual({ ok: true, path: file() })
    const content = await read(file())
    expect(content).toBe(DESKTOP)
    expect(content).not.toContain('http')
  })

  // ⚠️ 设 umask 只在 vitest 的 pool:'forks'(3.x 缺省)下可用;换成 threads 会抛 ERR_WORKER_UNSUPPORTED_OPERATION。
  it.skipIf(WIN_HOST)('权限 0o755,且不被 umask 吃掉可执行位', async () => {
    const previous = process.umask(0o077)
    try {
      await createProductShortcut(product(), deps({ platform: 'linux' }))
      expect((await fs.stat(file())).mode & 0o777).toBe(0o755)
    } finally { process.umask(previous) }
  })

  it('AppImage 构建用 $APPIMAGE 而不是挂载点里的 execPath', async () => {
    await createProductShortcut(product(), deps({ platform: 'linux', appImage: '/home/u/Apps/Forsion.AppImage' }))
    expect(await read(file())).toContain('Exec="/home/u/Apps/Forsion.AppImage" "forsion://open?view=product&id=p_0123456789ab"')
  })

  it('可选图标写成 Icon=', async () => {
    await createProductShortcut(product(), deps({ platform: 'linux', iconPath: '/opt/forsion/icon.png' }))
    expect((await read(file())).split('\n')).toContain('Icon=/opt/forsion/icon.png')
  })

  it('敌意 iconPath 的换行同样注入不出第二个 Exec 行', async () => {
    await createProductShortcut(product(), deps({ platform: 'linux', iconPath: '/i.png\nExec=/bin/sh' }))
    const lines = (await read(file())).split('\n')
    expect(lines.filter((l) => l.startsWith('Exec='))).toHaveLength(1)
    expect(lines).toContain('Icon=/i.png\\nExec=/bin/sh') // 转义成一行的字面量,不是真换行
    expect(lines).toContain(`Exec="${EXEC}" "${LINK}"`)
  })

  it('Name 里的 $ 反引号 & 都是字面量(引号规则只作用于 Exec 参数)', async () => {
    await createProductShortcut(product(' a"b<c>&\'d$`e '), deps({ platform: 'linux' }))
    const lines = (await read(file("abc&'d$`e"))).split('\n')
    expect(lines).toContain("Name=abc&'d$`e")
    expect(lines).toContain(`Exec="${EXEC}" "${LINK}"`)
  })

  it('Exec 参数按 spec 双层转义:保留字符前缀 \\\\、字面反斜杠变四个、% 变 %%', async () => {
    // 输入路径: /opt/for"sion App/$app\bin\`x%y
    const hostile = '/opt/for"sion App/$app\\bin\\`x%y'
    await createProductShortcut(product(), deps({ platform: 'linux', execPath: hostile }))
    const expectedArg = [
      '/opt/for', '\\\\', '"',       // "  → \\"
      'sion App/', '\\\\', '$',      // $  → \\$
      'app', '\\\\\\\\',             // \  → \\\\ (引号规则的 \" 再过一次 string 值转义)
      'bin', '\\\\\\\\',             // \  → \\\\
      '\\\\', '`',                   // `  → \\`
      'x', '%%', 'y',                // %  → %%(field code 引导符)
    ].join('')
    expect((await read(file())).split('\n')).toContain(`Exec="${expectedArg}" "${LINK}"`)
  })

  it('换行无法注入新的 Desktop Entry 键', async () => {
    await createProductShortcut(product(), deps({ platform: 'linux', execPath: '/bin/x\nExec=/bin/sh' }))
    const lines = (await read(file())).split('\n')
    expect(lines.filter((l) => l.startsWith('Exec='))).toHaveLength(1)
    expect(lines).toContain(`Exec="/bin/x\\nExec=/bin/sh" "${LINK}"`)
  })
})

describe('Windows .lnk(注入 shell.writeShortcutLink)', () => {
  const lnk = (stem = 'My Product'): string => path.join(desktop, `${stem}.lnk`)

  it('把 deep link 当 argv 参数交给注入的写入器', async () => {
    const writeShortcutLink = vi.fn<Writer>(() => true)
    const got = await createProductShortcut(product(), deps({ platform: 'win32', execPath: 'C:\\Forsion\\Forsion.exe', writeShortcutLink }))
    expect(got).toEqual({ ok: true, path: lnk() })
    expect(writeShortcutLink).toHaveBeenCalledTimes(1)
    expect(writeShortcutLink).toHaveBeenCalledWith(lnk(), {
      target: 'C:\\Forsion\\Forsion.exe', args: `"${LINK}"`, description: 'My Product',
    })
  })

  it('带图标时补 icon / iconIndex', async () => {
    const writeShortcutLink = vi.fn<Writer>(() => true)
    await createProductShortcut(product(), deps({ platform: 'win32', writeShortcutLink, iconPath: 'C:\\Forsion\\app.ico' }))
    expect(writeShortcutLink.mock.calls[0][1]).toMatchObject({ icon: 'C:\\Forsion\\app.ico', iconIndex: 0 })
  })

  it('写入器返回 false → error', async () => {
    const writeShortcutLink = vi.fn<Writer>(() => false)
    expect(await createProductShortcut(product(), deps({ platform: 'win32', writeShortcutLink })))
      .toEqual({ ok: false, code: 'error', detail: expect.stringContaining('refused') })
  })

  it('没有写入器 → error,不谎报成功', async () => {
    expect(await createProductShortcut(product(), deps({ platform: 'win32' })))
      .toEqual({ ok: false, code: 'error', detail: expect.stringContaining('unavailable') })
  })

  it('写入器抛异常 → error', async () => {
    const writeShortcutLink = vi.fn<Writer>(() => { throw new Error('COM failed') })
    expect(await createProductShortcut(product(), deps({ platform: 'win32', writeShortcutLink })))
      .toEqual({ ok: false, code: 'error', detail: 'COM failed' })
  })

  it('已有同名文件 → 换名,绝不让 writeShortcutLink 覆盖', async () => {
    await fs.writeFile(lnk(), 'existing shortcut')
    // 真的 shell.writeShortcutLink(op=create)**会覆盖**,所以 mock 也照着真写一份 ——
    // 只 `() => true` 的 mock 根本不碰磁盘,「原文件没被动」这句话就证不了任何东西。
    const writeShortcutLink = vi.fn<Writer>((p) => { writeFileSync(p, 'fresh shortcut'); return true })
    const got = await createProductShortcut(product(), deps({ platform: 'win32', writeShortcutLink }))
    expect(got).toEqual({ ok: true, path: lnk('My Product (1)') })
    expect(writeShortcutLink.mock.calls[0][0]).toBe(lnk('My Product (1)'))
    expect(await read(lnk())).toBe('existing shortcut')
    expect(await read(lnk('My Product (1)'))).toBe('fresh shortcut')
  })

  it.skipIf(WIN_HOST)('断链也算占位(access 会当成空位,lstat 不会)', async () => {
    await fs.symlink(path.join(home, 'gone'), lnk())
    const writeShortcutLink = vi.fn<Writer>(() => true)
    const got = await createProductShortcut(product(), deps({ platform: 'win32', writeShortcutLink }))
    expect(got).toEqual({ ok: true, path: lnk('My Product (1)') })
  })

  it('桌面目录不存在 → error,且不调用写入器', async () => {
    const writeShortcutLink = vi.fn<Writer>(() => true)
    const got = await createProductShortcut(product(), deps({ platform: 'win32', writeShortcutLink, desktopDir: path.join(home, 'nope') }))
    expect(got).toMatchObject({ ok: false, code: 'error' })
    expect(writeShortcutLink).not.toHaveBeenCalled()
  })
})

describe('同名不覆盖', () => {
  it('递增到 (1) (2),原文件纹丝不动', async () => {
    const first = await createProductShortcut(product(), deps({ platform: 'darwin' }))
    expect(first).toEqual({ ok: true, path: path.join(desktop, 'My Product.webloc') })
    await fs.writeFile(path.join(desktop, 'My Product.webloc'), 'hand written')
    expect(await createProductShortcut(product(), deps({ platform: 'darwin' })))
      .toEqual({ ok: true, path: path.join(desktop, 'My Product (1).webloc') })
    expect(await createProductShortcut(product(), deps({ platform: 'darwin' })))
      .toEqual({ ok: true, path: path.join(desktop, 'My Product (2).webloc') })
    expect(await read(path.join(desktop, 'My Product.webloc'))).toBe('hand written')
  })

  it('99 个都占满 → error 而不是覆盖', async () => {
    await fs.writeFile(path.join(desktop, 'My Product.webloc'), 'x')
    for (let n = 1; n <= 99; n++) await fs.writeFile(path.join(desktop, `My Product (${n}).webloc`), 'x')
    expect(await createProductShortcut(product(), deps({ platform: 'darwin' })))
      .toEqual({ ok: false, code: 'error', detail: expect.stringContaining('More than 99') })
    expect(await fs.readdir(desktop)).toHaveLength(100)
  })

  it.skipIf(WIN_HOST)('软链占位也换名,绝不顺着链把别人的文件写飞', async () => {
    const victim = path.join(home, 'secret.json')
    await fs.writeFile(victim, '{"token":"secret"}')
    await fs.symlink(victim, path.join(desktop, 'My Product.webloc'))
    expect(await createProductShortcut(product(), deps({ platform: 'darwin' })))
      .toEqual({ ok: true, path: path.join(desktop, 'My Product (1).webloc') })
    expect(await read(victim)).toBe('{"token":"secret"}')
  })
})

describe('拒绝的入口', () => {
  it('未打包 → unpackaged(dev 下 execPath 是裸 electron,scheme 也没注册)', async () => {
    const writeShortcutLink = vi.fn<Writer>(() => true)
    expect(await createProductShortcut(product(), deps({ platform: 'darwin', isPackaged: false })))
      .toEqual({ ok: false, code: 'unpackaged' })
    expect(await createProductShortcut(product(), deps({ platform: 'win32', isPackaged: false, writeShortcutLink })))
      .toEqual({ ok: false, code: 'unpackaged' })
    expect(writeShortcutLink).not.toHaveBeenCalled()
    expect(await fs.readdir(desktop)).toEqual([])
  })

  it('不支持的平台 → unsupported', async () => {
    expect(await createProductShortcut(product(), deps({ platform: 'freebsd' }))).toEqual({ ok: false, code: 'unsupported' })
    expect(await fs.readdir(desktop)).toEqual([])
  })

  it('坏 id → error 结果,不抛', async () => {
    const got = await createProductShortcut({ id: 'p_zzz', name: 'X' }, deps({ platform: 'darwin' }))
    expect(got).toEqual({ ok: false, code: 'error', detail: expect.stringContaining('Invalid product id') })
    expect(await fs.readdir(desktop)).toEqual([])
  })

  it('桌面目录不存在 → error 结果,不抛', async () => {
    const got = await createProductShortcut(product(), deps({ platform: 'darwin', desktopDir: path.join(home, 'no-such-desktop') }))
    expect(got).toMatchObject({ ok: false, code: 'error' })
    expect((got as { detail: string }).detail).toContain('ENOENT')
  })

  it('桌面路径是个文件 → error', async () => {
    const asFile = path.join(home, 'Desktop.txt')
    await fs.writeFile(asFile, 'not a directory')
    expect(await createProductShortcut(product(), deps({ platform: 'linux', desktopDir: asFile })))
      .toEqual({ ok: false, code: 'error', detail: expect.stringContaining('not a directory') })
  })
})
