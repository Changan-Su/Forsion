import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, realpathSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { commitGitVersion, findGit, gitCandidates, gitHistoryStatus, listGitVersions, restoreGitVersion } from './gitHistory'
import type { GitEnv, GitLabels } from './gitHistory'
import { PRODUCT_SIDECAR } from '../shared/products'

const GIT = findGit()
const PRODUCT = PRODUCT_SIDECAR
const CONNECT = '.forsion-connect.json'
const MARKER = 'forsion-history'
const CLT_GIT = '/Library/Developer/CommandLineTools/usr/bin/git'
const XCODE_GIT = '/Applications/Xcode.app/Contents/Developer/usr/bin/git'

/** APFS 的 firmlink:`/System/Volumes/Data<path>` 与 `<path>` 是同一个 inode 却是两个字符串。只有 darwin 有这条路。 */
const FIRMLINK = process.platform === 'darwin' && existsSync(`/System/Volumes/Data${realpathSync(os.tmpdir())}`)

let home: string
let root: string
let env: NodeJS.ProcessEnv
let g: GitEnv

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'git-history-')))
  root = path.join(home, 'project')
  await fs.mkdir(root)
  // 开发机的全局 / 系统 config 一律隔离:user.email、commit.gpgsign、init.defaultBranch 都不许漏进来,
  // 否则「身份兜底」那条用例在配过 git 的机器上恒绿(假绿),在 CI 上才暴露。
  env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, 'xdg'), GIT_CONFIG_GLOBAL: path.join(home, 'absent-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' }
  for (const key of ['EMAIL', 'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_CONFIG', 'GIT_CONFIG_SYSTEM', 'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL']) delete env[key]
  g = { env }
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

/** 台架自己跑的 git:身份走命令行 -c(不写进仓配置,免得污染被测的身份兜底);quotepath 关掉才看得到 CJK 路径原文。 */
const raw = (cwd: string, ...args: string[]): string =>
  execFileSync(String(GIT), ['-C', cwd, '-c', 'user.name=Tester', '-c', 'user.email=tester@example.com', '-c', 'commit.gpgsign=false', '-c', 'core.quotepath=false', ...args],
    { env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/** 用 gitPath 这条测试缝挂一个 shim:按 `body` 把某些调用弄失败,其余原样转发给真 git(win32 上没有 sh,调用方要跳过)。 */
async function gitShim(name: string, body: string): Promise<string> {
  const file = path.join(home, name)
  await fs.writeFile(file, `#!/bin/sh\n${body}\nexec ${JSON.stringify(String(GIT))} "$@"\n`, { mode: 0o755 })
  return file
}

async function put(relative: string, content: string): Promise<void> {
  const file = path.join(root, relative)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content, 'utf8')
}
const text = (relative: string): Promise<string> => fs.readFile(path.join(root, relative), 'utf8')
const lines = (value: string): string[] => value.split('\n')

describe('git discovery and hosts without git', () => {
  it('finds git by file existence alone, never by spawning it', async () => {
    const bin = path.join(home, 'bin')
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, 'git'), '#!/bin/sh\nexit 66\n', { mode: 0o755 }) // 跑起来必失败:命中说明只看了文件在不在
    expect(findGit({ PATH: bin }, 'linux')).toBe(path.join(bin, 'git'))
    expect(findGit({ PATH: `${path.join(home, 'missing')}${path.delimiter}${bin}` }, 'linux')).toBe(path.join(bin, 'git'))
    expect(findGit({ PATH: '' }, 'linux')).toBeNull()
    expect(findGit({}, 'linux')).toBeNull()
  })

  it('never offers the /usr/bin shim as a darwin candidate', () => {
    // 钉候选表而不是 findGit 的返回值:开发机上 CLT / Xcode 必然存在,断言返回值在过滤规则被删掉后照样绿(假绿)。
    expect(gitCandidates({ PATH: '/usr/bin' }, 'darwin')).not.toContain('/usr/bin/git')
    expect(gitCandidates({ PATH: `/usr/bin${path.delimiter}/usr/bin/` }, 'darwin')).not.toContain('/usr/bin/git')
    expect(gitCandidates({ PATH: '/usr/bin' }, 'linux')).toContain('/usr/bin/git') // 过滤只针对 darwin 的那个 shim
  })

  it('prefers a newer user-installed git over the Command Line Tools one on darwin', () => {
    // 新 git 读得了旧 git 写的仓,反过来读不了(CLT 的 2.39 撞上 reftable 仓直接 fatal)→ 顺序不能倒。
    const list = gitCandidates({ PATH: '/opt/tools/bin' }, 'darwin')
    expect(list[0]).toBe('/opt/tools/bin/git')
    expect(list.indexOf('/opt/homebrew/bin/git')).toBeLessThan(list.indexOf('/usr/local/bin/git'))
    expect(list.indexOf('/usr/local/bin/git')).toBeLessThan(list.indexOf(CLT_GIT))
    expect(list.indexOf(CLT_GIT)).toBeLessThan(list.indexOf(XCODE_GIT))
  })

  it('honours PATHEXT minimally on win32', async () => {
    const bin = path.join(home, 'winbin')
    await fs.mkdir(bin)
    await fs.writeFile(path.join(bin, 'git.cmd'), '')
    expect(findGit({ PATH: bin, PATHEXT: '.COM;.EXE;.BAT;.CMD' }, 'win32')).toBe(path.join(bin, 'git.cmd'))
    expect(findGit({ PATH: bin, PATHEXT: '.COM;.EXE' }, 'win32')).toBeNull()
  })

  it('degrades to an install suggestion when git is missing', async () => {
    const off: GitEnv = { gitPath: null }
    await put('index.html', '<h1>hi</h1>')
    expect(await gitHistoryStatus(root, off)).toEqual({ available: false, state: 'none', dirty: false })
    expect(await listGitVersions(root, off)).toEqual([])
    await expect(commitGitVersion(root, { name: 'x', auto: true }, off)).rejects.toThrow(/git is not installed/)
    await expect(restoreGitVersion(root, 'abcdef1', off)).rejects.toThrow(/git is not installed/)
    expect(existsSync(path.join(root, '.git'))).toBe(false)
  })

  it('rejects a relative or missing project root', async () => {
    await expect(gitHistoryStatus('relative/project', { gitPath: null })).rejects.toThrow(/absolute/)
    await expect(gitHistoryStatus(path.join(home, 'absent'), { gitPath: null })).rejects.toThrow(/does not exist/)
    await fs.writeFile(path.join(home, 'file.txt'), 'x')
    await expect(gitHistoryStatus(path.join(home, 'file.txt'), { gitPath: null })).rejects.toThrow(/not a directory/)
  })
})

describe.skipIf(!GIT)('git version history', () => {
  it('initialises an owned repository with a seeded .gitignore', async () => {
    await put('index.html', '<h1>hi</h1>')
    await put('.env', 'SECRET=1')
    await put(PRODUCT, '{"id":"p_1"}')
    await put(CONNECT, '{"slug":"demo"}')
    expect(await gitHistoryStatus(root, g)).toEqual({ available: true, state: 'none', dirty: false })

    const version = await commitGitVersion(root, { name: 'First version', auto: false }, g)
    expect(version).not.toBeNull()
    expect(version!.id).toMatch(/^[0-9a-f]{40}$/)
    expect(await fs.readFile(path.join(root, '.git', MARKER), 'utf8')).toContain('Forsion')
    const ignore = lines(await text('.gitignore'))
    for (const line of ['node_modules/', 'dist/', '.DS_Store', '.env', '.env.*', '!.env.example', '*.pem', '*.key', PRODUCT, CONNECT]) expect(ignore).toContain(line)
    const tracked = lines(raw(root, 'ls-files'))
    expect(tracked).toEqual(expect.arrayContaining(['.gitignore', 'index.html']))
    for (const untracked of ['.env', PRODUCT, CONNECT]) expect(tracked).not.toContain(untracked)
    expect(raw(root, 'rev-parse', '--abbrev-ref', 'HEAD')).toBe('main')
    expect(await gitHistoryStatus(root, g)).toEqual({ available: true, state: 'owned', dirty: false })
  })

  it('appends only the missing ignore lines and leaves existing ones alone', async () => {
    const original = '# mine\nnode_modules/\n*.log\n'
    await put('.gitignore', original)
    await put('app.js', 'console.log(1)')
    await commitGitVersion(root, { name: 'First', auto: true }, g)
    const ignore = await text('.gitignore')
    expect(ignore.startsWith(original)).toBe(true)
    expect(lines(ignore).filter((line) => line === 'node_modules/')).toHaveLength(1)
    expect(lines(ignore)).toContain('*.log')
    expect(ignore).toContain('# Forsion')
    expect(lines(ignore)).toContain(CONNECT)
  })

  it('returns null when there is nothing to commit', async () => {
    await put('a.txt', 'a')
    expect(await commitGitVersion(root, { name: 'one', auto: true }, g)).not.toBeNull()
    expect(await commitGitVersion(root, { name: 'two', auto: true }, g)).toBeNull()
    expect(await listGitVersions(root, g)).toHaveLength(1)
  })

  it('round-trips the auto/manual trailer and sanitises the subject', async () => {
    await put('a.txt', 'a')
    await commitGitVersion(root, { name: '  版本 "一"\n第二行\tx  ', auto: false }, g)
    await put('b.txt', 'b')
    await commitGitVersion(root, { name: 'auto run', auto: true }, g)

    const list = await listGitVersions(root, g)
    expect(list).toHaveLength(2)
    expect(list[0]).toMatchObject({ name: 'auto run', auto: true, files: 1 })
    expect(list[1]).toMatchObject({ name: '版本 "一" 第二行 x', auto: false, files: 2 }) // 首个提交含 a.txt + .gitignore
    expect(list[1].createdAt).toBeGreaterThan(Date.now() - 120_000)
    expect(list[1].createdAt).toBeLessThanOrEqual(Date.now() + 5_000)
    expect(raw(root, 'log', '-1', '--format=%s')).toBe('auto run')
  })

  it('falls back to a default subject and honours the limit', async () => {
    await put('a.txt', 'a')
    await commitGitVersion(root, { name: '   \n\t ', auto: true }, g)
    await put('b.txt', 'b')
    await commitGitVersion(root, { name: 'x'.repeat(200), auto: true }, g)
    const list = await listGitVersions(root, g, 1)
    expect(list).toHaveLength(1)
    expect(list[0].name).toHaveLength(120)
    expect((await listGitVersions(root, g))[1].name).toBe('Untitled version')
    // 要 0 条就给 0 条 —— 以前的 Math.max(1, …) 会把它悄悄变成 1 条。
    expect(await listGitVersions(root, g, 0)).toEqual([])
    expect(await listGitVersions(root, g, -5)).toEqual([])
    expect(await listGitVersions(root, g, Number.NaN)).toEqual([])
  })

  it('takes the on-disk commit names from the caller so they follow the interface language', async () => {
    // 提交标题写下就不可变,渲染期翻不了 → 语言必须在写入那一刻由调用方给;模块只留英文兜底。
    const labels: GitLabels = { untitled: '未命名版本', backup: '恢复前备份', restorePrefix: '恢复到' }
    await put('a.txt', 'v1')
    const first = await commitGitVersion(root, { name: '  \n ', auto: true, labels }, g)
    expect(first!.name).toBe('未命名版本')
    await put('a.txt', 'v2')
    await commitGitVersion(root, { name: '第二版', auto: true, labels }, g)
    await put('a.txt', 'dirty')

    const summary = await restoreGitVersion(root, first!.id, g, labels)
    expect(summary.backupId).toMatch(/^[0-9a-f]{40}$/)
    const list = await listGitVersions(root, g)
    expect(list[0].name).toBe('恢复到 未命名版本')
    expect(list[1].name).toBe('恢复前备份')
    expect(raw(root, 'log', '-1', '--format=%s')).toBe('恢复到 未命名版本')

    await put('b.txt', 'x')
    expect((await commitGitVersion(root, { name: '', auto: true }, g))!.name).toBe('Untitled version') // 不传 labels 时的最后一道保险
  })

  it('strips non-whitespace control characters from the subject', async () => {
    // NUL / BEL / ESC / DEL:NUL 会让 execFile 直接抛(参数不许含空字节),ESC 会把终端与日志染成控制序列。
    const control = String.fromCharCode(0, 7, 27, 127)
    await put('a.txt', 'a')
    const version = await commitGitVersion(root, { name: `版本${control}三`, auto: true }, g)
    expect(version!.name).toBe('版本 三')
    expect(raw(root, 'log', '-1', '--format=%s')).toBe('版本 三')
  })

  it('truncates by code point so a surrogate pair is never cut in half', async () => {
    await put('a.txt', 'a')
    await commitGitVersion(root, { name: `${'x'.repeat(119)}😀tail`, auto: true }, g)
    const name = (await listGitVersions(root, g))[0].name
    expect(name).toBe(`${'x'.repeat(119)}😀`)
    expect(Array.from(name).map((ch) => ch.codePointAt(0))).not.toContain(0xfffd) // 切出半个代理对的话,落盘再读回来就是 U+FFFD
  })

  it('commits CJK file names', async () => {
    await put('笔记/第一章 草稿.md', '# 你好')
    const version = await commitGitVersion(root, { name: '中文文件', auto: true }, g)
    expect(version?.files).toBe(2)
    expect(lines(raw(root, 'ls-files'))).toContain('笔记/第一章 草稿.md')
    expect((await listGitVersions(root, g))[0].name).toBe('中文文件')
  })

  it('treats a repository without the marker as the user own and read-only', async () => {
    raw(root, 'init', '-q')
    raw(root, 'symbolic-ref', 'HEAD', 'refs/heads/main')
    await put('a.txt', 'a')
    raw(root, 'add', '-A')
    raw(root, 'commit', '-q', '-m', 'user commit')

    expect(await gitHistoryStatus(root, g)).toEqual({ available: true, state: 'foreign', dirty: false })
    const list = await listGitVersions(root, g)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name: 'user commit', auto: false, files: 1 })
    await expect(commitGitVersion(root, { name: 'x', auto: true }, g)).rejects.toThrow('read-only repository')
    await expect(restoreGitVersion(root, list[0].id, g)).rejects.toThrow('read-only repository')
    expect(raw(root, 'rev-list', '--count', 'HEAD')).toBe('1')
    await put('b.txt', 'b')
    expect(await gitHistoryStatus(root, g)).toMatchObject({ state: 'foreign', dirty: true })
  })

  it('treats a project inside another repository as nested and never inits inside it', async () => {
    const parent = path.join(home, 'parent')
    await fs.mkdir(parent)
    raw(parent, 'init', '-q')
    const nested = path.join(parent, 'app')
    await fs.mkdir(nested)
    await fs.writeFile(path.join(nested, 'a.txt'), 'a')

    expect(await gitHistoryStatus(nested, g)).toMatchObject({ available: true, state: 'nested' })
    await expect(commitGitVersion(nested, { name: 'x', auto: true }, g)).rejects.toThrow('read-only repository')
    await expect(restoreGitVersion(nested, '0123456', g)).rejects.toThrow('read-only repository')
    expect(existsSync(path.join(nested, '.git'))).toBe(false)
  })

  it.skipIf(!FIRMLINK)('keeps its own repository writable when git and realpath spell the root differently', async () => {
    // 同一个目录的两种写法:fs.realpath 折不掉 APFS 的 firmlink 前缀,git 的 getcwd 折得掉 ——
    // 比字符串就把自家仓判成 nested,版本管理从此静默只读(大小写不一致、Windows 短名同理)。
    const via = `/System/Volumes/Data${root}`
    await put('a.txt', 'v1')
    expect(await commitGitVersion(via, { name: 'v1', auto: true }, g)).not.toBeNull()
    expect(await fs.realpath(via)).not.toBe(root) // 两边确实是不同的字符串,否则这条用例是假绿
    expect(await gitHistoryStatus(via, g)).toMatchObject({ state: 'owned' })
    await put('b.txt', 'v2')
    expect(await commitGitVersion(via, { name: 'v2', auto: true }, g)).not.toBeNull()
    expect(raw(root, 'rev-list', '--count', 'HEAD')).toBe('2')
  })

  it('restores a target without losing the working tree or ignored files', async () => {
    await put('keep.txt', 'v1')
    await put('.env', 'SECRET=1')
    await put(PRODUCT, '{"id":"p_1"}')
    const first = await commitGitVersion(root, { name: 'v1', auto: false }, g)
    await put('keep.txt', 'v2')
    await put('added.txt', 'later')
    await commitGitVersion(root, { name: 'v2', auto: true }, g)
    await put('keep.txt', 'uncommitted work') // 恢复前的现场,必须先进备份提交
    const before = Number(raw(root, 'rev-list', '--count', 'HEAD'))

    const summary = await restoreGitVersion(root, first!.id, g)
    expect(summary.backupId).toMatch(/^[0-9a-f]{40}$/)
    expect(summary.restoreId).toMatch(/^[0-9a-f]{40}$/)
    expect(await text('keep.txt')).toBe('v1')
    expect(existsSync(path.join(root, 'added.txt'))).toBe(false) // 目标之后才加的已跟踪文件被删掉
    expect(await text('.env')).toBe('SECRET=1') // 被忽略的未跟踪文件原封不动
    expect(await text(PRODUCT)).toBe('{"id":"p_1"}')
    expect(raw(root, 'show', `${summary.backupId}:keep.txt`)).toBe('uncommitted work') // 现场没丢
    expect(Number(raw(root, 'rev-list', '--count', 'HEAD'))).toBe(before + 2) // 线性:只增两个提交
    expect(lines(raw(root, 'rev-list', 'HEAD'))).toContain(first!.id) // 目标仍是 HEAD 的祖先,历史没被改写
    expect(raw(root, 'status', '--porcelain')).toBe('')

    const list = await listGitVersions(root, g)
    expect(list[0]).toMatchObject({ name: 'Restore: v1', auto: false })
    expect(list[1]).toMatchObject({ name: 'Backup before restore', auto: true })
  })

  it('skips the backup commit when the working tree is already clean', async () => {
    await put('keep.txt', 'v1')
    const first = await commitGitVersion(root, { name: 'v1', auto: true }, g)
    await put('keep.txt', 'v2')
    await commitGitVersion(root, { name: 'v2', auto: true }, g)

    const summary = await restoreGitVersion(root, first!.id, g)
    expect(summary.backupId).toBeNull()
    expect(summary.restoreId).toMatch(/^[0-9a-f]{40}$/)
    expect(await text('keep.txt')).toBe('v1')
    // 目标就是 HEAD → 两步都无事可做
    const same = await restoreGitVersion(root, (await listGitVersions(root, g))[0].id, g)
    expect(same).toEqual({ backupId: null, restoreId: null })
  })

  it('rejects a bogus id and a commit outside this history', async () => {
    await put('a.txt', 'a')
    await commitGitVersion(root, { name: 'v1', auto: true }, g)
    await expect(restoreGitVersion(root, 'zzz', g)).rejects.toThrow(/invalid version id/)
    await expect(restoreGitVersion(root, '../../etc/passwd', g)).rejects.toThrow(/invalid version id/)
    await expect(restoreGitVersion(root, '0123456789abcdef0123456789abcdef01234567', g)).rejects.toThrow(/not found/)

    raw(root, 'checkout', '-q', '-b', 'side')
    await put('side.txt', 's')
    raw(root, 'add', '-A')
    raw(root, 'commit', '-q', '-m', 'side work')
    const side = raw(root, 'rev-parse', 'HEAD')
    raw(root, 'checkout', '-q', 'main')
    await expect(restoreGitVersion(root, side, g)).rejects.toThrow(/not part of this history/)
  })

  it('serialises concurrent commits on the same root', async () => {
    await put('a.txt', 'a')
    const results = await Promise.all([
      commitGitVersion(root, { name: 'first', auto: true }, g),
      commitGitVersion(root, { name: 'second', auto: false }, g),
      commitGitVersion(root, { name: 'third', auto: true }, g),
    ])
    expect(results.filter(Boolean)).toHaveLength(1) // 后两次落在队列里,看到的是已经干净的工作区
    expect(await listGitVersions(root, g)).toHaveLength(1)
    expect(existsSync(path.join(root, '.git', 'index.lock'))).toBe(false)
  })

  it('uses a Forsion identity only when the user has none', async () => {
    await put('a.txt', 'a')
    await commitGitVersion(root, { name: 'v1', auto: true }, g)
    expect(raw(root, 'log', '-1', '--format=%ae')).toBe('forsion@localhost')
    expect(raw(root, 'log', '-1', '--format=%an')).toBe('Forsion')

    raw(root, 'config', 'user.email', 'me@example.com')
    raw(root, 'config', 'user.name', 'Me')
    await put('b.txt', 'b')
    await commitGitVersion(root, { name: 'v2', auto: true }, g)
    expect(raw(root, 'log', '-1', '--format=%ae')).toBe('me@example.com')
    expect(raw(root, 'log', '-1', '--format=%an')).toBe('Me')
  })

  it('commits although the repository config demands a gpg signature', async () => {
    // `-c commit.gpgsign=false` 是承重的:全局开了签名的用户(很常见)否则每一次自动版本都失败。
    // 这里故意写进**仓的 local config**(全局 config 已被台架整个隔离,拿它验等于绕过而不是验证)。
    await put('a.txt', 'a')
    await commitGitVersion(root, { name: 'v1', auto: true }, g)
    raw(root, 'config', 'commit.gpgsign', 'true')
    raw(root, 'config', 'user.signingkey', 'FORSION-NO-SUCH-SIGNING-KEY')
    await put('b.txt', 'b')
    expect(await commitGitVersion(root, { name: 'v2', auto: true }, g)).not.toBeNull()
    expect(raw(root, 'log', '-1', '--format=%s')).toBe('v2')
  })

  it.skipIf(process.platform === 'win32')('commits although the repository has a failing pre-commit hook', async () => {
    // `-c core.hooksPath=/dev/null` 同样承重:husky / 模板带来的 pre-commit 否则能把自动版本整个卡死。
    await put('a.txt', 'a')
    await commitGitVersion(root, { name: 'v1', auto: true }, g)
    const hook = path.join(root, '.git', 'hooks', 'pre-commit')
    await fs.mkdir(path.dirname(hook), { recursive: true })
    await fs.writeFile(hook, '#!/bin/sh\nexit 1\n', { mode: 0o755 })
    await put('b.txt', 'b')
    expect(await commitGitVersion(root, { name: 'v2', auto: true }, g)).not.toBeNull()
    expect(raw(root, 'log', '-1', '--format=%s')).toBe('v2')
  })

  it('ignores a GIT_DIR inherited from the caller environment', async () => {
    // 调用方 env 里的 GIT_DIR 会让 `init` 去重新初始化那个外部仓,marker 随后 ENOENT —— 一律就地清洗。
    const outside = path.join(home, 'outside')
    await fs.mkdir(outside)
    const poisoned: GitEnv = { env: { ...env, GIT_DIR: outside, GIT_WORK_TREE: outside } }
    await put('a.txt', 'a')
    expect(await commitGitVersion(root, { name: 'v1', auto: true }, poisoned)).not.toBeNull()
    expect(existsSync(path.join(root, '.git', MARKER))).toBe(true)
    expect(existsSync(path.join(outside, 'HEAD'))).toBe(false) // 外部 GIT_DIR 没被碰过
    expect(await gitHistoryStatus(root, poisoned)).toEqual({ available: true, state: 'owned', dirty: false })
  })

  it.skipIf(process.platform === 'win32')('never degrades the receipt to null once the commit has landed', async () => {
    // 回执 null 的契约含义是「没东西可提」;restore 那边 backupId:null 更被读成「现场本来就干净,没做备份」。
    // 大仓 / 冷盘上详情那条 log 会撞 5s 读超时 —— 这里用 shim 把带 --shortstat 的读全部打掉来等价复现。
    const shim = await gitShim('git-no-shortstat', 'for a in "$@"; do\n  if [ "$a" = "--shortstat" ]; then exit 128; fi\ndone')
    const broken: GitEnv = { env, gitPath: shim }
    await put('a.txt', 'v1')
    const first = await commitGitVersion(root, { name: 'v1', auto: false }, broken)
    expect(first).not.toBeNull()
    expect(first!.id).toBe(raw(root, 'rev-parse', 'HEAD'))
    expect(first!).toMatchObject({ name: 'v1', auto: false })
    expect(await listGitVersions(root, broken)).toEqual([]) // 详情读确实是坏的,不是 shim 没挂上

    await put('a.txt', 'v2')
    await commitGitVersion(root, { name: 'v2', auto: true }, broken)
    await put('a.txt', 'uncommitted work')
    const before = Number(raw(root, 'rev-list', '--count', 'HEAD'))
    const summary = await restoreGitVersion(root, first!.id, broken)
    expect(Number(raw(root, 'rev-list', '--count', 'HEAD'))).toBe(before + 2) // 两个提交真的落了盘
    expect(summary.backupId).toMatch(/^[0-9a-f]{40}$/)
    expect(summary.restoreId).toMatch(/^[0-9a-f]{40}$/)
    expect(raw(root, 'show', `${summary.backupId}:a.txt`)).toBe('uncommitted work') // 报出来的备份点真能取回现场
    expect(raw(root, 'rev-parse', 'HEAD')).toBe(summary.restoreId)
  })

  it.skipIf(process.platform === 'win32')('stops before touching anything when the target subject cannot be read', async () => {
    // 目标标题读不出来还硬走下去,历史里就永久留下一个光秃秃的「Restore:」—— 提交标题写下就改不了了。
    await put('a.txt', 'v1')
    const first = await commitGitVersion(root, { name: 'v1', auto: true }, g)
    await put('a.txt', 'v2')
    await commitGitVersion(root, { name: 'v2', auto: true }, g)
    const before = Number(raw(root, 'rev-list', '--count', 'HEAD'))

    const shim = await gitShim('git-no-subject', 'for a in "$@"; do\n  if [ "$a" = "--format=%s" ]; then exit 128; fi\ndone')
    await expect(restoreGitVersion(root, first!.id, { env, gitPath: shim })).rejects.toThrow(/could not read the version/)
    expect(Number(raw(root, 'rev-list', '--count', 'HEAD'))).toBe(before) // 一个提交都没落
    expect(await text('a.txt')).toBe('v2') // 工作区也没被动过
  })
})

/**
 * 「有仓,但 git 读不出来」这一档。rev-parse 失败的原因五花八门(dubious ownership / 指向已删 worktree 的
 * gitfile / 我们这份 git 比用户的旧 / 读超时),判成 none 就等于让界面把用户请进「在自己的仓里 git init」。
 */
describe.skipIf(!GIT)('repositories git cannot read', () => {
  const fixtures: [string, (dir: string) => Promise<void>][] = [
    ['an empty .git directory', async (dir) => { await fs.mkdir(path.join(dir, '.git'), { recursive: true }) }],
    ['a .git file pointing nowhere', async (dir) => { await fs.writeFile(path.join(dir, '.git'), 'gitdir: /forsion/no/such/gitdir\n', 'utf8') }],
  ]

  for (const [label, plant] of fixtures) {
    it(`treats ${label} at the project root as a read-only foreign repository`, async () => {
      await plant(root)
      await put('a.txt', 'a')
      expect(await gitHistoryStatus(root, g)).toMatchObject({ available: true, state: 'foreign' })
      await expect(commitGitVersion(root, { name: 'x', auto: true }, g)).rejects.toThrow('read-only repository')
      await expect(restoreGitVersion(root, '0123456', g)).rejects.toThrow('read-only repository')
      expect(existsSync(path.join(root, '.git', MARKER))).toBe(false)
      expect(existsSync(path.join(root, '.git', 'HEAD'))).toBe(false) // 没被 git init 重新初始化
      expect(existsSync(path.join(root, '.gitignore'))).toBe(false)
    })

    it(`treats ${label} in an ancestor as nested and never inits inside the project`, async () => {
      await plant(home)
      await put('a.txt', 'a')
      expect(await gitHistoryStatus(root, g)).toMatchObject({ available: true, state: 'nested' })
      await expect(commitGitVersion(root, { name: 'x', auto: true }, g)).rejects.toThrow('read-only repository')
      await expect(restoreGitVersion(root, '0123456', g)).rejects.toThrow('read-only repository')
      expect(await listGitVersions(root, g)).toEqual([])
      expect(existsSync(path.join(root, '.git'))).toBe(false) // 用户自己的仓里绝不会多出一个 .git
      expect(existsSync(path.join(root, '.gitignore'))).toBe(false)
    })
  }
})
