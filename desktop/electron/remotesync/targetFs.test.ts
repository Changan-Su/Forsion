/** TargetFs(targetFs.ts)对五个后端的同一套 CAS 场景:walk 之后别人改了 / 抢先建了 → 条件写删 cas-conflict 且对方字节不动;
 *  正常路径的 id 与 stat / walk 一致;rm(null) 只查不删;stat 不存在 = null、出错必抛。
 *  folder = 真临时目录;S3 / WebDAV = 进程内假服务(按条件头 honour / ignore 两种跑,ignore 证明复查兜得住);
 *  Dropbox / Google Drive = fetch 桩。全部不出网。后端特有的条件头 / 回退细节见 targetFs.backends.test.ts。 */
import { mkdirSync, promises as fsp } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { openTargetFs, parseTargetDir, TARGET_CAPS, type TargetFs, type TargetKind, type TargetSpec } from './targetFs'
import { fakeDropbox } from './testkit/fakeDropbox'
import { fakeGdrive } from './testkit/fakeGdrive'
import { startFakeS3 } from './testkit/fakeS3'
import { startFakeWebdav } from './testkit/fakeWebdav'

const DIR = 'vaults/v1'
const T1 = Date.parse('2026-11-10T00:00:00Z')
const T2 = T1 + 60_000

interface Bench {
  kind: TargetKind
  open(): TargetFs
  /** 别的写入者:建 / 改(换内容)/ 删顶层 key。 */
  put(key: string, data: string): Promise<void>
  del(key: string): Promise<void>
  /** 远端此刻的字节(不存在 = null)。 */
  read(key: string): Promise<string | null>
  /** 让某个 key 的 stat 出错,返回那个 key。 */
  breakStat(): string
  done(): Promise<void>
}

async function folderBench(): Promise<Bench> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'targetfs-folder-'))
  await fsp.mkdir(path.join(root, ...DIR.split('/')), { recursive: true }) // 子目录由建绑定的一方先建(契约 H-2 第 6 条)
  let tick = Date.parse('2026-12-01T00:00:00Z')
  const abs = (key: string): string => path.join(root, ...DIR.split('/'), key)
  return {
    kind: 'folder',
    open: () => openTargetFs({ kind: 'folder', folder: { path: root } }, DIR),
    async put(key, data) {
      await fsp.mkdir(path.dirname(abs(key)), { recursive: true })
      await fsp.writeFile(abs(key), data)
      const t = new Date((tick += 10_000)) // 身份 = mtime:size,别的写入者的 mtime 一定不同
      await fsp.utimes(abs(key), t, t)
    },
    async del(key) { await fsp.rm(abs(key), { force: true }) },
    async read(key) { return fsp.readFile(abs(key), 'utf8').catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e))) },
    breakStat() {
      // 父目录在而名字超长 → ENAMETOOLONG:不是 ENOENT,必须抛(父目录不在时 macOS 先报 ENOENT)。
      // Windows 上长名的报法不一,改用 Node 各平台都拒的 NUL
      mkdirSync(path.join(root, ...DIR.split('/')), { recursive: true })
      return process.platform === 'win32' ? 'bad\0name.md' : 'x'.repeat(300)
    },
    async done() { await fsp.rm(root, { recursive: true, force: true }) },
  }
}

async function s3Bench(conditions: 'honour' | 'ignore', putEtag = true): Promise<Bench> {
  const fake = await startFakeS3({ conditions, putEtag })
  const full = (key: string): string => `pre/${DIR}/${key}`
  const spec: TargetSpec = {
    kind: 's3',
    s3: { endpoint: fake.endpoint, region: 'us-east-1', accessKeyID: 'AK', secretAccessKey: 'SK', bucket: fake.bucket, prefix: 'pre', forcePathStyle: true },
  }
  return {
    kind: 's3',
    open: () => openTargetFs(spec, DIR),
    async put(key, data) { fake.externalPut(full(key), data) },
    async del(key) { fake.externalDelete(full(key)) },
    async read(key) { return fake.objects.get(full(key))?.data.toString() ?? null },
    breakStat() {
      fake.failHead.add(full('boom.md'))
      return 'boom.md'
    },
    done: () => fake.close(),
  }
}

async function webdavBench(o: { conditions: 'honour' | 'ignore'; etags: 'strong' | 'weak' | 'none'; putEtag: boolean }): Promise<Bench> {
  const fake = await startFakeWebdav(o)
  const full = (key: string): string => `/team/base/${DIR}/${key}`
  const spec: TargetSpec = { kind: 'webdav', webdav: { address: fake.address, username: 'u', password: 'p', baseDir: '/team/base/' } }
  return {
    kind: 'webdav',
    open: () => openTargetFs(spec, DIR),
    async put(key, data) { fake.externalPut(full(key), data) },
    async del(key) { fake.externalDelete(full(key)) },
    async read(key) { return fake.files.get(full(key))?.data.toString() ?? null },
    breakStat() {
      fake.failStat.add(full('boom.md'))
      return 'boom.md'
    },
    done: () => fake.close(),
  }
}

async function dropboxBench(revMismatch: 'conflict' | 'not_found'): Promise<Bench> {
  const fake = fakeDropbox()
  fake.revMismatch = revMismatch
  const full = (key: string): string => `/Vault/${DIR}/${key}`
  const spec: TargetSpec = { kind: 'dropbox', dropbox: { appKey: 'k', refreshToken: 'rt', baseDir: 'Vault', fetch: fake.fetch } }
  return {
    kind: 'dropbox',
    open: () => openTargetFs(spec, DIR),
    async put(key, data) { fake.externalPut(fake.files.get(full(key).toLowerCase())?.path_display ?? full(key), data) },
    async del(key) { fake.externalDelete(full(key)) },
    async read(key) { return fake.files.get(full(key).toLowerCase())?.data.toString() ?? null },
    breakStat() {
      fake.failMetadata = true
      return 'boom.md'
    },
    async done() {},
  }
}

async function gdriveBench(): Promise<Bench> {
  const fake = fakeGdrive()
  const base = fake.folder('Forsion-Vault', 'root')
  const v1 = fake.folder('v1', fake.folder('vaults', base.id).id)
  const spec: TargetSpec = { kind: 'gdrive', gdrive: { clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', fetch: fake.fetch } }
  const find = (key: string) => fake.live().find((f) => f.name === key && f.parents?.includes(v1.id))
  return {
    kind: 'gdrive',
    open: () => openTargetFs(spec, DIR),
    async put(key, data) {
      const f = find(key)
      if (f) fake.externalWrite(f, data)
      else fake.put({ name: key, parents: [v1.id] }, Buffer.from(data))
    },
    async del(key) {
      const f = find(key)
      if (f) f.trashed = true
    },
    async read(key) { return find(key)?.content?.toString() ?? null },
    breakStat() {
      fake.failNamedQuery = true
      return 'boom.md'
    },
    async done() {},
  }
}

const BENCHES: Array<[string, () => Promise<Bench>]> = [
  ['folder', folderBench],
  ['s3 (honours conditions)', () => s3Bench('honour')],
  ['s3 (ignores conditions)', () => s3Bench('ignore')],
  ['webdav (honours, strong etag)', () => webdavBench({ conditions: 'honour', etags: 'strong', putEtag: true })],
  ['webdav (ignores, strong etag)', () => webdavBench({ conditions: 'ignore', etags: 'strong', putEtag: true })],
  ['webdav (honours, strong etag, no ETag on PUT)', () => webdavBench({ conditions: 'honour', etags: 'strong', putEtag: false })],
  ['webdav (ignores, weak etag)', () => webdavBench({ conditions: 'ignore', etags: 'weak', putEtag: true })],
  ['webdav (honours, no etag → mtime:size)', () => webdavBench({ conditions: 'honour', etags: 'none', putEtag: false })],
  ['dropbox (rev mismatch → conflict)', () => dropboxBench('conflict')],
  ['dropbox (rev mismatch → not_found)', () => dropboxBench('not_found')],
  ['gdrive', gdriveBench],
]

beforeAll(() => {
  // S3 SDK 别读本机 ~/.aws、别在 500 上退避重试(stat 出错用例要快)
  const nowhere = path.join(os.tmpdir(), 'targetfs-no-aws-config')
  vi.stubEnv('AWS_CONFIG_FILE', nowhere)
  vi.stubEnv('AWS_SHARED_CREDENTIALS_FILE', nowhere)
  vi.stubEnv('AWS_MAX_ATTEMPTS', '1')
  vi.stubEnv('AWS_EC2_METADATA_DISABLED', 'true')
})
afterAll(() => vi.unstubAllEnvs())

const idOf = async (t: TargetFs, key: string): Promise<string | undefined> => (await t.walk()).find((e) => e.key === key)?.id

describe.each(BENCHES)('TargetFs CAS — %s', (_name, make) => {
  let b: Bench
  afterEach(async () => { await b?.done() })

  it('caps 与对外契约一致', async () => {
    b = await make()
    expect(b.open().caps).toEqual(TARGET_CAPS[b.kind])
  })

  it('walk 之后别人改了 k:条件写 / 条件删都 cas-conflict,远端仍是别人的字节', async () => {
    b = await make()
    await b.put('k.md', 'v1')
    const t = b.open()
    const a = await idOf(t, 'k.md')
    expect(a).toBeTruthy()
    await b.put('k.md', 'theirs, longer')
    await expect(t.writeFile('k.md', Buffer.from('ours'), T1, undefined, a!)).rejects.toThrow(/^cas-conflict/)
    expect(await b.read('k.md')).toBe('theirs, longer')
    await expect(t.rm('k.md', undefined, a!)).rejects.toThrow(/^cas-conflict/)
    expect(await b.read('k.md')).toBe('theirs, longer')
    const cur = await t.stat('k.md')
    expect(cur?.id).not.toBe(a)
    expect(cur?.id).toBe(await idOf(t, 'k.md'))
  })

  it('walk 之后别人抢先建了同名:create(null) cas-conflict,对方字节不动', async () => {
    b = await make()
    const t = b.open()
    await t.walk()
    await b.put('n.md', 'theirs')
    await expect(t.writeFile('n.md', Buffer.from('mine'), T1, undefined, null)).rejects.toThrow(/^cas-conflict/)
    expect(await b.read('n.md')).toBe('theirs')
  })

  it('正常路径:create / 带对的 id 覆盖 / 带对的 id 删;返回的 id 与 stat、walk 一致;删两遍幂等', async () => {
    b = await make()
    const t = b.open()
    await t.walk()
    expect(await t.stat('c.md')).toBeNull()
    const e1 = await t.writeFile('c.md', Buffer.from('one'), T1, undefined, null)
    expect((await t.stat('c.md'))?.id).toBe(e1.id)
    expect(await idOf(t, 'c.md')).toBe(e1.id)
    const e2 = await t.writeFile('c.md', Buffer.from('two, longer'), T2, undefined, e1.id)
    expect(e2.id).not.toBe(e1.id)
    expect((await t.stat('c.md'))?.id).toBe(e2.id)
    expect(await idOf(t, 'c.md')).toBe(e2.id)
    expect((await t.readFile('c.md')).toString()).toBe('two, longer')
    expect(await b.read('c.md')).toBe('two, longer')
    // 拿旧 id 再写:冲突,不覆盖
    await expect(t.writeFile('c.md', Buffer.from('stale'), T2, undefined, e1.id)).rejects.toThrow(/^cas-conflict/)
    await t.rm('c.md', undefined, e2.id)
    expect(await b.read('c.md')).toBeNull()
    expect(await t.stat('c.md')).toBeNull()
    await t.rm('c.md', undefined, e2.id) // 已不在 = 幂等
    await t.rm('c.md', undefined, null) // 期望不存在且确实不存在 = 无事
    // 期望某版本而远端已不在:写 = 冲突(不静默重建)
    await expect(t.writeFile('c.md', Buffer.from('again'), T2, undefined, e2.id)).rejects.toThrow(/^cas-conflict/)
    expect(await b.read('c.md')).toBeNull()
    // 新建进新的子目录
    const e3 = await t.writeFile('sub/dir/d.md', Buffer.from('deep'), T1, undefined, null)
    expect((await t.stat('sub/dir/d.md'))?.id).toBe(e3.id)
    expect(await idOf(t, 'sub/dir/d.md')).toBe(e3.id)
  })

  it('rm(null) 而远端有 → cas-conflict,文件还在', async () => {
    b = await make()
    await b.put('p.md', 'present')
    const t = b.open()
    await t.walk()
    await expect(t.rm('p.md', undefined, null)).rejects.toThrow(/^cas-conflict/)
    expect(await b.read('p.md')).toBe('present')
  })

  it('expectedId 省略 = 无条件写删(同旧行为)', async () => {
    b = await make()
    await b.put('u.md', 'v1')
    const t = b.open()
    await t.walk()
    await b.put('u.md', 'theirs')
    await t.writeFile('u.md', Buffer.from('mine!'), T1)
    expect(await b.read('u.md')).toBe('mine!')
    await t.rm('u.md')
    expect(await b.read('u.md')).toBeNull()
  })

  it('stat:不存在 → null;出错 → 抛(绝不当成不存在)', async () => {
    b = await make()
    const t = b.open()
    await t.walk()
    expect(await t.stat('nope.md')).toBeNull()
    await expect(t.stat(b.breakStat())).rejects.toThrow()
  })
})

describe('openTargetFs', () => {
  it('dir:合法的是 posix 子路径;绝对路径 / 反斜杠 / . / .. / 空段 / 首尾空白一律 bad-target-dir', () => {
    expect(parseTargetDir('')).toEqual([])
    expect(parseTargetDir('a')).toEqual(['a'])
    expect(parseTargetDir('vaults/笔记 库')).toEqual(['vaults', '笔记 库'])
    for (const bad of ['/a', 'a\\b', 'a/../b', '..', '.', 'a/./b', 'a//b', 'a/', ' a', 'a/ b ', ' ', 'C:/x', 'c:', 'a\0b']) {
      expect(() => parseTargetDir(bad), bad).toThrow('bad-target-dir')
      expect(() => openTargetFs({ kind: 'folder', folder: { path: '/tmp/x' } }, bad), bad).toThrow('bad-target-dir')
    }
  })

  it('配置缺项 → target-config-incomplete', () => {
    const bad: TargetSpec[] = [
      { kind: 'folder' },
      { kind: 'folder', folder: { path: '  ' } },
      { kind: 's3', s3: { endpoint: 'http://x', region: '', accessKeyID: 'a', secretAccessKey: '', bucket: 'b' } },
      { kind: 'webdav' },
      { kind: 'webdav', webdav: { address: '', username: 'u', password: 'p' } },
      { kind: 'dropbox', dropbox: { appKey: '', refreshToken: 'rt' } },
      { kind: 'gdrive', gdrive: { clientId: 'c', refreshToken: '' } },
      { kind: 'nope' as TargetKind },
    ]
    for (const spec of bad) expect(() => openTargetFs(spec, 'v'), spec.kind).toThrow('target-config-incomplete')
  })

  it('caps:folder 只有原子新建;dropbox 三项都原子;s3 / webdav / gdrive 全靠复查;realMove 恒 false', () => {
    expect(TARGET_CAPS.folder).toEqual({ createExclusive: true, casWrite: false, casDelete: false, realMove: false })
    expect(TARGET_CAPS.dropbox).toEqual({ createExclusive: true, casWrite: true, casDelete: true, realMove: false })
    for (const k of ['s3', 'webdav', 'gdrive'] as const) expect(TARGET_CAPS[k]).toEqual({ createExclusive: false, casWrite: false, casDelete: false, realMove: false })
    expect(Object.isFrozen(TARGET_CAPS.folder)).toBe(true)
  })
})
