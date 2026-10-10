/**
 * 挪笔记 / 挪文件夹之后,正文里按相对路径写的图片与附件引用还指不指得到原来的文件(2026-10-10)。
 * 真 registerIpc(IPC.movePage / moveFolder / renameFolder / renamePageFile)+ 真资源协议处理器(<img> 取图走它)
 * + 真 resolveAttachment(点附件链接走它)+ 临时目录里的真文件。
 *
 * 钉住:
 *   · 挪单篇笔记:图片留在原处,`![](.amadeus/p.png)` / `[doc](attachments/d.pdf)` / `![](../assets/x.png)` 按新位置
 *     重算,取到的还是同一个文件 —— 新位置恰好有同路径的另一个文件也不许显示成它。
 *   · 不该动的逐字不动:代码里的、外链、本来就指不到文件的(断的保持断)、别的笔记(它没挪,图也没挪)。
 *   · 挪 / 改名文件夹:夹内互相引用的逐字不变(图和笔记一起走);指向夹外的、夹外指进来的跟着改。
 *
 * 改之前(= propagateRenames 不调 assets.rebaseFileRefs,实跑过):第 1、2、6、7 条红 —— 第 1 条取到的是 SHADOW(另一张图),
 * 第 2 条两张图都是 404。负对照(实跑过):传播不带 [旧文件夹, 新文件夹] → 第 6、7 条红;提前返回只看笔记对 → 第 7 条红。
 */
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const env = vi.hoisted(() => ({
  root: '', handlers: new Map<string, (...args: any[]) => any>(), opened: [] as string[],
  proto: null as null | ((req: Request) => Promise<Response>),
}))
vi.mock('electron', () => ({
  app: { getPath: () => env.root, once: vi.fn(), removeListener: vi.fn() },
  BrowserWindow: { getAllWindows: () => [] }, dialog: {},
  shell: { openPath: async (p: string) => { env.opened.push(p); return '' } },
  ipcMain: { handle: (channel: string, fn: (...args: any[]) => any) => env.handlers.set(channel, fn) },
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: (_s: string, fn: (req: Request) => Promise<Response>) => { env.proto = fn } },
}))
vi.mock('../forsionHome', () => ({
  isDevMode: () => false, forsionHomeDir: () => path.join(env.root, 'app-data'), defaultWorkspaceDir: () => path.join(env.root, 'workspace'),
  tanguDataDir: () => path.join(env.root, 'tangu-data'),
}))
vi.mock('../forsionAuth', () => ({ loadTanguCreds: () => ({}) }))
vi.mock('../activityLog', () => ({ logActivity: vi.fn(), logNoteEdit: vi.fn() }))
vi.mock('chokidar', () => ({ default: { watch: () => ({ on: vi.fn().mockReturnThis(), close: async () => {} }) } }))

const invoke = (channel: string, ...args: unknown[]) => env.handlers.get(channel)!({ sender: { id: 1 } }, ...args)
let stop: (() => Promise<void>) | undefined
let vault = ''
let IPC: typeof import('@amadeus-shared/ipc').IPC

const A = '# a\n\n![](.amadeus/p.png)\n\n![x](../assets/x%20y.png "t")\n\n[doc](attachments/d.pdf)\n'
const FILES: Record<string, string> = {
  'notes/a.md': A,
  'notes/.amadeus/p.png': 'P', 'assets/x y.png': 'X', 'notes/attachments/d.pdf': 'D',
}

beforeEach(async () => {
  vi.resetModules()
  env.root = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-move-refs-'))
  env.handlers.clear(); env.opened.length = 0
  vault = path.join(env.root, 'vault')
  await seed(FILES)
  const { writeConfig } = await import('./settings')
  await writeConfig({ localVault: vault, lastVault: vault })
  const { registerIpc } = await import('./ipc')
  ;({ IPC } = await import('@amadeus-shared/ipc'))
  const { registerAssetProtocol } = await import('./assetProtocol')
  registerAssetProtocol(() => vault)
  stop = registerIpc(() => null).stopSync
  await invoke(IPC.restoreVault)
})
afterEach(async () => { await stop?.(); await fs.rm(env.root, { recursive: true, force: true }) })

async function seed(files: Record<string, string>): Promise<void> {
  for (const [p, body] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(vault, p)), { recursive: true })
    await fs.writeFile(path.join(vault, p), body)
  }
}
const read = (p: string): Promise<string> => fs.readFile(path.join(vault, p), 'utf8')

/** 这篇笔记显示时每张图 <img> 取到的内容(取不到 = 状态码);地址由共享接缝现拼,和编辑器里的 src 是同一个。 */
async function shown(note: string): Promise<Array<string | number>> {
  const { toDisplayMarkdown } = await import('@amadeus-shared/assets')
  const out: Array<string | number> = []
  for (const m of toDisplayMarkdown(await read(note), path.posix.dirname(note)).matchAll(/amadeus-asset:\/\/v\/[^)\s]+/g)) {
    const res = await env.proto!(new Request(m[0]))
    out.push(res.ok ? await res.text() : res.status)
  }
  return out
}
/** 点这篇笔记里 `[文字](地址)` 那条附件链接,系统打开的是库里的哪个文件(没打开 = null)。 */
async function opened(note: string, text: string): Promise<string | null> {
  const href = new RegExp(`\\[${text}\\]\\(([^)\\s]+)`).exec(await read(note))![1]
  env.opened.length = 0
  await invoke(IPC.openAttachment, note, href)
  return env.opened.length ? path.relative(vault, env.opened[0]).split(path.sep).join('/') : null
}

it('挪单篇笔记:图片和附件引用按新位置重算,取到的还是原来的文件', async () => {
  expect(await shown('notes/a.md')).toEqual(['P', 'X']) // 防空过:挪之前确实取得到
  expect(await opened('notes/a.md', 'doc')).toBe('notes/attachments/d.pdf')
  // 新位置恰好有同路径的另一个文件:不许显示成它
  await seed({ 'other/.amadeus/p.png': 'SHADOW' })
  expect(await invoke(IPC.movePage, 'notes/a.md', 'other')).toBe('other/a.md')
  expect(await shown('other/a.md'), await read('other/a.md')).toEqual(['P', 'X'])
  expect(await opened('other/a.md', 'doc')).toBe('notes/attachments/d.pdf')
  expect(await read('other/a.md')).toBe('# a\n\n![](../notes/.amadeus/p.png)\n\n![x](../assets/x%20y.png "t")\n\n[doc](../notes/attachments/d.pdf)\n')
  // 挪回去:写法回到原样(往返不留痕)
  expect(await invoke(IPC.movePage, 'other/a.md', 'notes')).toBe('notes/a.md')
  expect(await read('notes/a.md')).toBe(A)
})

it('挪到更深 / 挪到库根:`../` 的层数跟着变', async () => {
  await invoke(IPC.movePage, 'notes/a.md', 'deep/er')
  expect(await shown('deep/er/a.md'), await read('deep/er/a.md')).toEqual(['P', 'X'])
  await invoke(IPC.movePage, 'deep/er/a.md', '')
  expect(await read('a.md')).toBe('# a\n\n![](notes/.amadeus/p.png)\n\n![x](assets/x%20y.png "t")\n\n[doc](notes/attachments/d.pdf)\n')
  expect(await shown('a.md')).toEqual(['P', 'X'])
})

it('不该动的逐字不动:代码里的、外链、锚点、本来就指不到文件的、`![[…]]`', async () => {
  const B = [
    '```md', '![](.amadeus/p.png)', '```', '',
    '行内 `![](.amadeus/p.png)` 也是代码', '',
    '![](https://example.com/a.png) [t](#anchor) [m](mailto:a@b.c) ![](/abs.png)', '',
    '![](.amadeus/missing.png) [gone](attachments/nope.pdf)', '',
    '![[p.png]]', '',
  ].join('\n')
  await seed({ 'notes/b.md': B })
  await invoke(IPC.movePage, 'notes/b.md', 'other')
  expect(await read('other/b.md')).toBe(B)
})

it('别的笔记没挪、它引用的图也没挪:一个字节不变', async () => {
  const C = '![](.amadeus/p.png)\n'
  await seed({ 'notes/c.md': C })
  await invoke(IPC.movePage, 'notes/a.md', 'other')
  expect(await read('notes/c.md')).toBe(C)
  expect(await shown('notes/c.md')).toEqual(['P'])
})

it('原地改名:目录没变,引用一个字节不变', async () => {
  expect(await invoke(IPC.renamePageFile, 'notes/a.md', 'a2')).toBe('notes/a2.md')
  expect(await read('notes/a2.md')).toBe(A)
})

it('挪文件夹:夹内的引用逐字不变,指向夹外的、夹外指进来的跟着改', async () => {
  const R = '![](notes/.amadeus/p.png)\n'
  await seed({ 'root.md': R })
  expect(await invoke(IPC.moveFolder, 'notes', 'archive')).toBe('archive/notes')
  expect(await read('archive/notes/a.md')).toBe(A.replace('../assets/', '../../assets/'))
  expect(await shown('archive/notes/a.md')).toEqual(['P', 'X'])
  expect(await opened('archive/notes/a.md', 'doc')).toBe('archive/notes/attachments/d.pdf')
  expect(await read('root.md')).toBe('![](archive/notes/.amadeus/p.png)\n')
  expect(await shown('root.md')).toEqual(['P'])
})

it('只装附件的文件夹改名:别的笔记里指向它的引用跟着改', async () => {
  expect(await invoke(IPC.renameFolder, 'assets', 'media')).toBe('media')
  expect(await read('notes/a.md')).toBe(A.replace('../assets/', '../media/'))
  expect(await shown('notes/a.md')).toEqual(['P', 'X'])
})
