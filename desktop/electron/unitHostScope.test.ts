/**
 * /unit/host* 路径钳制(评审 A-desktop#1 / 契约 C4):远端能把某会话的 project_path 写成家目录,
 * 旧实现就把整个家目录当成可读根 —— ~/.forsion/auth.json 直接读走。这里在临时「家目录」里真建文件 / 软链,
 * 走 main.ts 同一个入口 resolveUnitHostPath(realpath → 钳制)。
 * 跑法:npx vitest run electron/unitHostScope.test.ts
 */
import { describe, it, expect, beforeAll } from 'vitest'
import { lstat, mkdir, mkdtemp, readdir, rename, symlink, utimes, writeFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildUnitScopeGuard, filterSessionRoots, isUnitProtected, openUnitHostFile, resolveUnitHostPath, withVerifiedUnitPath, type UnitScopeGuard } from './unitHostScope'

let home = ''
let guard: UnitScopeGuard
let env: { home: string }
const ws = (): string => join(home, 'Forsion')

beforeAll(async () => {
  home = realpathSync(await mkdtemp(join(tmpdir(), 'unit-scope-')))
  env = { home }
  const files: Record<string, string> = {
    '.forsion/auth.json': '{"forsion_token":"SECRET"}',
    '.forsion/provider-auth.json': '{}',
    '.forsion/config.json': '{}',
    '.forsion/tangu/agents/writer/Library/draft.md': 'ok',
    '.forsion/tangu/agents/writer/Library/.tangu/state.json': '{}',
    '.forsion/tangu/agents/writer/HARNESS.md': 'x',
    '.ssh/id_ed25519': 'KEY',
    '.zshrc': 'export X=1',
    'Forsion/doc.md': 'ws',
    'proj/a.md': 'proj',
    'AppData/Forsion/tangu-desktop-config.json': '{"unitHostSecret":"S"}',
  }
  for (const [rel, body] of Object.entries(files)) {
    await mkdir(join(home, rel, '..'), { recursive: true })
    await writeFile(join(home, rel), body)
  }
  await symlink(join(home, '.forsion'), join(home, '.tangu')) // 兼容软链(forsionHome.ts 迁移留下的)
  await symlink(join(home, '.forsion', 'auth.json'), join(home, 'Forsion', 'auth-link.json'))
  guard = buildUnitScopeGuard({ home, forsionHome: join(home, '.forsion'), userData: join(home, 'AppData', 'Forsion'), appData: join(home, 'AppData') })
})

const read = (p: string, session: string[], allowRoot = false): string | null =>
  resolveUnitHostPath(p, { base: [ws()], session }, env, guard, allowRoot)

describe('unitHostScope:会话根 = 家目录也读不到凭据', () => {
  it('会话根 = 家目录:auth.json / provider-auth / config.json / ~/.ssh / 家目录 dotfile 全部 null', () => {
    for (const rel of ['.forsion/auth.json', '.forsion/provider-auth.json', '.forsion/config.json', '.tangu/auth.json', '.ssh/id_ed25519', '.zshrc']) {
      expect(read(join(home, rel), [home]), rel).toBeNull()
    }
    expect(read(home, [home], true)).toBeNull() // 目录类也不许把家目录当根列出来
  })

  it('会话根 = `/`、受保护目录的祖先(userData 的父目录)、受保护目录本身:都不算根', () => {
    expect(filterSessionRoots(['/', home, join(home, 'AppData'), join(home, '.forsion'), join(home, 'proj')], env, guard)).toEqual([join(home, 'proj')])
    expect(read(join(home, 'AppData', 'Forsion', 'tangu-desktop-config.json'), [join(home, 'AppData')])).toBeNull()
    expect(read(join(home, 'proj', 'a.md'), ['/'])).toBeNull()
  })

  it('凭据从正常根里经软链 / 直接点名进来也拒(realpath 之后判)', () => {
    expect(read(join(ws(), 'auth-link.json'), [])).toBeNull()
    expect(read(join(home, '.forsion', 'auth.json'), [join(home, '.forsion')])).toBeNull()
    expect(read(join(home, '.ssh', 'id_ed25519'), [join(home, '.ssh')])).toBeNull() // .ssh 不是祖先,但在拒读名单里
  })

  it('darwin / win32 不分大小写:大小写变体的受保护路径同样拒', () => {
    expect(isUnitProtected(join(home, '.FORSION', 'Auth.json'), guard, 'darwin')).toBe(true)
    expect(isUnitProtected(join(home, '.FORSION', 'Auth.json'), guard, 'linux')).toBe(false) // linux 是另一个文件
  })

  it('正常面不受影响:工作区 / 普通项目会话根 / Agent 私聊 Library(控制目录除外)', () => {
    expect(read(join(ws(), 'doc.md'), [])).toBe(join(ws(), 'doc.md'))
    expect(read(join(home, 'proj', 'a.md'), [join(home, 'proj')])).toBe(join(home, 'proj', 'a.md'))
    expect(read(join(home, 'proj'), [join(home, 'proj')], true)).toBe(join(home, 'proj'))
    expect(read(join(home, 'proj'), [join(home, 'proj')], false)).toBeNull() // 文件读不能指根本身
    const lib = join(home, '.forsion', 'tangu', 'agents', 'writer', 'Library')
    expect(read(join(lib, 'draft.md'), [lib])).toBe(join(lib, 'draft.md'))
    expect(read(join(lib, '.tangu', 'state.json'), [lib])).toBeNull()
    expect(read(join(home, '.forsion', 'tangu', 'agents', 'writer', 'HARNESS.md'), [lib])).toBeNull() // Library 之外不在根内
  })
})

describe('unitHostScope:校验与读取之间换软链(Codex 三轮 P1)', () => {
  const roots = (): { base: string[]; session: string[] } => ({ base: [ws()], session: [] })
  /** ws/<name>/auth.json 是个普通文件;swap() 把 ws/<name> 换成指向 ~/.forsion 的软链,back() 换回来。 */
  async function racer(name: string): Promise<{ file: string; swap: () => Promise<void>; back: () => Promise<void> }> {
    const dir = join(ws(), name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'auth.json'), '{"benign":true}')
    return {
      file: join(dir, 'auth.json'),
      swap: async () => { await rename(dir, dir + '.real'); await symlink(join(home, '.forsion'), dir) },
      back: async () => { await rename(dir, dir + '.link'); await rename(dir + '.real', dir) },
    }
  }
  const readAll = async (o: Awaited<ReturnType<typeof openUnitHostFile>>): Promise<string | null> => {
    if (!o) return null
    try { return (await o.fh.readFile()).toString('utf8') } finally { await o.fh.close() }
  }

  it('没有竞态:照常读到', async () => {
    const r = await racer('calm')
    expect(await readAll(await openUnitHostFile(r.file, roots(), env, guard))).toBe('{"benign":true}')
  })

  it('校验后把中间目录换成软链:打开的是凭据,复核 realpath 落进受保护目录 → null', async () => {
    const r = await racer('swap1')
    const got = await readAll(await openUnitHostFile(r.file, roots(), env, guard, { beforeOpen: r.swap }))
    expect(got).toBeNull()
  })

  it('换过去、打开、再换回来:路径复核看着正常,但 fd 的 (dev, ino) 对不上 → null', async () => {
    const r = await racer('swap2')
    const got = await readAll(await openUnitHostFile(r.file, roots(), env, guard, { beforeOpen: r.swap, afterOpen: r.back }))
    expect(got).toBeNull()
  })

  it('目录列表:列之前换成软链(没换回来)→ null,不吐受保护目录的条目名', async () => {
    const dir = join(ws(), 'lsdir')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.md'), 'x')
    const swap = async (): Promise<void> => { await rename(dir, dir + '.real'); await symlink(join(home, '.forsion'), dir) }
    expect(await withVerifiedUnitPath(dir, roots(), env, guard, true, (real) => readdir(real))).toEqual(['a.md'])
    expect(await withVerifiedUnitPath(dir, roots(), env, guard, true, (real) => readdir(real), { beforeOpen: swap })).toBeNull()
  })

  // ── Codex 终审 out1 #4:换过去、列 / stat、再换回来 —— 对象身份前后一致,旧实现照样吐出受保护目录的条目名 ──
  /** ws/<name> 是个普通目录;swap() 换成指向 ~/.forsion 的软链,back() 换回原目录(每次调用都换,重试也照换)。 */
  async function dirRacer(name: string, target = join(home, '.forsion')): Promise<{ dir: string; swap: () => Promise<void>; back: () => Promise<void> }> {
    const dir = join(ws(), name)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.md'), 'x')
    return {
      dir,
      swap: async () => { await rename(dir, dir + '.real'); await symlink(target, dir) },
      back: async () => { await rename(dir, dir + '.link'); await rename(dir + '.real', dir) },
    }
  }

  it('目录列表:换过去、列、再换回来 → null(父目录 mtime 变了),不吐 auth.json 等条目名', async () => {
    const r = await dirRacer('lsback')
    expect(await withVerifiedUnitPath(r.dir, roots(), env, guard, true, (real) => readdir(real))).toEqual(['a.md'])
    let listed: string[] | null = null
    const got = await withVerifiedUnitPath(r.dir, roots(), env, guard, true, async (real) => (listed = await readdir(real)), { beforeOpen: r.swap, afterOpen: r.back })
    expect(listed).toContain('auth.json') // 非空性:竞态确实打中了 —— 读到的是受保护目录
    expect(got).toBeNull()
    expect(await readdir(r.dir)).toEqual(['a.md']) // 换回来了:路径复核看着一切正常
  })

  it('stat:换过去、stat、再换回来 → null(不吐受保护目录的条目数 / 时间)', async () => {
    const r = await dirRacer('statback')
    const count = async (real: string): Promise<number> => (await readdir(real)).length
    expect(await withVerifiedUnitPath(r.dir, roots(), env, guard, true, count)).toBe(1)
    expect(await withVerifiedUnitPath(r.dir, roots(), env, guard, true, count, { beforeOpen: r.swap, afterOpen: r.back })).toBeNull()
  })

  it('换的是更上层的一段(ws/outer 换成软链、列 ws/outer/inner、再换回来)→ null', async () => {
    const outer = join(ws(), 'outer')
    await mkdir(join(outer, 'inner'), { recursive: true })
    await writeFile(join(outer, 'inner', 'a.md'), 'x')
    await mkdir(join(home, '.forsion', 'inner'), { recursive: true })
    await writeFile(join(home, '.forsion', 'inner', 'secret.json'), '{}')
    const swap = async (): Promise<void> => { await rename(outer, outer + '.real'); await symlink(join(home, '.forsion'), outer) }
    const back = async (): Promise<void> => { await rename(outer, outer + '.link'); await rename(outer + '.real', outer) }
    let listed: string[] | null = null
    const got = await withVerifiedUnitPath(join(outer, 'inner'), roots(), env, guard, true, async (real) => (listed = await readdir(real)), { beforeOpen: swap, afterOpen: back })
    expect(listed).toContain('secret.json')
    expect(got).toBeNull()
  })

  it('换过去、列、换回来,再用 utimes 把父目录的 mtime 恢复原值 → 仍然 null(utimes 会刷 ctime,改不回去)', async () => {
    const r = await dirRacer('lsutimes')
    const parent = ws()
    let saved: { atime: Date; mtime: Date } | null = null
    const swap = async (): Promise<void> => { const st = await lstat(parent); saved = { atime: st.atime, mtime: st.mtime }; await r.swap() }
    const backAndRestore = async (): Promise<void> => { await r.back(); await utimes(parent, saved!.atime, saved!.mtime) }
    let listed: string[] | null = null
    const got = await withVerifiedUnitPath(r.dir, roots(), env, guard, true, async (real) => (listed = await readdir(real)), { beforeOpen: swap, afterOpen: backAndRestore })
    expect(listed).toContain('auth.json') // 竞态打中了
    expect(got).toBeNull()
  })

  it('正常并发写(列的时候同目录新建了一个文件):重试一次照常返回,不误判', async () => {
    const dir = join(ws(), 'busy')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'a.md'), 'x')
    let n = 0
    const sibling = async (): Promise<void> => { if (n++ === 0) await writeFile(join(ws(), `busy-sibling-${Date.now()}.md`), 'y') }
    expect(await withVerifiedUnitPath(dir, roots(), env, guard, true, (real) => readdir(real), { afterOpen: sibling })).toEqual(['a.md'])
    expect(n).toBe(2) // 第一次指纹不等(父目录 mtime 变了)→ 重试一次
  })
})

