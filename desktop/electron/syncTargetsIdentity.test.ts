/**
 * 智库同步 H3 清单第 7 件:CloudHost.syncTargets.identity(targetId, dir) 与 legacyRemoteSync().currentTargetId
 * (契约 step34「H3 追加」「H3 追加 2」「H3 接口定稿」第 3 节,外加 H 补的串格式口径)。
 * 身份串:同一物理位置同一个串;分隔符一律 '/'、不以 '/' 结尾、没有空段 / '.' / '..';以「后端 + 权威部分」开头;
 * A 是 B 的祖先 ⇔ B 以 A + '/' 开头;不带凭据。只抛 target-not-found / target-identity-unavailable。
 * 不发任何真网盘请求:fetch 换成绊线,Dropbox 取账号那一下单独 stub。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, promises as fsp, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const env = vi.hoisted(() => ({ root: '' }))
vi.mock('electron', () => ({
  app: { getPath: () => join(env.root, 'userData') },
  ipcMain: { handle: () => {} },
  BrowserWindow: { getAllWindows: () => [] },
  shell: { trashItem: async () => {}, openExternal: async () => {} },
}))
vi.mock('./forsionHome', () => ({ isDevMode: () => false, forsionHomeDir: () => join(env.root, 'home') }))
vi.mock('./amadeus/settings', () => ({
  readConfig: async () => ({ lastVault: join(env.root, 'Vault'), localVault: join(env.root, 'Vault'), entrySync: [] }),
  readEntrySyncSnapshotStrict: async () => ({ config: { lastVault: join(env.root, 'Vault'), localVault: join(env.root, 'Vault'), entrySync: [] }, allEntrySync: [] }),
  currentCloudAccountId: () => null,
}))
vi.mock('./amadeus/cloudPaths', () => ({
  cloudVaultDir: () => join(env.root, 'cloud-mirror'),
  isManagedCloudVault: () => false,
  hash8: (s: string) => require('node:crypto').createHash('sha256').update(s).digest('hex').slice(0, 8),
}))
vi.mock('./contentSyncHost', () => ({ contentSyncOwned: () => false }))
vi.mock('./syncRecordsIpc', () => ({ appendSyncRecord: () => {} }))

type Mod = typeof import('./syncTargets')
let mod: Mod
const userData = () => join(env.root, 'userData')
const storeFile = () => join(userData(), 'sync-targets.json')
const SECRETS = ['fixture-secret-value', 'fixture-access-key', 'fixture-user', 'fixture-refresh-token', 'dbid:fixture-account']
const noSecrets = (x: unknown): void => { const s = JSON.stringify(x); for (const v of SECRETS) { expect(s).not.toContain(v); expect(s).not.toContain(encodeURIComponent(v)) } }

function writeTargets(targets: Record<string, { kind: string; section: Record<string, unknown>; source?: string }>, legacy?: Record<string, unknown>): void {
  const now = Date.now()
  const out: Record<string, unknown> = {}
  for (const [id, t] of Object.entries(targets)) out[id] = { kind: t.kind, label: id, section: t.section, source: t.source ?? 'user', createdAt: now, updatedAt: now }
  writeFileSync(storeFile(), JSON.stringify({ version: 1, targets: out, ...(legacy ? { legacy } : {}) }), { mode: 0o600 })
}

async function seam() {
  vi.resetModules()
  mod = await import('./syncTargets')
  return mod.createSyncTargets()
}
const fetchTripwire = vi.fn(async (url: unknown) => { throw new Error(`unexpected network request: ${String(url)}`) })

beforeEach(() => {
  env.root = realpathSync(mkdtempSync(join(tmpdir(), 'forsion-target-id-')))
  mkdirSync(join(env.root, 'Vault'), { recursive: true })
  mkdirSync(join(env.root, 'Base', 'Notes'), { recursive: true })
  mkdirSync(userData(), { recursive: true })
  fetchTripwire.mockClear()
  vi.stubGlobal('fetch', fetchTripwire)
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); rmSync(env.root, { recursive: true, force: true }) })

/** 身份串的格式口径(H 补):不以 '/' 结尾、没有空段 / '.' / '..'。 */
function wellFormed(id: string): void {
  expect(id).not.toBe('')
  expect(id.endsWith('/')).toBe(false)
  const segs = id.split('/').slice(1)
  for (const s of segs) expect(['', '.', '..']).not.toContain(s)
}
const under = (child: string, parent: string): boolean => child.startsWith(`${parent}/`)
/** 这个值的任何形式都不在串里:原样、小写、URI 编码一次 / 两次、base64。 */
function noFormOf(id: string, ...values: string[]): void {
  for (const v of values) {
    for (const form of [v, v.toLowerCase(), encodeURIComponent(v), encodeURIComponent(encodeURIComponent(v)), Buffer.from(v).toString('base64')]) expect(id).not.toContain(form)
    expect(decodeURIComponent(decodeURIComponent(id))).not.toContain(v)
  }
}

describe('folder targets', () => {
  it('one physical place, one string: a symlink alias, a trailing slash, a .. in the path and a missing subfolder all agree', async () => {
    symlinkSync(join(env.root, 'Base'), join(env.root, 'Link'))
    writeTargets({
      a: { kind: 'folder', section: { path: join(env.root, 'Base') } },
      b: { kind: 'folder', section: { path: join(env.root, 'Link') + '/' } },
      c: { kind: 'folder', section: { path: join(env.root, 'Vault', '..', 'Base') } },
    })
    const s = await seam()
    const a = await s.identity('a', 'Notes')
    expect(await s.identity('b', 'Notes')).toBe(a)
    expect(await s.identity('c', 'Notes')).toBe(a)
    expect(a.startsWith('folder:/')).toBe(true)
    expect(a.toLowerCase().endsWith('/base/notes')).toBe(true)
    wellFormed(a)
    // 子目录还不在:最深那层 realpath,余下几段接上
    const missing = await s.identity('b', 'Notes/New/Deeper')
    expect(missing).toBe(await s.identity('a', 'Notes/New/Deeper'))
    expect(under(missing, a)).toBe(true)
    wellFormed(missing)
  })

  it('ancestor ⇔ prefix + "/": the root, a child, a sibling with a longer name', async () => {
    writeTargets({ a: { kind: 'folder', section: { path: join(env.root, 'Base') } } })
    const s = await seam()
    const root = await s.identity('a', '')
    const notes = await s.identity('a', 'Notes')
    const notes2 = await s.identity('a', 'Notes2')
    const deep = await s.identity('a', 'Notes/x/y')
    expect(under(notes, root)).toBe(true)
    expect(under(deep, notes)).toBe(true)
    expect(under(notes2, notes)).toBe(false)
    expect(under(notes, notes2)).toBe(false)
    expect(under(root, notes)).toBe(false)
    for (const x of [root, notes, notes2, deep]) wellFormed(x)
  })

  it('the filesystem root is "folder:" with no trailing slash; everything on this disk is under it', async () => {
    writeTargets({ r: { kind: 'folder', section: { path: '/' } }, a: { kind: 'folder', section: { path: join(env.root, 'Base') } } })
    const s = await seam()
    const root = await s.identity('r', '')
    expect(root).toBe('folder:')
    expect(under(await s.identity('a', ''), root)).toBe(true)
  })

  it('case follows the volume: on a case-insensitive volume Notes and notes are one string; on a case-sensitive one they are two', async () => {
    writeTargets({ up: { kind: 'folder', section: { path: join(env.root, 'Base') } }, low: { kind: 'folder', section: { path: join(env.root, 'base') } } })
    const s = await seam()
    const insensitive = existsSync(join(env.root, 'BASE'))
    if (insensitive) {
      expect(await s.identity('low', 'notes')).toBe(await s.identity('up', 'Notes'))
      expect(await s.identity('low', 'NEW/Sub')).toBe(await s.identity('up', 'new/sub')) // 还不在的几段也折
    } else {
      await expect(s.identity('low', 'notes')).resolves.not.toBe(await s.identity('up', 'Notes'))
    }
  })

  it('segments not created yet under an empty folder follow that folder\'s volume (Codex P2)', async () => {
    mkdirSync(join(env.root, 'Empty'))
    writeTargets({ up: { kind: 'folder', section: { path: join(env.root, 'Empty') } }, low: { kind: 'folder', section: { path: join(env.root, 'empty') } } })
    const s = await seam()
    const up = await s.identity('up', 'Sub/X')
    wellFormed(up)
    if (existsSync(join(env.root, 'EMPTY'))) expect(await s.identity('low', 'sub/x')).toBe(up) // 不分大小写的卷
    else expect(up.endsWith('/Sub/X')).toBe(true) // 分大小写的卷:原样
  })

  it('when the volume rule for segments not created yet cannot be told, it is unavailable (existing paths still resolve)', async () => {
    writeTargets({ a: { kind: 'folder', section: { path: join(env.root, 'Base') } } })
    const s = await seam()
    const spy = vi.spyOn(fsp, 'lstat').mockRejectedValue(Object.assign(new Error('io'), { code: 'EIO' }))
    try {
      await expect(s.identity('a', 'Notes/NotYet')).rejects.toThrow('target-identity-unavailable')
      await expect(s.identity('a', 'Notes')).resolves.toMatch(/^folder:\//)
    } finally { spy.mockRestore() }
  })

  it('remainderCaseRule: the inside probe first, then a lookup on the same volume, otherwise unknown', async () => {
    await seam()
    expect(mod.remainderCaseRule('keep', [{ parentDev: 1, probe: 'fold' }], 1)).toBe('keep')
    expect(mod.remainderCaseRule('unknown', [{ parentDev: 1, probe: 'keep' }, { parentDev: 2, probe: 'fold' }], 1)).toBe('keep')
    expect(mod.remainderCaseRule('unknown', [{ parentDev: 2, probe: 'fold' }], 1)).toBe('unknown')
    expect(mod.remainderCaseRule('unknown', [{ parentDev: 1, probe: 'unknown' }], 1)).toBe('unknown')
    expect(mod.remainderCaseRule('unknown', [], 1)).toBe('unknown')
    // 分大小写:还没建的段原样
    expect(mod.folderIdentityOf('', ['data', 'New', 'Sub'], [true, false, false])).toBe('folder:/data/New/Sub')
  })

  it('an unreadable folder (no permission) is unavailable, not a guess', async () => {
    const locked = join(env.root, 'locked')
    mkdirSync(join(locked, 'inner'), { recursive: true })
    writeTargets({ l: { kind: 'folder', section: { path: join(locked, 'inner') } } })
    const s = await seam()
    chmodSync(locked, 0o000)
    try {
      await expect(s.identity('l', 'x')).rejects.toThrow('target-identity-unavailable')
    } finally { chmodSync(locked, 0o755) }
  })
})

describe('Windows-style paths (pure string part)', () => {
  it('backslashes become "/", the drive stays, the root has no trailing slash, dot segments are folded away', async () => {
    await seam()
    const id = (p: string): string => { const n = mod.nativeSegments(p, true)!; return mod.folderIdentityOf(n.head, n.segs, n.segs.map(() => true)) }
    expect(id('C:\\Users\\x')).toBe('folder:c:/users/x')
    expect(id('C:\\Users\\x\\')).toBe('folder:c:/users/x')
    expect(id('c:/Users/./x/../y')).toBe('folder:c:/users/y')
    expect(id('C:\\')).toBe('folder:c:')
    expect(id('C:')).toBe('folder:c:')
    expect(under(id('C:\\Users'), id('C:\\'))).toBe(true)
    expect(under(id('D:\\Users'), id('C:\\'))).toBe(false)
    expect(id('\\\\Server\\Share\\Dir')).toBe('folder:unc/server/share/dir')
    expect(mod.nativeSegments('\\\\server', true)).toBeNull()
    expect(mod.nativeSegments('relative\\path', true)).toBeNull()
    // posix 的根和 Windows 的盘符互不为前缀
    const posixRoot = mod.folderIdentityOf('', [], [])
    expect(posixRoot).toBe('folder:')
    expect(under(id('C:\\Users'), posixRoot)).toBe(false)
    for (const x of [id('C:\\Users\\x\\'), id('C:\\'), id('\\\\Server\\Share\\Dir')]) wellFormed(x)
  })

  it('a case-sensitive segment keeps its case', async () => {
    await seam()
    expect(mod.folderIdentityOf('', ['Data', 'Vault'], [false, false])).toBe('folder:/Data/Vault')
    expect(mod.folderIdentityOf('', ['Data', 'Vault'], [true, false])).toBe('folder:/data/Vault')
  })
})

describe('S3 targets', () => {
  const s3 = (over: Record<string, unknown> = {}) => ({ endpoint: 'https://s3.example.test', region: 'auto', bucket: 'notes', prefix: 'team/vault/', accessKeyID: 'fixture-access-key', secretAccessKey: 'fixture-secret-value', ...over })

  it('the endpoint is normalized (case, default port, trailing slash, missing scheme, userinfo); the bucket root has no trailing slash', async () => {
    writeTargets({
      a: { kind: 's3', section: s3() },
      b: { kind: 's3', section: s3({ endpoint: 'HTTPS://S3.Example.TEST:443/', prefix: '/team//vault' }) },
      c: { kind: 's3', section: s3({ endpoint: 's3.example.test', prefix: 'team/vault' }) },
      d: { kind: 's3', section: s3({ endpoint: 'https://someone:pw@s3.example.test' }) },
      root: { kind: 's3', section: s3({ prefix: '' }) },
      other: { kind: 's3', section: s3({ bucket: 'notes2', prefix: '' }) },
      port: { kind: 's3', section: s3({ endpoint: 'https://s3.example.test:9000', prefix: '' }) },
    })
    const s = await seam()
    const a = await s.identity('a', 'x')
    for (const k of ['b', 'c', 'd']) expect(await s.identity(k, 'x')).toBe(a)
    const root = await s.identity('root', '')
    expect(root).toBe(`s3:${encodeURIComponent('https://s3.example.test')}/notes`)
    expect(under(a, root)).toBe(true)
    expect(under(await s.identity('other', ''), root)).toBe(false)
    expect(under(root, await s.identity('other', ''))).toBe(false)
    expect(await s.identity('port', '')).not.toBe(root)
    for (const k of ['a', 'b', 'c', 'd', 'root', 'other', 'port']) { const x = await s.identity(k, k === 'root' ? '' : 'x'); wellFormed(x); noSecrets(x) }
    expect(await s.identity('d', '')).not.toContain('someone')
    expect(fetchTripwire).not.toHaveBeenCalled()
  })
})

describe('userinfo never leaks into the string (Codex P1)', () => {
  const NAME = 'fixture-alice', PASS = 'fixture-pw-secret'
  const clean = `s3:${encodeURIComponent('https://s3.example.test')}/notes`
  it('S3 endpoints: s3:// and other schemes are refused; http(s) and bare hosts drop the userinfo; a mangled one is refused', async () => {
    const cases: Record<string, string> = {
      s3scheme: `s3://${NAME}:${PASS}@s3.example.test`,
      ftp: `ftp://${NAME}:${PASS}@s3.example.test`,
      https: `https://${NAME}:${PASS}@s3.example.test`,
      httpsUpper: `HTTPS://${NAME}:${PASS}@S3.Example.TEST:443/`,
      userOnly: `https://${NAME}@s3.example.test`,
      bare: `${NAME}:${PASS}@s3.example.test`,
      bareUser: `${NAME}@s3.example.test`,
      backslashes: `https:\\\\${NAME}:${PASS}@s3.example.test`,
      mangled: `https://${NAME}:12?x@s3.example.test`,
      slashInPass: `${NAME}:/${PASS}@s3.example.test`,
    }
    writeTargets(Object.fromEntries(Object.entries(cases).map(([k, ep]) => [k, { kind: 's3', section: { endpoint: ep, bucket: 'notes', prefix: '', accessKeyID: 'fixture-access-key', secretAccessKey: 'fixture-secret-value' } }])))
    const s = await seam()
    for (const k of ['s3scheme', 'ftp', 'mangled', 'slashInPass']) await expect(s.identity(k, '')).rejects.toThrow('target-identity-unavailable')
    for (const k of ['https', 'httpsUpper', 'userOnly', 'bare', 'bareUser', 'backslashes']) {
      const id = await s.identity(k, '')
      expect(id).toBe(clean)
      noFormOf(id, NAME, PASS)
    }
  })

  it('WebDAV addresses: same rule (a scheme is required there); userinfo is dropped, a mangled one is refused', async () => {
    const dav = (address: string) => ({ kind: 'webdav', section: { address, username: 'fixture-user', password: 'fixture-secret-value', baseDir: 'v' } })
    writeTargets({
      s3scheme: dav(`s3://${NAME}:${PASS}@dav.example.test/x`),
      bare: dav(`${NAME}:${PASS}@dav.example.test/x`),
      mangled: dav(`https://${NAME}:12?x@dav.example.test/x`),
      https: dav(`https://${NAME}:${PASS}@dav.example.test/x`),
      userOnly: dav(`https://${NAME}@dav.example.test/x`),
      backslashes: dav(`https:\\\\${NAME}:${PASS}@dav.example.test/x`),
      plain: dav('https://dav.example.test/x'),
      mailInPath: dav('https://dav.example.test/remote.php/dav/files/someone@example.test/'),
    })
    const s = await seam()
    for (const k of ['s3scheme', 'bare', 'mangled']) await expect(s.identity(k, '')).rejects.toThrow('target-identity-unavailable')
    const plain = await s.identity('plain', '')
    for (const k of ['https', 'userOnly', 'backslashes']) { const id = await s.identity(k, ''); expect(id).toBe(plain); noFormOf(id, NAME, PASS) }
    await expect(s.identity('mailInPath', '')).resolves.toMatch(/^webdav:/) // 路径里的 @(Nextcloud 用户目录)照常
  })
})

describe('S3 prefixes are taken literally, as the backend uses them (Codex P2)', () => {
  const s3 = (prefix: string) => ({ kind: 's3', section: { endpoint: 'https://s3.example.test', bucket: 'notes', prefix, accessKeyID: 'fixture-access-key', secretAccessKey: 'fixture-secret-value' } })
  it('team/../vault/ stays under team/ (not rewritten to vault/); dot-only segments are escaped; no NFC folding', async () => {
    writeTargets({ dotdot: s3('team/../vault/'), team: s3('team/'), vault: s3('vault/'), dot: s3('a/./b'), ab: s3('a/b'), nfc: s3('caf\u00e9/'), nfd: s3('cafe\u0301/') })
    const s = await seam()
    const dotdot = await s.identity('dotdot', '')
    expect(under(dotdot, await s.identity('team', ''))).toBe(true)
    expect(dotdot).not.toBe(await s.identity('vault', ''))
    expect(dotdot.endsWith('/team/%2E%2E/vault')).toBe(true)
    expect(await s.identity('dot', '')).not.toBe(await s.identity('ab', ''))
    expect((await s.identity('dot', '')).endsWith('/a/%2E/b')).toBe(true)
    expect(await s.identity('nfc', '')).not.toBe(await s.identity('nfd', ''))
    for (const k of ['dotdot', 'dot', 'nfc', 'nfd']) wellFormed(await s.identity(k, ''))
  })
})

describe('WebDAV targets', () => {
  const dav = (over: Record<string, unknown> = {}) => ({ address: 'https://dav.example.test/remote.php/my files', username: 'fixture-user', password: 'fixture-secret-value', baseDir: 'team/vault', ...over })

  it('origin without userinfo + the decoded path: an encoded and a plain address agree; credentials never show up', async () => {
    writeTargets({
      a: { kind: 'webdav', section: dav() },
      b: { kind: 'webdav', section: dav({ address: 'https://fixture-user:fixture-secret-value@DAV.Example.TEST:443/remote.php/my%20files/', baseDir: '/team/vault/' }) },
      c: { kind: 'webdav', section: dav({ address: 'https://dav.example.test/remote.php/my%20fil%65s', baseDir: 'team/./vault' }) }, // %65 = e:多转义了一个字也是同一处
      def: { kind: 'webdav', section: dav({ address: 'https://dav.example.test/', baseDir: '' }) },
    })
    const s = await seam()
    const a = await s.identity('a', 'Notes')
    expect(await s.identity('b', 'Notes')).toBe(a)
    expect(await s.identity('c', 'Notes')).toBe(a)
    expect(a.startsWith(`webdav:${encodeURIComponent('https://dav.example.test')}/`)).toBe(true)
    expect(under(a, await s.identity('a', ''))).toBe(true)
    // 地址只有 origin、baseDir 用缺省:落在 forsion-vault,串不带尾斜杠
    expect(await s.identity('def', '')).toBe(`webdav:${encodeURIComponent('https://dav.example.test')}/forsion-vault`)
    for (const k of ['a', 'b', 'c', 'def']) { const x = await s.identity(k, 'Notes'); wellFormed(x); noSecrets(x) }
    expect(fetchTripwire).not.toHaveBeenCalled()
  })

  it('a %2F inside one segment stays one segment (it is not a folder boundary)', async () => {
    writeTargets({ a: { kind: 'webdav', section: dav({ address: 'https://dav.example.test/a%2Fb', baseDir: 'v' }) }, b: { kind: 'webdav', section: dav({ address: 'https://dav.example.test/a/b', baseDir: 'v' }) } })
    const s = await seam()
    expect(await s.identity('a', '')).not.toBe(await s.identity('b', ''))
  })
})

describe('Dropbox targets', () => {
  const dbx = (over: Record<string, unknown> = {}) => ({ appKey: 'fixture-app', refreshToken: 'fixture-refresh-token', accountId: 'dbid:fixture-account', baseDir: '/Forsion/Vault', ...over })

  it('account + app + lower-cased path; the stored account id is used with no request; the app root has no trailing slash', async () => {
    writeTargets({
      a: { kind: 'dropbox', section: dbx() },
      b: { kind: 'dropbox', section: dbx({ baseDir: 'forsion/vault/' }) },
      root: { kind: 'dropbox', section: dbx({ baseDir: '' }) },
      app2: { kind: 'dropbox', section: dbx({ appKey: 'fixture-app2', baseDir: '' }) },
      other: { kind: 'dropbox', section: dbx({ accountId: 'dbid:another', baseDir: '' }) },
    })
    const s = await seam()
    const a = await s.identity('a', 'Notes')
    expect(await s.identity('b', 'notes')).toBe(a)
    const root = await s.identity('root', '')
    expect(root).toMatch(/^dropbox:[0-9a-f]{32}:fixture-app$/)
    expect(under(a, root)).toBe(true)
    expect(under(await s.identity('app2', 'x'), root)).toBe(false)
    expect(under(await s.identity('other', 'x'), root)).toBe(false)
    for (const k of ['a', 'b', 'root', 'app2', 'other']) { const x = await s.identity(k, 'Notes'); wellFormed(x); noSecrets(x) }
    expect(fetchTripwire).not.toHaveBeenCalled()
  })

  it('no stored account id: asks Dropbox once (stubbed) and lands on the same string; a failed or hung request is unavailable', async () => {
    writeTargets({ stored: { kind: 'dropbox', section: dbx() }, asked: { kind: 'dropbox', section: dbx({ accountId: '' }) } })
    const s = await seam()
    const seen: string[] = []
    vi.stubGlobal('fetch', vi.fn(async (url: unknown) => {
      seen.push(String(url))
      if (String(url) === 'https://api.dropboxapi.com/oauth2/token') return new Response(JSON.stringify({ access_token: 'fixture-access', expires_in: 3600 }), { status: 200 })
      if (String(url) === 'https://api.dropboxapi.com/2/users/get_current_account') return new Response(JSON.stringify({ account_id: 'dbid:fixture-account' }), { status: 200 })
      throw new Error('unexpected network request')
    }))
    expect(await s.identity('asked', 'Notes')).toBe(await s.identity('stored', 'Notes'))
    expect(seen).toEqual(['https://api.dropboxapi.com/oauth2/token', 'https://api.dropboxapi.com/2/users/get_current_account'])

    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"error":"invalid_grant fixture-refresh-token"}', { status: 400 })))
    const err = await s.identity('asked', 'Notes').then(() => null, (e: Error) => e)
    expect(err?.message).toBe('target-identity-unavailable')

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const hungFetch = vi.fn((_u: unknown, init?: { signal?: AbortSignal }) => new Promise((_r, reject) => { init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))) }))
    vi.stubGlobal('fetch', hungFetch)
    let settled: string | null = null
    const hung = s.identity('asked', 'Notes').then(() => 'resolved', (e: Error) => e.message).then((m) => { settled = m; return m })
    while (!hungFetch.mock.calls.length) await new Promise((r) => setImmediate(r)) // 请求真的发出去了、挂着
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await hung).toBe('target-identity-unavailable')
    expect((hungFetch.mock.calls[0][1] as { signal?: AbortSignal }).signal?.aborted).toBe(true) // 超时也把请求掐掉

    // 掐不掉的请求(不认 signal):照样 10 秒就回 unavailable
    const deaf = vi.fn(() => new Promise(() => {}))
    vi.stubGlobal('fetch', deaf)
    settled = null
    const stuck = s.identity('asked', 'Notes').then(() => 'resolved', (e: Error) => e.message).then((m) => { settled = m; return m })
    while (!deaf.mock.calls.length) await new Promise((r) => setImmediate(r))
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await stuck).toBe('target-identity-unavailable')
  })
})

describe('the 10 seconds start at the door (Codex P2)', () => {
  it('a hand-shake that waits (touch) counts toward the same 10 seconds', async () => {
    writeTargets({ f: { kind: 'folder', section: { path: join(env.root, 'Base') } } })
    const s = await seam()
    const ipc = await import('./remotesyncIpc')
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const touch = vi.spyOn(ipc.legacyRemoteSync, 'touch').mockImplementation(() => new Promise(() => {}))
    let settled: string | null = null
    const p = s.identity('f', 'Notes').then(() => 'resolved', (e: Error) => e.message).then((m) => { settled = m; return m })
    expect(touch).toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(9_999)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(await p).toBe('target-identity-unavailable')
    touch.mockRestore()
  })
})

describe('identity errors', () => {
  it('only two codes, never an empty string', async () => {
    writeTargets({
      f: { kind: 'folder', section: { path: join(env.root, 'Base') } },
      g: { kind: 'gdrive', section: { refreshToken: 'fixture-refresh-token', baseDir: 'Vault' } },
      rel: { kind: 'folder', section: { path: 'relative/path' } },
      s3bad: { kind: 's3', section: { endpoint: 'https://s3.example.test', bucket: '', accessKeyID: 'fixture-access-key', secretAccessKey: 'fixture-secret-value' } },
    })
    const s = await seam()
    for (const id of ['nope', '__proto__', 'constructor', 'toString']) await expect(s.identity(id, '')).rejects.toThrow('target-not-found')
    for (const [id, dir] of [['g', ''], ['rel', ''], ['s3bad', ''], ['f', '../x'], ['f', '/abs'], ['f', 'a//b'], ['f', 'a\\b']] as const) {
      await expect(s.identity(id, dir)).rejects.toThrow('target-identity-unavailable')
    }
    writeFileSync(storeFile(), '{"version":1,')
    await expect(s.identity('f', '')).rejects.toThrow('target-identity-unavailable')
    expect(fetchTripwire).not.toHaveBeenCalled()
  })
})

describe('legacyRemoteSync().currentTargetId', () => {
  const original = () => ({ backend: 'webdav', intervalMin: 15, webdav: { address: 'https://dav.example.test/remote.php', username: 'fixture-user', password: 'fixture-secret-value', baseDir: 'team/vault' } })
  const cfgFile = () => join(userData(), 'remotesync.json')

  it('is the target an import now would reuse: null before import, the id after, null once the legacy config moves; never a credential', async () => {
    writeFileSync(cfgFile(), JSON.stringify(original()))
    const s = await seam()
    expect((await s.legacyRemoteSync())?.currentTargetId).toBeNull()
    const { targetId } = await s.importLegacyRemoteSync()
    const view = await s.legacyRemoteSync()
    expect(view).toMatchObject({ targetId, currentTargetId: targetId })
    noSecrets(view)
    // 用户改了旧同步的目录:上一次导入的还记着,当前位置对不上任何一条
    writeFileSync(cfgFile(), JSON.stringify({ ...original(), webdav: { ...original().webdav, baseDir: 'team/other' } }))
    expect(await s.legacyRemoteSync()).toMatchObject({ targetId, currentTargetId: null })
    // 改回来:又是那一条
    writeFileSync(cfgFile(), JSON.stringify(original()))
    expect((await s.legacyRemoteSync())?.currentTargetId).toBe(targetId)
    // 只换密码(同一个位置):还是那一条
    writeFileSync(cfgFile(), JSON.stringify({ ...original(), webdav: { ...original().webdav, password: 'fixture-secret-value-2' } }))
    expect((await s.legacyRemoteSync())?.currentTargetId).toBe(targetId)
    expect(readFileSync(storeFile(), 'utf8')).not.toContain('fixture-secret-value-2') // 不复制凭据、不写盘
  })

  it('same address and folder but another account (WebDAV user, S3 access key) is not it (Codex P1); only a new password keeps it', async () => {
    writeFileSync(cfgFile(), JSON.stringify(original()))
    const s = await seam()
    const { targetId } = await s.importLegacyRemoteSync()
    writeFileSync(cfgFile(), JSON.stringify({ ...original(), webdav: { ...original().webdav, username: 'fixture-user-2' } }))
    const view = await s.legacyRemoteSync()
    expect(view).toMatchObject({ targetId, currentTargetId: null })
    expect(JSON.stringify(view)).not.toContain('fixture-user')

    const s3cfg = (key: string) => ({ backend: 's3', intervalMin: 0, s3: { endpoint: 'https://s3.example.test', region: 'auto', bucket: 'notes', prefix: 'v/', accessKeyID: key, secretAccessKey: 'fixture-secret-value' } })
    writeFileSync(cfgFile(), JSON.stringify(s3cfg('fixture-access-key')))
    const s3id = (await s.importLegacyRemoteSync()).targetId
    expect((await s.legacyRemoteSync())?.currentTargetId).toBe(s3id)
    writeFileSync(cfgFile(), JSON.stringify(s3cfg('fixture-access-key-2')))
    const v2 = await s.legacyRemoteSync()
    expect(v2?.currentTargetId).toBeNull()
    expect(JSON.stringify(v2)).not.toContain('fixture-access-key')
  })

  it('a user-made target at the same place is not it (import would not reuse it); off / penzor are null; an unreadable store fails the whole call', async () => {
    writeTargets({ mine: { kind: 'webdav', section: original().webdav } })
    writeFileSync(cfgFile(), JSON.stringify(original()))
    const s = await seam()
    expect((await s.legacyRemoteSync())?.currentTargetId).toBeNull()
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'off', intervalMin: 0 }))
    expect((await s.legacyRemoteSync())?.currentTargetId).toBeNull()
    writeFileSync(cfgFile(), JSON.stringify({ backend: 'penzor', intervalMin: 0, penzor: { vault: 'default' } }))
    expect((await s.legacyRemoteSync())?.currentTargetId).toBeNull()
    writeFileSync(storeFile(), '{"version":1,')
    await expect(s.legacyRemoteSync()).rejects.toThrow()
  })
})
