/**
 * 桌面的资源协议处理器对「笔记里的图片引用」到底取哪个文件(2026-10-10)。
 * 真处理器(registerAssetProtocol 交给 protocol.handle 的那个函数)+ 临时目录里的真文件;
 * 地址由共享接缝现拼(toDisplayMarkdown),和编辑器里 <img> 的 src 是同一个。
 *
 * 钉住三件事:
 *   · 带路径的地址只做**精确**匹配 —— 没有「页目录找不到就退回库根」这一步(那是 ipc 侧 resolveAttachment 的行为,
 *     <img> 不走它);全库按文件名找只对不带 `/` 的裸文件名生效。
 *   · 地址里的 `..` 按词法折叠(`notes/../attachments/x.png` = 库根的 `attachments/x.png`),折叠后逃出库根 = 403。
 *   · 所以落盘写法必须自己指得准:页目录之外的引用存成 `../…`(shared/amadeus/assets.ts 的 relFrom),
 *     重开后才取得到同一个文件。
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({ handler: null as null | ((req: Request) => Promise<Response>) }))
vi.mock('electron', () => ({
  protocol: {
    registerSchemesAsPrivileged: vi.fn(),
    handle: (_scheme: string, fn: (req: Request) => Promise<Response>) => { env.handler = fn },
  },
}))

import { toAssetUrl, toDisplayMarkdown, toStoredMarkdown } from '@amadeus-shared/assets'
import { registerAssetProtocol } from './assetProtocol'

let root = ''
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-asset-proto-'))
  await fs.mkdir(path.join(root, 'attachments'), { recursive: true })
  await fs.mkdir(path.join(root, 'notes'), { recursive: true })
  await fs.writeFile(path.join(root, 'attachments', 'x.png'), 'ROOT')
  await fs.writeFile(path.join(root, 'notes', 'note.md'), '# note\n')
  registerAssetProtocol(() => root)
})
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }) })

/** 一行落盘的 markdown 在 `pageDir` 这篇笔记里显示时,<img> 去取的结果。 */
async function load(stored: string, pageDir: string): Promise<{ status: number; body: string }> {
  const src = /\]\(([^)\s]+)/.exec(toDisplayMarkdown(stored, pageDir))?.[1] ?? ''
  expect(src.startsWith('amadeus-asset://v/')).toBe(true) // 防空过:确实换成了协议地址
  const res = await env.handler!(new Request(src))
  return { status: res.status, body: res.ok ? await res.text() : '' }
}

describe('asset protocol: which file a note image resolves to', () => {
  it('页目录之下的引用:精确取到', async () => {
    await fs.mkdir(path.join(root, 'notes', '.amadeus'))
    await fs.writeFile(path.join(root, 'notes', '.amadeus', 'p.png'), 'PAGE')
    expect(await load('![](.amadeus/p.png)', 'notes')).toEqual({ status: 200, body: 'PAGE' })
  })

  it('`../` 引用:按词法折叠,取到页目录之外的那个文件;逃出库根 = 403', async () => {
    expect(await load('![](../attachments/x.png)', 'notes')).toEqual({ status: 200, body: 'ROOT' })
    expect((await load('![](../../secret.png)', 'notes')).status).toBe(403)
  })

  it('带路径的引用没有「退回库根」这一步:子文件夹笔记里的库内路径写法取不到库根的文件', async () => {
    // 盘上 `![](attachments/x.png)`、笔记在 notes/ —— 地址拼成 notes/attachments/x.png,那里没有文件。
    expect((await load('![](attachments/x.png)', 'notes')).status).toBe(404)
    // 那个位置恰好有同路径的另一个文件 → 显示的是它,不是库根那张。
    await fs.mkdir(path.join(root, 'notes', 'attachments'))
    await fs.writeFile(path.join(root, 'notes', 'attachments', 'x.png'), 'SHADOW')
    expect(await load('![](attachments/x.png)', 'notes')).toEqual({ status: 200, body: 'SHADOW' })
  })

  it('裸文件名才全库按名找(Obsidian 式的 ![[pic.png]])', async () => {
    const res = await env.handler!(new Request(toAssetUrl('x.png')))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('ROOT')
  })

  it('⚠️存盘 → 重开取到的还是同一个文件:从别的文件夹贴进来的图(显示地址指着库根的 attachments/x.png)', async () => {
    // 编辑器里这张图的 src 就是它在原处的显示地址;存进 notes/ 下的笔记,再按落盘的那一行重开。
    const stored = toStoredMarkdown(`![](${toAssetUrl('attachments/x.png')})`, 'notes')
    expect(await load(stored, 'notes'), `落盘写成了 ${stored}`).toEqual({ status: 200, body: 'ROOT' })
    // 新位置恰好有同路径的另一个文件,也不许显示成它。
    await fs.mkdir(path.join(root, 'notes', 'attachments'))
    await fs.writeFile(path.join(root, 'notes', 'attachments', 'x.png'), 'SHADOW')
    expect(await load(stored, 'notes'), `落盘写成了 ${stored}`).toEqual({ status: 200, body: 'ROOT' })
  })
})
