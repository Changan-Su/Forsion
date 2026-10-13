/**
 * 应用 / 窗口引用 **真机**验证 —— 只在 APPREF_REAL=1 时跑(`npm run check:apprefs-real`,仅 macOS)。
 *
 * 真的本机助手(缺省 ~/Library/Caches/tangu-computer-use/bridge.sock;PI_CU_SOCKET_PATH 可换)× 真的 mdfind / open ×
 * 本测试自己新建的两篇 TextEdit 文档。证的是假助手台架(e2e:apprefs)证不了的那一半:点了之后,系统里最前面的真的是那扇窗口。
 *
 * 只碰自己新建的那两篇(按窗口名寻址),收尾不存盘关掉;TextEdit 原来没开就退掉;最后把原来在前台的应用切回去。
 * 助手没在跑 / 没给辅助功能权限时如实失败(不假装通过)。
 *
 * ⚠️ 会抢大约二十秒的前台和键盘焦点:有人正在这台电脑上打字时别跑 —— 10-13 第二次跑的时候用户正在打字,
 *    有几个字落进了测试新建的文档里,收尾也因此超时、TextEdit 没退掉。跑之前先确认没人在用。
 */
import { execFile, execFileSync } from 'node:child_process'
import os from 'node:os'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createAppRefs } from './appRefs'
import { askHelper, helperSocketPath } from './computerUse'

const REAL = process.env.APPREF_REAL === '1' && process.platform === 'darwin'
const TEXTEDIT = 'com.apple.TextEdit'
const osa = (...lines: string[]): string => execFileSync('osascript', lines.flatMap((l) => ['-e', l]), { encoding: 'utf8', timeout: 15_000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const frontApp = (): string => osa('tell application "System Events" to get bundle identifier of first process whose frontmost is true')
const frontDoc = (): string => osa('tell application "TextEdit" to get name of front window')
const until = async (ok: () => boolean | Promise<boolean>, ms = 6000): Promise<boolean> => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) if (await ok()) return true
  return false
}

describe.skipIf(!REAL)('真机:点引用真的切到那扇窗口', () => {
  const refs = createAppRefs({
    platform: process.platform, ownPid: process.pid, home: os.homedir(),
    ask: (payload) => askHelper(helperSocketPath(), payload, 5_000),
    ensureHelper: async () => {}, // 不拉起助手:用已经在跑的那个,没有就让下面如实失败
    run: (file, args) => new Promise<string>((resolve, reject) => execFile(file, args, { timeout: 8_000, maxBuffer: 4 << 20 }, (err, stdout) => (err ? reject(err) : resolve(String(stdout))))),
  })
  let wasRunning = false
  let before = ''
  let a = ''
  let b = ''

  beforeAll(async () => {
    wasRunning = (() => { try { execFileSync('pgrep', ['-x', 'TextEdit']); return true } catch { return false } })()
    before = frontApp()
    const make = (text: string): string => osa('tell application "TextEdit"', `set d to make new document with properties {text:"${text}"}`, 'return name of d', 'end tell')
    a = make('Forsion app-ref check A')
    b = make('Forsion app-ref check B') // 后建的在前:TextEdit 里最前面的是 B
    osa('tell application "TextEdit" to activate')
    await sleep(800)
  }, 40_000)

  afterAll(() => {
    for (const name of [a, b]) if (name) try { osa(`tell application "TextEdit" to close document "${name}" saving no`) } catch { /* 已关 */ }
    if (!wasRunning) try { osa('tell application "TextEdit" to quit') } catch { /* 没在跑 */ }
    if (before && before !== TEXTEDIT) try { osa(`tell application id "${before}" to activate`) } catch { /* 切不回去就算了 */ }
  }, 60_000) // 每条 osascript 最多等 15 秒:钩子缺省的 10 秒不够,超时会把文档和 TextEdit 留在那儿

  it('列得出那两扇窗口和 TextEdit 这个应用;最前面的是后建的那篇', async () => {
    expect(a && b && a !== b).toBeTruthy()
    const list = await refs.list()
    expect(list.error).toBeUndefined()
    const mine = list.windows.filter((w) => w.id === TEXTEDIT).map((w) => w.title)
    expect(mine).toEqual(expect.arrayContaining([a, b]))
    expect(list.apps.find((x) => x.id === TEXTEDIT)).toMatchObject({ running: true })
    expect(await refs.frontmost()).toEqual({ kind: 'window', id: TEXTEDIT, name: b })
  })

  it('别的应用在前台时点「窗口 A」的引用:TextEdit 到最前,而且最前面的文档是 A(不是原来在前的 B)', async () => {
    const other = before && before !== TEXTEDIT ? before : 'com.apple.finder'
    osa(`tell application id "${other}" to activate`)
    expect(await until(() => frontApp() !== TEXTEDIT)).toBe(true)
    const ref = { kind: 'window' as const, id: TEXTEDIT, name: a }
    expect((await refs.status([ref]))[0]).toMatchObject({ state: 'live', appName: 'TextEdit' })
    expect(await refs.open(ref)).toEqual({ ok: true, landed: 'window' })
    expect(await until(() => frontApp() === TEXTEDIT && frontDoc() === a)).toBe(true)
  }, 30_000)

  it('点「应用」的引用:切到那个应用', async () => {
    const other = before && before !== TEXTEDIT ? before : 'com.apple.finder'
    osa(`tell application id "${other}" to activate`)
    expect(await until(() => frontApp() !== TEXTEDIT)).toBe(true)
    expect(await refs.open({ kind: 'app', id: TEXTEDIT, name: 'TextEdit' })).toEqual({ ok: true, landed: 'app' })
    expect(await until(() => frontApp() === TEXTEDIT)).toBe(true)
  }, 30_000)

  // A、B 的名字是「Untitled」「Untitled 2」这样只差一截的一对:关掉 A 之后不能把还开着的 B 认成它(第一版就认错了)
  it('把 A 关掉:引用变成「找不到这个窗口了」,再点只打开应用', async () => {
    osa(`tell application "TextEdit" to close document "${a}" saving no`)
    const ref = { kind: 'window' as const, id: TEXTEDIT, name: a }
    expect(await until(async () => (await refs.status([ref]))[0].state === 'closed')).toBe(true)
    expect(await refs.open(ref)).toEqual({ ok: true, landed: 'app' })
    a = ''
  }, 30_000)
})
