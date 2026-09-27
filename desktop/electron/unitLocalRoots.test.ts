/**
 * unitLocalRoots 的规则面(整链见 unitHostChain.test.ts):远程标记识别、本机根过滤、登记表落盘、种子失败的收尾。
 * 跑法:npx vitest run electron/unitLocalRoots.test.ts
 */
import { describe, it, expect } from 'vitest'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildUnitScopeGuard } from './unitHostScope'
import { composeUnitRoots, confirmedSessionRoots, createFileProjectRegistry, createUnitSessionRoots, hasRemoteOrigin, inAppDataArea, registerPickedDirectory, seedGatedEngine, type SessionRowLike } from './unitLocalRoots'

async function tmpHome(): Promise<string> { return realpathSync(await mkdtemp(join(tmpdir(), 'unit-local-'))) }

describe('unitLocalRoots', () => {
  it('远程标记:对象 / JSON 串两种存值都认;没有 / 坏串 = 无标记', () => {
    expect(hasRemoteOrigin({ agent_config: { remoteOrigin: { via: 'lan' } } })).toBe(true)
    expect(hasRemoteOrigin({ agent_config: JSON.stringify({ remoteOrigin: { via: 'tunnel' } }) })).toBe(true)
    expect(hasRemoteOrigin({ agent_config: { execMode: 'host' } })).toBe(false)
    expect(hasRemoteOrigin({ agent_config: '{bad' })).toBe(false)
    expect(hasRemoteOrigin({})).toBe(false)
  })

  it('会话根 = 无远程标记 且 在本机根里;远端标记的行、本机根外的行都不算', async () => {
    const home = await tmpHome()
    const proj = join(home, 'proj'); const sub = join(proj, 'sub'); const other = join(home, 'other')
    for (const d of [sub, other]) await mkdir(d, { recursive: true })
    const rows: SessionRowLike[] = [
      { project_path: sub, agent_config: null },
      { project_path: other, agent_config: null },
      { project_path: proj, agent_config: { remoteOrigin: { via: 'lan' } } },
      { project_path: join(home, 'gone'), agent_config: null },
    ]
    expect(confirmedSessionRoots(rows, [proj])).toEqual([sub])
  })

  it('本机根里的家目录 / `/` / 受保护目录祖先不算本机根:一条「家目录会话」放不开家目录下的任意路径', async () => {
    const home = await tmpHome()
    const deep = join(home, 'Library', 'Application Support', 'X')
    await mkdir(deep, { recursive: true })
    const guard = buildUnitScopeGuard({ home, forsionHome: join(home, '.forsion') })
    const reg = createFileProjectRegistry(join(home, 'reg.json'))
    await reg.ready()
    await reg.markSeeded([home, '/']) // 本机历史上真有开在家目录 / 根目录的会话
    const source = { rows: async () => [{ project_path: deep, agent_config: null }], ensureSeeded: async () => true, seeded: () => true, invalidate: () => {} }
    const roots = await composeUnitRoots({ base: [], registry: reg, source, env: { home }, guard })
    expect(roots.session).toEqual([])
  })

  it('登记表:原子落盘 0600,重开后照读;坏文件 = 空表、未种子', async () => {
    const home = await tmpHome()
    const file = join(home, 'ud', 'reg.json')
    await mkdir(join(home, 'p'), { recursive: true })
    const a = createFileProjectRegistry(file)
    await a.ready()
    expect([a.seeded(), a.roots()]).toEqual([false, []])
    await a.add([join(home, 'p'), join(home, 'missing')])
    await a.markSeeded([])
    const b = createFileProjectRegistry(file)
    await b.ready()
    expect([b.seeded(), b.roots()]).toEqual([true, [join(home, 'p')]])
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ v: 1, seeded: true })
  })

  it('没先 ready() 就登记(互联没开时选择框照样登记):不拿空表盖掉已有的登记与种子标记;并发登记不互相覆盖', async () => {
    const home = await tmpHome()
    const file = join(home, 'reg.json')
    for (const d of ['a', 'b', 'c']) await mkdir(join(home, d))
    const first = createFileProjectRegistry(file)
    await first.markSeeded([join(home, 'a')])
    const fresh = createFileProjectRegistry(file) // 新进程:没调过 ready()
    await Promise.all([fresh.add([join(home, 'b')]), fresh.add([join(home, 'c')])])
    const again = createFileProjectRegistry(file)
    await again.ready()
    expect(again.seeded()).toBe(true)
    expect([...again.roots()].sort()).toEqual([join(home, 'a'), join(home, 'b'), join(home, 'c')])
  })

  it('种子不收应用数据区里的历史会话目录(升级前远端 PATCH 过 / 派生出来的都没有标记);网盘目录照收', async () => {
    const home = await tmpHome()
    const proj = join(home, 'code', 'app')
    const poisoned = join(home, 'Library', 'Application Support', 'SomeBrowser', 'Default')
    const cloud = join(home, 'Library', 'CloudStorage', 'Dropbox', 'proj')
    const icloud = join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'proj')
    for (const d of [proj, poisoned, cloud, icloud]) await mkdir(d, { recursive: true })
    const rows = [proj, poisoned, cloud, icloud].map((p) => ({ project_path: p, agent_config: null }))
    const fetchImpl = (async (u: string) => new Response(JSON.stringify({ sessions: String(u).includes('archived=true') ? [] : rows }), { status: 200 })) as unknown as typeof fetch
    const reg = createFileProjectRegistry(join(home, 'reg.json'))
    const src = createUnitSessionRoots({ engine: () => ({ url: 'http://e', token: 't' }), registry: reg, fetchImpl, home, platform: 'darwin' })
    expect(await src.ensureSeeded()).toBe(true)
    expect([...reg.roots()].sort()).toEqual([proj, cloud, icloud].sort())
  })

  it('应用数据区判定:mac ~/Library(网盘除外)、Linux ~/.local/share 等;普通项目目录不算', () => {
    expect(inAppDataArea('/Users/a/Library/Application Support/X', '/Users/a', 'darwin')).toBe(true)
    expect(inAppDataArea('/Users/a/Library/Preferences', '/Users/a', 'darwin')).toBe(true)
    expect(inAppDataArea('/Users/a/Library/CloudStorage/OneDrive/p', '/Users/a', 'darwin')).toBe(false)
    expect(inAppDataArea('/Users/a/code/p', '/Users/a', 'darwin')).toBe(false)
    expect(inAppDataArea('/home/a/.local/share/x', '/home/a', 'linux')).toBe(true)
    expect(inAppDataArea('/home/a/snap/firefox/common', '/home/a', 'linux')).toBe(true)
    expect(inAppDataArea('/home/a/src/p', '/home/a', 'linux')).toBe(false)
  })

  it('原生选择框:只有「添加 / 导入项目」(purpose=project)才登记;技能导入 / 同步目录等别的用途不登记', async () => {
    const home = await tmpHome()
    for (const d of ['skills', 'proj']) await mkdir(join(home, d))
    const reg = createFileProjectRegistry(join(home, 'reg.json'))
    expect(await registerPickedDirectory(reg, join(home, 'skills'), undefined)).toBe(false)
    expect(await registerPickedDirectory(reg, join(home, 'skills'), { purpose: 'import' })).toBe(false)
    expect(await registerPickedDirectory(reg, join(home, 'proj'), { purpose: 'project' })).toBe(true)
    await reg.ready()
    expect(reg.roots()).toEqual([join(home, 'proj')])
  })

  it('种子:引擎没起 = 未完成(闸继续 503);连败到上限按空表完成,失败间隔内不重试', async () => {
    const home = await tmpHome()
    const reg = createFileProjectRegistry(join(home, 'reg.json'))
    let url: string | null = null
    let calls = 0
    const fetchImpl = (async () => { calls++; return new Response('boom', { status: 500 }) }) as unknown as typeof fetch
    const src = createUnitSessionRoots({ engine: () => ({ url, token: 't' }), registry: reg, fetchImpl, maxSeedFailures: 2, seedRetryMs: 30 })
    const gated = seedGatedEngine(() => ({ url: url ?? 'http://e', token: 't' }), src)
    expect(await src.ensureSeeded()).toBe(false) // 引擎没起
    expect(gated().url).toBeNull()
    url = 'http://e'
    expect(await src.ensureSeeded()).toBe(false) // 第 1 次失败
    expect(await src.ensureSeeded()).toBe(false) // 间隔内:不重试
    expect(calls).toBe(1)
    await new Promise((r) => setTimeout(r, 40))
    expect(await src.ensureSeeded()).toBe(true) // 第 2 次失败 = 上限 → 空表完成
    expect([reg.seeded(), reg.roots()]).toEqual([true, []])
    expect(gated().url).toBe('http://e')
  })
})
