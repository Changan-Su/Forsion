/**
 * 设备网页版(web/src/amadeus/unitBridge.ts)里,笔记正文的图片到底取设备上的哪个文件(2026-10-10)。
 * 真桥拼地址(toDisplayMarkdown → 桥的构建器),设备那头用真的 VaultManager.resolveAttachment(GET /vault/asset 就是它:
 * electron/unitWeb.ts → vault.assetAbs(page, ref))对着临时目录里的真文件解析。
 *
 * 钉住:正文里的图(ref 已经是完整的库内路径)不带 page。带着的话设备先按「页目录 + ref」再拼一遍 ——
 * notes/ 下的笔记引用库根的 `../attachments/x.png`,取到的却是 notes/attachments/x.png(同路径的另一个文件)。
 * `![[裸文件名]]` 这类嵌入照旧带 page。
 * 负对照(实跑过):桥的构建器改回 `(ref) => assetUrl(ref)` → 第 1 格红(取到 SHADOW)。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ dialog: {} })) // vaultManager 只用到 dialog.showOpenDialog(本测试不走)

import { IPC } from '@amadeus-shared/ipc'
import { resetAssetUrlBuilder, toAssetUrl, toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'
import { createUnitAmadeusBridge } from '../../../web/src/amadeus/unitBridge'
import { VaultManager } from '../../electron/amadeus/fs/vaultManager'

let root = ''
let vault: VaultManager
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'unit-asset-ref-'))
  for (const [p, body] of [['attachments/x.png', 'ROOT'], ['notes/attachments/x.png', 'SHADOW'], ['notes/note.md', '# note\n'], ['notes/pic.png', 'SAME-FOLDER']]) {
    await fs.mkdir(path.dirname(path.join(root, p)), { recursive: true })
    await fs.writeFile(path.join(root, p), body)
  }
  vault = new VaultManager()
  vault.setRoot(root)
  vi.stubGlobal('window', { addEventListener: () => {} })
  vi.stubGlobal('EventSource', class { close(): void {} })
  vi.stubGlobal('fetch', vi.fn(async (input: URL | string, init?: RequestInit) => {
    const url = new URL(String(input))
    if (url.pathname.endsWith('/vault/asset-token')) return new Response(JSON.stringify({ token: 'at1', ttlSec: 600 }))
    if (url.pathname.endsWith('/vault/rpc')) {
      const { ch } = JSON.parse(String(init?.body)) as { ch: string }
      return new Response(JSON.stringify({ ok: true, result: ch === IPC.loadPage ? { manifest: null, contents: {} } : null }))
    }
    return new Response('{}', { status: 404 })
  }))
})
afterEach(async () => {
  resetAssetUrlBuilder()
  vi.unstubAllGlobals()
  await fs.rm(root, { recursive: true, force: true })
})

/** 设备端对这条地址的解析(unitWeb 的 GET /vault/asset):取到的文件内容,取不到 = null。 */
async function served(url: string): Promise<string | null> {
  const q = new URL(url).searchParams
  const abs = await vault.resolveAttachment(q.get('page') ?? '', q.get('ref') ?? '')
  return abs ? fs.readFile(abs, 'utf8').catch(() => null) : null
}
const srcOf = (displayMd: string): string => /\]\(([^)\s]+)/.exec(displayMd)![1]

it('正文里页目录之外的图(../):取到的是库根那张,不是页目录下同路径的另一个文件;存回去逐字不变', async () => {
  const bridge = await createUnitAmadeusBridge({ base: 'http://unit.test/', getToken: () => 'tok', onAuthError: vi.fn() })
  await bridge.loadPage('notes/note.md') // 当前页 = notes/ 下那篇(资源地址的 page 基准)
  const md = '![](../attachments/x.png)\n'
  const shown = toDisplayMarkdown(md, 'notes')
  expect(srcOf(shown).startsWith('http://unit.test/vault/asset?')).toBe(true) // 防空过:确实是设备桥的地址
  expect(await served(srcOf(shown))).toBe('ROOT')
  expect(toStoredMarkdown(shown, 'notes')).toBe(md)
  // 从别的文件夹贴进来的图:存成 ../,重开取到的还是库根那张
  const pasted = toStoredMarkdown(`![](${toAssetUrl('attachments/x.png', true)})`, 'notes')
  expect(pasted).toBe('![](../attachments/x.png)')
  expect(await served(srcOf(toDisplayMarkdown(pasted, 'notes')))).toBe('ROOT')
})

it('`![[裸文件名]]` / 页相对的嵌入(不经 toDisplayMarkdown)照旧带 page', async () => {
  const bridge = await createUnitAmadeusBridge({ base: 'http://unit.test/', getToken: () => 'tok', onAuthError: vi.fn() })
  await bridge.loadPage('notes/note.md')
  expect(new URL(toAssetUrl('pic.png')).searchParams.get('page')).toBe('notes/note.md')
  expect(await served(toAssetUrl('./pic.png'))).toBe('SAME-FOLDER') // 带路径的页相对嵌入靠 page 才解析得到
})
