/** TargetFs 各后端的细节:条件头真的发了、命中映射成 cas-conflict;复查之后、变更之前那一个往返的剩余窗口
 *  (服务器忽略条件头时客观存在,这里明确记录);folder 的 link 退路;
 *  以及**缺省模式(旧引擎)完全不受影响**的回归钉子。全部不出网。 */
import { mkdirSync, promises as fsp, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createDirRemote } from './fsLocal'
import { createDropboxRemote } from './fsDropbox'
import { createS3Remote } from './fsS3'
import { createWebdavRemote } from './fsWebdav'
import { openTargetFs } from './targetFs'
import { fakeDropbox } from './testkit/fakeDropbox'
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
    // 复查 = HEAD 404 + ListObjectsV2 确认(HEAD 404 分不清「key 不在」和「桶不在」):在确认之后插入
    s3.afterList = (prefix) => { s3.afterList = undefined; s3.externalPut(prefix, 'theirs') }
    await expect(t.writeFile('n.md', buf('mine'), T, undefined, null)).rejects.toThrow(/^cas-conflict/)
    expect(puts().at(-1)!.headers['if-none-match']).toBe('*')
    expect(s3.objects.get('v/n.md')!.data.toString()).toBe('theirs')

    const id = (await t.stat('n.md'))!.id
    s3.afterHead = (key) => { s3.afterHead = undefined; s3.externalPut(key, 'theirs again') }
    await expect(t.rm('n.md', undefined, id)).rejects.toThrow(/^cas-conflict s3 rm/)
    expect(s3.requests.filter((r) => r.method === 'DELETE').at(-1)!.headers['if-match']).toBe(id)
    expect(s3.objects.get('v/n.md')!.data.toString()).toBe('theirs again')
  })

  it('HEAD 404 不直接当不存在:桶不在时 HEAD 也是无响应体的 404 → stat / rm(null) 必须抛', async () => {
    s3 = await startFakeS3({ conditions: 'honour' })
    const t = openTargetFs({ kind: 's3', s3: { endpoint: s3.endpoint, region: 'us-east-1', accessKeyID: 'AK', secretAccessKey: 'SK', bucket: 'no-such-bucket', forcePathStyle: true } }, 'v')
    await expect(t.stat('k.md')).rejects.toThrow()
    await expect(t.rm('k.md', undefined, null)).rejects.toThrow()
  })

  it('PUT 不回 ETag(部分 S3 兼容服务):拿不到这次提交的版本 → cas-conflict,字节照写、交引擎重判(弱身份分不出同秒同大小的另一份)', async () => {
    s3 = await startFakeS3({ conditions: 'honour', putEtag: false })
    s3.externalPut('v/k.md', 'v1')
    const t = open()
    const [a] = await t.walk()
    await expect(t.writeFile('n.md', buf('one'), T, undefined, null)).rejects.toThrow(/^cas-conflict s3 PUT n\.md: no commit version/)
    await expect(t.writeFile('k.md', buf('ours'), T, undefined, a.id)).rejects.toThrow(/^cas-conflict s3 PUT k\.md: no commit version/)
    expect(s3.objects.get('v/k.md')!.data.toString()).toBe('ours')
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
    // stat:HEAD 404 照旧直接 null,不做 cas 的 ListObjectsV2 确认
    expect(await legacy.stat('none.md')).toBeNull()
    expect(s3.requests.some((r) => r.method === 'GET' && r.key === '')).toBe(false)
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

  it('PUT 不回 ETag:写后 stat → 下载 → stat 核对;PUT 与核对之间别人写了 → cas-conflict(不把别人的 etag 当成这次写的)', async () => {
    dav = await startFakeWebdav({ conditions: 'honour', etags: 'strong', putEtag: false })
    dav.externalPut('/forsion-vault/v/k.md', 'v1')
    const t = open()
    const [a] = await t.walk()
    dav.afterPut = (p) => { dav.afterPut = undefined; dav.externalPut(p, 'theirs') }
    await expect(t.writeFile('k.md', buf('ours'), T, undefined, a.id)).rejects.toThrow(/^cas-conflict webdav PUT k\.md: .*changed after write/)
    expect(dav.files.get('/forsion-vault/v/k.md')!.data.toString()).toBe('theirs')
  })

  it('207 里第一组 propstat 是 404、第二组 200(资源在):stat 抛,绝不当不存在;独占新建不覆盖', async () => {
    dav = await startFakeWebdav({ conditions: 'ignore', etags: 'strong' })
    dav.externalPut('/forsion-vault/v/k.md', 'theirs')
    const t = open()
    await t.walk()
    dav.propstat404First = true
    await expect(t.stat('k.md')).rejects.toThrow()
    await expect(t.writeFile('k.md', buf('mine'), T, undefined, null)).rejects.toThrow()
    expect(dav.files.get('/forsion-vault/v/k.md')!.data.toString()).toBe('theirs')
  })

  it('资源真不在:207 里资源级 404(只有 status 没有 propstat)→ null,独占新建照常', async () => {
    dav = await startFakeWebdav({ conditions: 'honour', etags: 'strong' })
    const t = open()
    await t.walk() // 先建好 baseDir(库自己的 exists() 不认 207 里的资源级 404,那是 init 的事,不在这里测)
    dav.missingAs207 = true
    expect(await t.stat('n.md')).toBeNull()
    const e = await t.writeFile('n.md', buf('new'), T, undefined, null)
    expect((await t.stat('n.md'))!.id).toBe(e.id)
  })

  it('digest:PROPFIND 通过而 PUT / DELETE 最终 401(库对 digest 的 401 不抛)→ 条件写删必须报错,不能当成功', async () => {
    dav = await startFakeWebdav({ conditions: 'honour', etags: 'strong' })
    dav.externalPut('/forsion-vault/v/k.md', 'v1')
    const t = openTargetFs({ kind: 'webdav', webdav: { address: dav.address, username: 'u', password: 'p', authType: 'digest' } }, 'v')
    const [a] = await t.walk()
    dav.digest401.add('PUT')
    dav.digest401.add('DELETE')
    await expect(t.writeFile('k.md', buf('ours'), T, undefined, a.id)).rejects.toThrow(/401/)
    await expect(t.writeFile('n.md', buf('new'), T, undefined, null)).rejects.toThrow(/401/)
    await expect(t.rm('k.md', undefined, a.id)).rejects.toThrow(/401/)
    expect(dav.files.get('/forsion-vault/v/k.md')!.data.toString()).toBe('v1')
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
  // 后端走全局 fetch(同 fsDropbox.test.ts):每条用例换成假 Dropbox,跑完还原,绝不出网
  afterEach(() => { vi.unstubAllGlobals() })

  it('rm(null) 只查不删(在 = 冲突、不在 = 无事),从不发 delete_v2;cas 条件写带 strict_conflict', async () => {
    const d = fakeDropbox()
    vi.stubGlobal('fetch', d.fetch)
    const t = openTargetFs({ kind: 'dropbox', dropbox: { appKey: 'k', refreshToken: 'rt', baseDir: '/V' } }, 'x')
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

  it('cas:空字符串 expectedId 不是「无条件」—— rm / writeFile 都在发任何请求之前 cas-conflict', async () => {
    const d = fakeDropbox()
    d.externalPut('/V/x/a.md', 'a')
    vi.stubGlobal('fetch', d.fetch)
    const t = openTargetFs({ kind: 'dropbox', dropbox: { appKey: 'k', refreshToken: 'rt', baseDir: 'V' } }, 'x')
    await expect(t.rm('a.md', undefined, '')).rejects.toThrow(/^cas-conflict/)
    await expect(t.writeFile('a.md', buf('b'), T, undefined, '')).rejects.toThrow(/^cas-conflict/)
    expect(d.files.get('/v/x/a.md')!.data.toString()).toBe('a')
    expect(d.calls).toEqual([])
  })

  it('stat:文件夹 → not-a-file;不存在 → null', async () => {
    const d = fakeDropbox()
    d.externalPut('/V/x/sub/a.md', 'a')
    vi.stubGlobal('fetch', d.fetch)
    const t = openTargetFs({ kind: 'dropbox', dropbox: { appKey: 'k', refreshToken: 'rt', baseDir: 'V' } }, 'x')
    await expect(t.stat('sub')).rejects.toThrow(/^not-a-file/)
    expect(await t.stat('none.md')).toBeNull()
    expect((await t.stat('sub/a.md'))!.id).toBe(d.files.get('/v/x/sub/a.md')!.rev)
  })

  it('缺省模式(旧引擎)不受影响:不带 strict_conflict、rm(null) 照旧直接删', async () => {
    const d = fakeDropbox()
    d.externalPut('/V/a.md', 'a')
    vi.stubGlobal('fetch', d.fetch)
    const legacy = createDropboxRemote({ appKey: 'k', refreshToken: 'rt', baseDir: 'V' })
    await legacy.writeFile('b.md', buf('b'), T, undefined, null)
    expect(d.calls.find((c) => c.endpoint === '/2/files/upload')!.arg!.strict_conflict).toBeUndefined()
    await legacy.rm('a.md', undefined, null)
    expect(d.files.has('/v/a.md')).toBe(false)
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

  it('mkdir:只把这一层子目录建出来;配置的根不在就抛、什么都不建;子目录是指向外面的链接 → path-escapes-target', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-mkdir-'))
    const t = openTargetFs({ kind: 'folder', folder: { path: root } }, 'new/dir')
    await expect(t.walk()).rejects.toThrow('target-dir-missing')
    await t.mkdir!()
    expect(await t.walk()).toEqual([])
    await t.mkdir!() // 幂等
    const unplugged = path.join(root, 'unplugged')
    await expect(openTargetFs({ kind: 'folder', folder: { path: unplugged } }, 'v').mkdir!()).rejects.toThrow(/ENOENT/)
    await expect(fsp.stat(unplugged)).rejects.toThrow(/ENOENT/)
    await openTargetFs({ kind: 'folder', folder: { path: root } }, '').mkdir!() // 根本身:在就行
    if (process.platform !== 'win32') {
      const outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-outside-'))
      symlinkSync(outside, path.join(root, 'out'))
      await expect(openTargetFs({ kind: 'folder', folder: { path: root } }, 'out/x').mkdir!()).rejects.toThrow(/path-escapes-target/)
      expect(await fsp.readdir(outside)).toEqual([]) // 外面一个目录都没建
      await fsp.rm(outside, { recursive: true, force: true })
    }
    expect(openTargetFs({ kind: 's3', s3: { endpoint: 'http://127.0.0.1:9', region: 'us-east-1', accessKeyID: 'AK', secretAccessKey: 'SK', bucket: 'b' } }, 'v').mkdir).toBeUndefined()
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

describe('folder:CAS 写删纪律', () => {
  let root: string
  let outside: string | undefined
  afterEach(async () => {
    vi.restoreAllMocks()
    await fsp.rm(root, { recursive: true, force: true })
    if (outside) await fsp.rm(outside, { recursive: true, force: true })
    outside = undefined
  })
  const realOpen = fsp.open
  type Handle = Awaited<ReturnType<typeof fsp.open>>
  /** 包一层 fs.open:路径命中 pick 的句柄交给 patch 改写方法(把外部进程的写 / 中止插到那一步)。 */
  const hookOpen = (pick: (p: string) => boolean, patch: (h: Handle, p: string) => void): void => {
    vi.spyOn(fsp, 'open').mockImplementation((async (...args: Parameters<typeof fsp.open>) => {
      const h = await realOpen(...args)
      if (pick(String(args[0]))) patch(h, String(args[0]))
      return h
    }) as typeof fsp.open)
  }
  const read = (p: string): Promise<string | null> => fsp.readFile(p, 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)))
  const leftovers = async (dir: string): Promise<string[]> => (await fsp.readdir(dir)).filter((n) => n.startsWith('.rsync-tmp-'))
  const open = () => openTargetFs({ kind: 'folder', folder: { path: root } }, '')
  /** 根下的 assets 是指向目标外目录的符号链接,目标外放着 x.md。 */
  const escapeSetup = async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-escape-'))
    outside = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-outside-'))
    await fsp.writeFile(path.join(outside, 'x.md'), 'outside')
    symlinkSync(outside, path.join(root, 'assets'))
    const st = await fsp.stat(path.join(outside, 'x.md'))
    return { t: open(), id: `${Math.floor(st.mtimeMs)}:${st.size}`, out: outside }
  }

  // Windows 建符号链接要特权,只在 POSIX 上跑
  it.skipIf(process.platform === 'win32')('父目录是指向目标外的符号链接:stat 抛(不当文件、也不当不存在)', async () => {
    const { t } = await escapeSetup()
    await expect(t.stat('assets/x.md')).rejects.toThrow()
    await expect(t.stat('assets/none.md')).rejects.toThrow()
  })

  it.skipIf(process.platform === 'win32')('父目录是指向目标外的符号链接:独占新建拒绝,目标外不多出文件', async () => {
    const { t, out } = await escapeSetup()
    await expect(t.writeFile('assets/new.md', buf('mine'), T, undefined, null)).rejects.toThrow()
    expect((await fsp.readdir(out)).sort()).toEqual(['x.md'])
  })

  it.skipIf(process.platform === 'win32')('父目录是指向目标外的符号链接:带对的身份条件删拒绝,目标外的文件不动', async () => {
    const { t, id, out } = await escapeSetup()
    await expect(t.rm('assets/x.md', undefined, id)).rejects.toThrow()
    expect(await read(path.join(out, 'x.md'))).toBe('outside')
  })

  it.skipIf(process.platform === 'win32')('父目录是指向目标外的符号链接:带对的身份条件写拒绝,目标外的文件不动', async () => {
    const { t, id, out } = await escapeSetup()
    await expect(t.writeFile('assets/x.md', buf('mine'), T, undefined, id)).rejects.toThrow()
    expect(await read(path.join(out, 'x.md'))).toBe('outside')
    expect((await fsp.readdir(out)).sort()).toEqual(['x.md'])
  })

  it('条件写:身份在临时文件刷盘之后、rename 之前复查 —— 刷盘期间外部进程存了新版本 → cas-conflict,不覆盖、不留临时文件', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-order-'))
    const t = open()
    const file = path.join(root, 'a.md')
    const e = await t.writeFile('a.md', buf('v1'), T, undefined, null)
    hookOpen((p) => p.includes('.rsync-tmp-'), (h) => {
      const sync = h.sync.bind(h)
      h.sync = async () => {
        await sync()
        await fsp.writeFile(file, 'theirs, newer')
        await fsp.utimes(file, new Date(T + 5000), new Date(T + 5000))
      }
    })
    await expect(t.writeFile('a.md', buf('ours'), T + 1000, undefined, e.id)).rejects.toThrow(/^cas-conflict/)
    expect(await read(file)).toBe('theirs, newer')
    expect(await leftovers(root)).toEqual([])
  })

  it('条件写:刷盘期间请求被中止 → 不落盘、不留临时文件', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-abort-'))
    const t = open()
    const file = path.join(root, 'a.md')
    const e = await t.writeFile('a.md', buf('v1'), T, undefined, null)
    const ac = new AbortController()
    hookOpen((p) => p.includes('.rsync-tmp-'), (h) => {
      const sync = h.sync.bind(h)
      h.sync = async () => {
        await sync()
        ac.abort()
      }
    })
    await expect(t.writeFile('a.md', buf('ours'), T + 1000, ac.signal, e.id)).rejects.toThrow()
    expect(await read(file)).toBe('v1')
    expect(await leftovers(root)).toEqual([])
  })

  it('条件覆盖:新旧内容同 mtime 同大小 → 身份照样变;拿旧身份的删除 cas-conflict,新内容不被删', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-sameid-'))
    const t = open()
    const e1 = await t.writeFile('a.md', buf('AAA'), T, undefined, null)
    const e2 = await t.writeFile('a.md', buf('BBB'), T, undefined, e1.id)
    expect(e2.id).not.toBe(e1.id)
    expect((await t.stat('a.md'))!.id).toBe(e2.id)
    expect((await t.walk()).find((e) => e.key === 'a.md')!.id).toBe(e2.id)
    await expect(t.rm('a.md', undefined, e1.id)).rejects.toThrow(/^cas-conflict/)
    expect(await read(path.join(root, 'a.md'))).toBe('BBB')
  })

  // Windows 上不能把文件 rename 到一个开着句柄的路径上,只在 POSIX 上跑
  it.skipIf(process.platform === 'win32')('link 不可用退回 open wx:写内容失败时只删自己建的那个 inode —— 路径已被别的进程换掉就不动', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-fallback-'))
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EPERM' }))
    const t = open()
    const file = path.join(root, 'a.md')
    hookOpen((p) => p === file, (h) => {
      h.writeFile = async () => {
        const other = path.join(root, 'other.part')
        await fsp.writeFile(other, 'theirs')
        await fsp.rename(other, file)
        throw Object.assign(new Error('disk gone'), { code: 'EIO' })
      }
    })
    await expect(t.writeFile('a.md', buf('mine'), T, undefined, null)).rejects.toThrow(/disk gone/)
    expect(await read(file)).toBe('theirs')
    expect(await leftovers(root)).toEqual([])
  })

  it('link 不可用退回 open wx:写内容失败、路径还是自己建的 → 半截文件删掉', async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-fallback-'))
    vi.spyOn(fsp, 'link').mockRejectedValue(Object.assign(new Error('nope'), { code: 'EPERM' }))
    const t = open()
    const file = path.join(root, 'a.md')
    hookOpen((p) => p === file, (h) => {
      h.writeFile = async () => {
        throw Object.assign(new Error('disk gone'), { code: 'EIO' })
      }
    })
    await expect(t.writeFile('a.md', buf('mine'), T, undefined, null)).rejects.toThrow(/disk gone/)
    expect(await read(file)).toBeNull()
    expect(await leftovers(root)).toEqual([])
  })
})
