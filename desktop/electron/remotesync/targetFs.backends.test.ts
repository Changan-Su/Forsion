/** TargetFs 各后端的细节:条件头真的发了、命中映射成 cas-conflict;复查之后、变更之前那一个往返的剩余窗口
 *  (服务器忽略条件头时客观存在,这里明确记录);folder 的 link 退路;gdrive stat 的查询次数;
 *  以及**缺省模式(旧引擎)完全不受影响**的回归钉子。全部不出网。 */
import { mkdirSync, promises as fsp, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDirRemote } from './fsLocal'
import { createDropboxRemote } from './fsDropbox'
import { createGdriveRemote, dupKey } from './fsGdrive'
import { createS3Remote } from './fsS3'
import { createWebdavRemote } from './fsWebdav'
import { openTargetFs } from './targetFs'
import { fakeDropbox } from './testkit/fakeDropbox'
import { fakeGdrive } from './testkit/fakeGdrive'
import { startFakeS3, type FakeS3 } from './testkit/fakeS3'
import { startFakeWebdav, type FakeWebdav } from './testkit/fakeWebdav'

const T = Date.parse('2026-11-10T00:00:00Z')
const buf = (s: string): Buffer => Buffer.from(s)

beforeAll(() => {
  const nowhere = path.join(os.tmpdir(), 'targetfs-no-aws-config')
  vi.stubEnv('AWS_CONFIG_FILE', nowhere)
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', nowhere)
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1')
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
})
afterAll(() => vi.unstubAllEnvs())

describe('S3:条件头', () => {
  let s3: FakeS3
  afterEach(async () => { await s3?.close() })
  const open = () =>
    openTargetFs({ kind: 's3', s3: { endpoint: s3.endpoint, region: 'us-east-1', accessKeyID: 'AK', secretAccessKey: 'SK', bucket: s3.bucket, forcePathStyle: true } }, 'v')
  const puts = () => s3.requests.filter((r) => r.method === 'PUT')

  it('honour:复查(HEAD)之后、PUT 之前被人改了 → If-Match 412 → cas-conflict,对方字节不动', async () => {
    s3 = await startFakeS3({ conditions: 'honour' })
    s3.externalPut('v/k.md', 'v1')
    const t = open()
    const [a] = await t.walk()
    s3.afterHead = (key) => { s3.afterHead = undefined; s3.externalPut(key, 'theirs') }
    await expect(t.writeFile('k.md', buf('ours'), T, undefined, a.id)).rejects.toThrow(/^cas-conflict s3 PUT k\.md: precondition failed/)
    expect(s3.objects.get('v/k.md')!.data.toString()).toBe('theirs')
    expect(puts().at(-1)!.headers['if-match']).toBe(a.id)
  })

  it('ignore:同样的插入会落盘 —— 复查之后的一个往返是公认的剩余窗口(所以 caps 不声明 CAS)', async () => {
    s3 = await startFakeS3({ conditions: 'ignore' })
    s3.externalPut('v/k.md', 'v1')
    const t = open()
    const [a] = await t.walk()
    s3.afterHead = (key) => { s3.afterHead = undefined; s3.externalPut(key, 'theirs') }
    await t.writeFile('k.md', buf('ours'), T, undefined, a.id)
    expect(s3.objects.get('v/k.md')!.data.toString()).toBe('ours')
  })

  it('honour:新建复查之后被抢先 → If-None-Match: * 412 → cas-conflict;删除复查之后被改 → If-Match 412', async () => {
    s3 = await startFakeS3({ conditions: 'honour' })
    const t = open()
    s3.afterHead = (key) => { s3.afterHead = undefined; s3.externalPut(key, 'theirs') }
    await expect(t.writeFile('n.md', buf('mine'), T, undefined, null)).rejects.toThrow(/^cas-conflict/)
    expect(puts().at(-1)!.headers['if-none-match']).toBe('*')
    expect(s3.objects.get('v/n.md')!.data.toString()).toBe('theirs')

    const id = (await t.stat('n.md'))!.id
    s3.afterHead = (key) => { s3.afterHead = undefined; s3.externalPut(key, 'theirs again') }
    await expect(t.rm('n.md', undefined, id)).rejects.toThrow(/^cas-conflict s3 rm/)
    expect(s3.requests.filter((r) => r.method === 'DELETE').at(-1)!.headers['if-match']).toBe(id)
    expect(s3.objects.get('v/n.md')!.data.toString()).toBe('theirs again')
  })

  it('无条件写走旧的 Upload 路径,不带条件头', async () => {
    s3 = await startFakeS3({ conditions: 'honour' })
    await open().writeFile('u.md', buf('x'), T)
    expect(puts().at(-1)!.headers['if-match']).toBeUndefined()
    expect(puts().at(-1)!.headers['if-none-match']).toBeUndefined()
  })

  it('缺省模式(旧引擎)不受影响:expectedId 照旧忽略,不发 HEAD、不带条件头', async () => {
    s3 = await startFakeS3({ conditions: 'honour' })
    s3.externalPut('k.md', 'theirs')
    const legacy = createS3Remote({ endpoint: s3.endpoint, region: 'us-east-1', accessKeyID: 'AK', secretAccessKey: 'SK', bucket: s3.bucket, forcePathStyle: true })
    await legacy.writeFile('k.md', buf('mine'), T, undefined, '"stale"')
    expect(s3.objects.get('k.md')!.data.toString()).toBe('mine')
    await legacy.rm('n.md', undefined, null)
    await legacy.rm('k.md', undefined, '"stale"')
    expect(s3.objects.has('k.md')).toBe(false)
    expect(s3.requests.some((r) => r.method === 'HEAD')).toBe(false)
    expect(s3.requests.some((r) => r.headers['if-match'] || r.headers['if-none-match'])).toBe(false)
  })
})

describe('WebDAV:条件头', () => {
  let dav: FakeWebdav
  afterEach(async () => { await dav?.close() })
  const open = () => openTargetFs({ kind: 'webdav', webdav: { address: dav.address, username: 'u', password: 'p' } }, 'v')
  const puts = () => dav.requests.filter((r) => r.method === 'PUT')

  it('honour:复查之后、PUT 之前被人改了 → If-Match(原样回送带引号的强 etag)412 → cas-conflict', async () => {
    dav = await startFakeWebdav({ conditions: 'honour', etags: 'strong' })
    dav.externalPut('/forsion-vault/v/k.md', 'v1')
    const t = open()
    const [a] = await t.walk()
    expect(a.id).toMatch(/^e\d+$/) // 库去掉了引号
    dav.afterStat = (p) => { dav.afterStat = undefined; dav.externalPut(p, 'theirs') }
    await expect(t.writeFile('k.md', buf('ours'), T, undefined, a.id)).rejects.toThrow(/^cas-conflict webdav PUT k\.md: precondition failed/)
    expect(puts().at(-1)!.headers['if-match']).toBe(`"${a.id}"`)
    expect(dav.files.get('/forsion-vault/v/k.md')!.data.toString()).toBe('theirs')
  })

  it('honour:新建被抢先 → If-None-Match: * 412;删除复查之后被改 → If-Match 412', async () => {
    dav = await startFakeWebdav({ conditions: 'honour', etags: 'strong' })
    const t = open()
    await t.walk()
    dav.afterStat = (p) => { dav.afterStat = undefined; dav.externalPut(p, 'theirs') }
    await expect(t.writeFile('n.md', buf('mine'), T, undefined, null)).rejects.toThrow(/^cas-conflict/)
    expect(puts().at(-1)!.headers['if-none-match']).toBe('*')
    expect(dav.files.get('/forsion-vault/v/n.md')!.data.toString()).toBe('theirs')

    const id = (await t.stat('n.md'))!.id
    dav.afterStat = (p) => { dav.afterStat = undefined; dav.externalPut(p, 'theirs again') }
    await expect(t.rm('n.md', undefined, id)).rejects.toThrow(/^cas-conflict webdav rm/)
    expect(dav.files.get('/forsion-vault/v/n.md')!.data.toString()).toBe('theirs again')
  })

  it('弱 etag / 无 etag:不发 If-Match(弱比较永远 412、mtime:size 不是 etag),只靠复查;写回的 id 与 stat、walk 一致', async () => {
    for (const etags of ['weak', 'none'] as const) {
      dav = await startFakeWebdav({ conditions: 'honour', etags, putEtag: etags === 'weak' })
      dav.externalPut('/forsion-vault/v/k.md', 'v1')
      const t = open()
      const [a] = await t.walk()
      expect(a.id).toMatch(etags === 'weak' ? /^W\/e\d+$/ : /^\d+:\d+$/)
      const w = await t.writeFile('k.md', buf('ours'), T, undefined, a.id)
      expect(puts().at(-1)!.headers['if-match']).toBeUndefined()
      expect(w.id).toBe((await t.stat('k.md'))!.id)
      expect(w.id).toBe((await t.walk())[0].id)
      await t.rm('k.md', undefined, w.id)
      expect(dav.requests.filter((r) => r.method === 'DELETE').at(-1)!.headers['if-match']).toBeUndefined()
      expect(dav.files.size).toBe(0)
      await dav.close()
    }
  })

  it('stat 指到目录 → not-a-file(不当成不存在)', async () => {
    dav = await startFakeWebdav()
    dav.externalPut('/forsion-vault/v/sub/x.md', 'x')
    await expect(open().stat('sub')).rejects.toThrow(/^not-a-file/)
  })

  it('缺省模式(旧引擎)不受影响:expectedId 照旧忽略,不带条件头', async () => {
    dav = await startFakeWebdav({ conditions: 'honour', etags: 'strong' })
    dav.externalPut('/forsion-vault/k.md', 'theirs')
    const legacy = createWebdavRemote({ address: dav.address, username: 'u', password: 'p' })
    await legacy.writeFile('k.md', buf('mine'), T, undefined, 'stale')
    expect(dav.files.get('/forsion-vault/k.md')!.data.toString()).toBe('mine')
    await legacy.rm('k.md', undefined, 'stale')
    expect(dav.files.has('/forsion-vault/k.md')).toBe(false)
    expect(dav.requests.some((r) => r.headers['if-match'] || r.headers['if-none-match'])).toBe(false)
  })
})

describe('Dropbox', () => {
  it('rm(null) 只查不删(在 = 冲突、不在 = 无事),从不发 delete_v2;cas 条件写带 strict_conflict', async () => {
    const d = fakeDropbox()
    const t = openTargetFs({ kind: 'dropbox', dropbox: { appKey: 'k', refreshToken: 'rt', baseDir: '/V', fetch: d.fetch } }, 'x')
    await t.rm('a.md', undefined, null)
    d.externalPut('/V/x/a.md', 'here')
    await expect(t.rm('a.md', undefined, null)).rejects.toThrow(/^cas-conflict/)
    expect(d.calls.some((c) => c.endpoint === '/2/files/delete_v2')).toBe(false)
    expect(d.files.has('/v/x/a.md')).toBe(true)

    await t.writeFile('b.md', buf('b'), T, undefined, null)
    await t.writeFile('b.md', buf('bb'), T)
    const ups = d.calls.filter((c) => c.endpoint === '/2/files/upload')
    expect(ups[0].arg).toMatchObject({ path: '/V/x/b.md', mode: 'add', strict_conflict: true })
    expect(ups[1].arg!.strict_conflict).toBeUndefined()
  })

  it('stat:文件夹 → not-a-file;不存在 → null', async () => {
    const d = fakeDropbox()
    d.externalPut('/V/x/sub/a.md', 'a')
    const t = openTargetFs({ kind: 'dropbox', dropbox: { appKey: 'k', refreshToken: 'rt', baseDir: 'V', fetch: d.fetch } }, 'x')
    await expect(t.stat('sub')).rejects.toThrow(/^not-a-file/)
    expect(await t.stat('none.md')).toBeNull()
    expect((await t.stat('sub/a.md'))!.id).toBe(d.files.get('/v/x/sub/a.md')!.rev)
  })

  it('缺省模式(旧引擎)不受影响:不带 strict_conflict、rm(null) 照旧直接删', async () => {
    const d = fakeDropbox()
    d.externalPut('/V/a.md', 'a')
    const legacy = createDropboxRemote({ appKey: 'k', refreshToken: 'rt', baseDir: 'V', fetch: d.fetch })
    await legacy.writeFile('b.md', buf('b'), T, undefined, null)
    expect(d.calls.find((c) => c.endpoint === '/2/files/upload')!.arg!.strict_conflict).toBeUndefined()
    await legacy.rm('a.md', undefined, null)
    expect(d.files.has('/v/a.md')).toBe(false)
  })
})

describe('Google Drive:stat', () => {
  const setup = () => {
    const g = fakeGdrive()
    const base = g.folder('Forsion-Vault', 'root')
    const v1 = g.folder('v1', g.folder('vaults', base.id).id)
    const t = openTargetFs({ kind: 'gdrive', gdrive: { clientId: 'cid', refreshToken: 'rt', fetch: g.fetch } }, 'vaults/v1')
    const queries = () => g.log.filter((l) => l.method === 'GET' && l.url.includes('/drive/v3/files?'))
    const fullListings = () => queries().filter((l) => new URL(l.url).searchParams.get('q') === 'trashed = false').length
    return { g, v1, t, queries, fullListings }
  }

  it('walk 过之后:一次按名查询;没 walk 过:从 baseDir 逐段查(3 段 + 1),都不做全量列表', async () => {
    const { g, v1, t, queries, fullListings } = setup()
    g.put({ name: 'a.md', parents: [v1.id] }, buf('a'))
    const cold = queries().length
    expect((await t.stat('a.md'))!.key).toBe('a.md')
    expect(queries().length - cold).toBe(4)
    expect(fullListings()).toBe(0)
    await t.walk()
    expect(fullListings()).toBe(1)
    const warm = queries().length
    await t.stat('a.md')
    expect(queries().length - warm).toBe(1)
    expect(fullListings()).toBe(1)
  })

  it('walk 之后别人新建的 key:stat 找得到,回写清单,随后带这个 id 的条件写不误报冲突', async () => {
    const { g, v1, t } = setup()
    await t.walk()
    g.put({ name: 'late.md', parents: [v1.id] }, buf('theirs'))
    const ent = (await t.stat('late.md'))!
    const w = await t.writeFile('late.md', buf('mine'), T, undefined, ent.id)
    expect(w.id).toBe((await t.stat('late.md'))!.id)
    expect(g.live().filter((f) => f.name === 'late.md')).toHaveLength(1)
  })

  it('同名文件夹与文件并存 / 冲突派生名:走一次私有全量列表,结论与 walk 一致', async () => {
    const { g, v1, t, fullListings } = setup()
    const folder = g.folder('x.md', v1.id)
    g.put({ name: 'inside.md', parents: [folder.id] }, buf('i')) // 文件夹非空 → 同名文件让位成派生名
    const file = g.put({ name: 'x.md', parents: [v1.id] }, buf('f'))
    const list = await t.walk()
    const alias = dupKey('x.md', file.id)
    expect(list.map((e) => e.key).sort()).toEqual([alias, 'x.md/inside.md'].sort())
    const before = fullListings()
    expect(await t.stat('x.md')).toBeNull()
    expect((await t.stat(alias))!.id).toBe(list.find((e) => e.key === alias)!.id)
    expect(fullListings() - before).toBe(2) // 两次都走了私有全量列表
  })

  it('cas 的 rm(null) 现查;缺省模式照旧只看清单', async () => {
    const { g, v1, t } = setup()
    await t.walk()
    g.put({ name: 'late.md', parents: [v1.id] }, buf('theirs'))
    await expect(t.rm('late.md', undefined, null)).rejects.toThrow(/^cas-conflict/)
    const legacy = createGdriveRemote({ clientId: 'cid', refreshToken: 'rt', baseDir: 'Forsion-Vault/vaults/v1', fetch: g.fetch })
    await legacy.walk()
    g.put({ name: 'later.md', parents: [v1.id] }, buf('theirs'))
    await legacy.rm('later.md', undefined, null) // 旧行为:清单里没有就当已删
    expect(g.live().some((f) => f.name === 'later.md')).toBe(true)
  })
})

describe('folder', () => {
  let root: string
  afterEach(async () => {
    vi.restoreAllMocks()
    await fsp.rm(root, { recursive: true, force: true })
  })
  const leftovers = async (dir: string): Promise<string[]> => (await fsp.readdir(dir)).filter((n) => n.startsWith('.rsync-tmp-'))

  it.each(['EPERM', 'EISDIR'])('link 不被支持(%s:exFAT U 盘 / Windows 上 libuv 的译法)→ 退回 open wx:照样独占新建,已存在 = cas-conflict;不留临时文件', async (code) => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-link-'))
    const spy = vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('nope'), { code }))
    const t = openTargetFs({ kind: 'folder', folder: { path: root } }, '')
    const e = await t.writeFile('a.md', buf('mine'), T, undefined, null)
    expect(spy).toHaveBeenCalled()
    expect(e.id).toBe((await t.stat('a.md'))!.id)
    expect(e.mtimeMs).toBe(T)
    await expect(t.writeFile('a.md', buf('again'), T, undefined, null)).rejects.toThrow(/^cas-conflict/)
    expect(await fsp.readFile(path.join(root, 'a.md'), 'utf8')).toBe('mine')
    expect(await leftovers(root)).toEqual([])
  })

  it('link 路径:冲突 / 覆盖之后都不留临时文件,目标原样', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-link-'))
    const t = openTargetFs({ kind: 'folder', folder: { path: root } }, '')
    const e = await t.writeFile('a.md', buf('mine'), T, undefined, null)
    await expect(t.writeFile('a.md', buf('x'), T, undefined, null)).rejects.toThrow(/^cas-conflict folder PUT a\.md: exists/)
    await t.writeFile('a.md', buf('mine 2'), T + 1000, undefined, e.id)
    expect(await fsp.readFile(path.join(root, 'a.md'), 'utf8')).toBe('mine 2')
    expect(await leftovers(root)).toEqual([])
  })

  it('子目录不在 → target-dir-missing(不当空);配置的根本身不在 → 照旧抛(U 盘没插不能当成空)', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-walk-'))
    await expect(openTargetFs({ kind: 'folder', folder: { path: root } }, 'not/yet').walk()).rejects.toThrow('target-dir-missing')
    mkdirSync(path.join(root, 'not', 'yet'), { recursive: true })
    expect(await openTargetFs({ kind: 'folder', folder: { path: root } }, 'not/yet').walk()).toEqual([])
    await expect(openTargetFs({ kind: 'folder', folder: { path: path.join(root, 'unplugged') } }, 'v').walk()).rejects.toThrow(/ENOENT/)
  })

  // Windows 建符号链接要特权,只在 POSIX 上跑
  it.skipIf(process.platform === 'win32')('stat:目录 / 符号链接 → not-a-file(walk 不列它们,也不穿过链接去写)', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-stat-'))
    mkdirSync(path.join(root, 'd'))
    await fsp.writeFile(path.join(root, 'real.md'), 'r')
    symlinkSync(path.join(root, 'real.md'), path.join(root, 'link.md'))
    const t = openTargetFs({ kind: 'folder', folder: { path: root } }, '')
    await expect(t.stat('d')).rejects.toThrow(/^not-a-file/)
    await expect(t.stat('link.md')).rejects.toThrow(/^not-a-file/)
    expect((await t.walk()).map((e) => e.key)).toEqual(['real.md'])
  })

  it('缺省模式(旧引擎 / engine.test 的假远端)不受影响:expectedId 照旧忽略', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-legacy-'))
    await fsp.writeFile(path.join(root, 'k.md'), 'theirs')
    const legacy = createDirRemote(root)
    await legacy.writeFile('k.md', buf('mine'), T, undefined, '1:1')
    expect(await fsp.readFile(path.join(root, 'k.md'), 'utf8')).toBe('mine')
    await legacy.writeFile('k.md', buf('mine 2'), T, undefined, null)
    expect(await fsp.readFile(path.join(root, 'k.md'), 'utf8')).toBe('mine 2')
    await legacy.rm('k.md', undefined, null)
    expect(await legacy.stat('k.md')).toBeNull()
  })
})
