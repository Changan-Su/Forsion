/** fsGdrive 协议形状测试(内存假 Drive,合成 HTTP,不连真账号):授权 URL / 换码带 secret /
 *  平铺列表 → 路径树(同名文件夹合并、同名文件出冲突 key)/ walk 只读 / 并发建目录只建一次 /
 *  写前复查身份(cas-conflict)/ 删除进回收站 / 下载 size 校验 / 限流重试 / 分页失败必抛。 */
import { createHash } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildTree, createGdriveRemote, dupKey, gdriveAuthUrl, gdriveBaseSegs, gdriveExchangeCode, qStr, type WireFile } from './fsGdrive'
import { isSafeKey } from './engine'

type Stored = WireFile & { content?: Buffer }

/** 极简 Drive v3:只认 fsGdrive 用到的那几条请求。 */
function fakeDrive(opts: { pageSize?: number; failListPage?: number; rateLimitOnce?: boolean; incomplete?: boolean; rateLimitPatchOnce?: () => void } = {}) {
  const files = new Map<string, Stored>()
  const sessions = new Map<string, { create?: Partial<Stored>; update?: string; meta: Partial<Stored> }>()
  const log: Array<{ method: string; url: string; body?: unknown }> = []
  let seq = 0
  let clock = Date.parse('2026-11-01T00:00:00Z')
  let rateLimited = false
  const nextId = (): string => `id${String(++seq).padStart(4, '0')}`
  const now = (): string => new Date((clock += 1000)).toISOString()
  const json = (b: unknown, status = 200, headers?: Record<string, string>): Response =>
    new Response(JSON.stringify(b), { status, headers: { 'Content-Type': 'application/json', ...headers } })
  const pub = (f: Stored): WireFile => {
    const { content: _c, ...rest } = f
    return rest
  }
  const put = (f: Partial<Stored> & { name: string; parents: string[] }, content?: Buffer): Stored => {
    const id = f.id ?? nextId()
    const s: Stored = { mimeType: 'text/plain', createdTime: now(), modifiedTime: now(), trashed: false, ...f, id }
    if (content) Object.assign(s, revOf(content), { content })
    files.set(id, s)
    return s
  }
  const revOf = (b: Buffer) => ({
    size: String(b.byteLength),
    md5Checksum: createHash('md5').update(b).digest('hex'),
    sha256Checksum: createHash('sha256').update(b).digest('hex'),
    headRevisionId: `rev${++seq}`,
  })
  const unq = (s: string): string => s.replace(/\\(.)/g, '$1')

  const handler = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const method = init.method ?? 'GET'
    const body = typeof init.body === 'string' ? (() => { try { return JSON.parse(init.body as string) } catch { return init.body } })() : init.body
    log.push({ method, url, body: body instanceof URLSearchParams ? Object.fromEntries(body) : body })
    const u = new URL(url)
    if (url.startsWith('https://oauth2.googleapis.com/token')) return json({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 })
    if (opts.rateLimitOnce && !rateLimited && u.pathname.endsWith('/files') && method === 'GET') {
      rateLimited = true
      return json({ error: { errors: [{ reason: 'userRateLimitExceeded' }] } }, 403)
    }
    if (opts.rateLimitPatchOnce && method === 'PATCH' && /^\/drive\/v3\/files\/./.test(u.pathname)) {
      const hook = opts.rateLimitPatchOnce
      opts.rateLimitPatchOnce = undefined
      hook() // 退避期间另一台改了它
      return json({ error: 'rate' }, 429)
    }
    if (u.pathname === '/drive/v3/about') return json({ user: { permissionId: 'P1', emailAddress: 'a@example.com' } })
    if (u.hostname === 'upload.session') {
      const s = sessions.get(u.pathname)!
      const data = Buffer.from(init.body as Uint8Array)
      const target = s.update ? files.get(s.update)! : put(s.create as Stored & { parents: string[] })
      Object.assign(target, s.meta, revOf(data), { content: data })
      return json(pub(target))
    }
    if (u.pathname === '/upload/drive/v3/files' && method === 'POST') {
      const p = `/s${++seq}`
      sessions.set(p, { create: { name: body.name, parents: body.parents }, meta: { modifiedTime: body.modifiedTime } })
      return new Response(null, { status: 200, headers: { Location: `https://upload.session${p}` } })
    }
    const upd = u.pathname.match(/^\/upload\/drive\/v3\/files\/(.+)$/)
    if (upd && method === 'PATCH') {
      const p = `/s${++seq}`
      sessions.set(p, { update: decodeURIComponent(upd[1]), meta: { modifiedTime: body.modifiedTime } })
      return new Response(null, { status: 200, headers: { Location: `https://upload.session${p}` } })
    }
    if (u.pathname === '/drive/v3/files' && method === 'POST') return json({ id: put({ name: body.name, parents: body.parents, mimeType: body.mimeType }).id })
    if (u.pathname === '/drive/v3/files' && method === 'GET') {
      const q = u.searchParams.get('q') ?? ''
      let list = [...files.values()].filter((f) => !f.trashed)
      const m = q.match(/^'((?:[^'\\]|\\.)*)' in parents and name = '((?:[^'\\]|\\.)*)' and trashed = false( and mimeType = '[^']*')?$/)
      if (m) list = list.filter((f) => f.parents?.includes(unq(m[1])) && f.name === unq(m[2]) && (!m[3] || f.mimeType === 'application/vnd.google-apps.folder'))
      else if (q !== 'trashed = false') return json({ error: `unsupported q ${q}` }, 400)
      const size = m ? 1000 : opts.pageSize ?? 1000
      const start = Number(u.searchParams.get('pageToken') || 0)
      if (!m && opts.failListPage !== undefined && start / size === opts.failListPage) return json({ error: 'boom' }, 500)
      const page = list.slice(start, start + size)
      return json({ files: page.map(pub), nextPageToken: start + size < list.length ? String(start + size) : undefined, incompleteSearch: !m && !!opts.incomplete })
    }
    const one = u.pathname.match(/^\/drive\/v3\/files\/(.+)$/)
    if (one) {
      const f = files.get(decodeURIComponent(one[1]))
      if (!f) return json({ error: 'notFound' }, 404)
      if (method === 'PATCH') {
        Object.assign(f, body)
        return json({ id: f.id })
      }
      if (u.searchParams.get('alt') === 'media') return new Response(new Uint8Array(f.content ?? Buffer.alloc(0)))
      return json(pub(f))
    }
    return json({ error: `unhandled ${method} ${url}` }, 500)
  }
  vi.stubGlobal('fetch', async (url: string | URL, init?: RequestInit) => handler(String(url), init))
  const folder = (name: string, parent: string, extra: Partial<Stored> = {}): Stored =>
    put({ name, parents: [parent], mimeType: 'application/vnd.google-apps.folder', ...extra })
  return { files, log, put, folder, live: () => [...files.values()].filter((f) => !f.trashed) }
}

const remote = (baseDir?: string) => createGdriveRemote({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt', baseDir })

afterEach(() => vi.unstubAllGlobals())

describe('fsGdrive', () => {
  it('授权 URL:drive.file + offline + consent + PKCE + 回环 redirect/state', () => {
    const u = new URL(gdriveAuthUrl('cid', 'CH', 'http://127.0.0.1:5555/', 'S'))
    expect(u.origin + u.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(Object.fromEntries(u.searchParams)).toMatchObject({
      client_id: 'cid',
      redirect_uri: 'http://127.0.0.1:5555/',
      scope: 'https://www.googleapis.com/auth/drive.file',
      code_challenge: 'CH',
      code_challenge_method: 'S256',
      access_type: 'offline',
      prompt: 'consent',
      state: 'S',
    })
  })

  it('换码:带 client_secret 与 redirect_uri,账号身份取 about.permissionId', async () => {
    const d = fakeDrive()
    const r = await gdriveExchangeCode({ clientId: 'cid', clientSecret: 'sec' }, ' C ', 'V', 'http://127.0.0.1:1/')
    expect(r).toEqual({ refreshToken: 'RT', accountId: 'P1', email: 'a@example.com', name: undefined })
    expect(d.log[0].body).toMatchObject({ grant_type: 'authorization_code', code: 'C', code_verifier: 'V', client_id: 'cid', client_secret: 'sec', redirect_uri: 'http://127.0.0.1:1/' })
  })

  it('纯函数:baseDir 缺省 Forsion-Vault、q 字面量转义、dupKey 保扩展名且过 isSafeKey', () => {
    expect(gdriveBaseSegs(undefined)).toEqual(['Forsion-Vault'])
    expect(gdriveBaseSegs(' /a\\b/ ')).toEqual(['a', 'b'])
    expect(gdriveBaseSegs('../x')).toEqual(['x'])
    expect(qStr("it's a\\b")).toBe("'it\\'s a\\\\b'")
    expect(dupKey('笔记/一.md', 'abcdefghijkl')).toBe('笔记/一 (conflict gdrive abcdefghijkl).md')
    expect(dupKey('README', 'x/y')).toBe('README (conflict gdrive xy)')
    expect(dupKey('a.md', 'SAMEPREFIX1')).not.toBe(dupKey('a.md', 'SAMEPREFIX2')) // 不截短:前缀相同也不撞
    expect(isSafeKey(dupKey('a/.env', 'id1'))).toBe(true)
  })

  it('路径树:同名文件夹合并;同名文件按 createdTime→id 定主次;文档类 / 带 / 的名字 / 回收站跳过;文件与文件夹撞名文件让位', () => {
    const t = (s: string) => `2026-11-0${s}T00:00:00Z`
    const all: WireFile[] = [
      { id: 'A1', name: 'a', mimeType: 'application/vnd.google-apps.folder', parents: ['B'], createdTime: t('2') },
      { id: 'A2', name: 'a', mimeType: 'application/vnd.google-apps.folder', parents: ['B'], createdTime: t('1') },
      { id: 'x', name: 'x.md', parents: ['A1'], createdTime: t('1') },
      { id: 'y', name: 'y.md', parents: ['A2'], createdTime: t('1') },
      { id: 'd2', name: 'dup.md', parents: ['A1'], createdTime: t('3') },
      { id: 'd1', name: 'dup.md', parents: ['A2'], createdTime: t('3') },
      { id: 'doc', name: 'Doc', mimeType: 'application/vnd.google-apps.document', parents: ['B'] },
      { id: 'sl', name: 'a/b.md', parents: ['B'] },
      { id: 'tr', name: 'gone.md', parents: ['B'], trashed: true },
      { id: 'clash', name: 'a', parents: ['B'] },
      { id: 'out', name: 'outside.md', parents: ['OTHER'] },
    ]
    const tree = buildTree(all, ['B'])
    // 空文件夹与文件撞名:文件照旧占原路径(否则推上去的文件下一轮变冲突 key,原 key 被当远端删除)
    const empty = buildTree([
      { id: 'F', name: 'n', mimeType: 'application/vnd.google-apps.folder', parents: ['B'] },
      { id: 'f', name: 'n', parents: ['B'] },
    ], ['B'])
    expect([...empty.files.keys()]).toEqual(['n'])
    expect([...tree.files.keys()].sort()).toEqual(['a (conflict gdrive clash)', 'a/dup (conflict gdrive d2).md', 'a/dup.md', 'a/x.md', 'a/y.md'])
    expect(tree.files.get('a/dup.md')!.id).toBe('d1') // 同龄按 id 字典序
    expect(tree.folders.get('a')).toEqual(['A2', 'A1']) // 老的在前 = 新建子项的落点
    // 派生 key 撞上真实文件名:整轮报错,不静默吞掉一个 ID
    expect(() => buildTree([
      { id: 'o', name: 'x.md', parents: ['B'], createdTime: t('1') },
      { id: 'y', name: 'x.md', parents: ['B'], createdTime: t('2') },
      { id: 'z', name: 'x (conflict gdrive y).md', parents: ['B'] },
    ], ['B'])).toThrow(/gdrive-key-collision/)
  })

  it('walk:baseDir 不存在 = 空远端,而且不建任何东西(dry run 也走这里)', async () => {
    const d = fakeDrive()
    expect(await remote().walk()).toEqual([])
    expect(d.log.filter((l) => l.method !== 'GET' && !l.url.includes('oauth2'))).toEqual([])
    expect(d.files.size).toBe(0)
  })

  it('walk:分页合并、身份 = id@headRevision、带 sha256 hash;分页中途失败必抛', async () => {
    const d = fakeDrive({ pageSize: 2 })
    const base = d.folder('Forsion-Vault', 'root')
    const sub = d.folder('笔记', base.id)
    d.put({ name: '一.md', parents: [sub.id] }, Buffer.from('hi'))
    d.put({ name: 'two.md', parents: [base.id] }, Buffer.from('hello'))
    const out = await remote().walk()
    expect(out.map((e) => e.key).sort()).toEqual(['two.md', '笔记/一.md'])
    const one = out.find((e) => e.key === '笔记/一.md')!
    const w = [...d.files.values()].find((f) => f.name === '一.md')!
    expect(one).toMatchObject({ size: 2, id: `${w.id}@${w.headRevisionId}`, hash: createHash('sha256').update('hi').digest('hex') })

    vi.unstubAllGlobals()
    const d2 = fakeDrive({ pageSize: 1, failListPage: 1 })
    const b2 = d2.folder('Forsion-Vault', 'root')
    d2.put({ name: 'a.md', parents: [b2.id] }, Buffer.from('a'))
    d2.put({ name: 'b.md', parents: [b2.id] }, Buffer.from('b'))
    await expect(remote().walk()).rejects.toThrow(/gdrive list 500/)
  })

  it('并发写进新目录:baseDir 与每级父目录只建一次', async () => {
    const d = fakeDrive()
    const r = remote('Vault/inner')
    await r.walk()
    await Promise.all(['a/b/1.md', 'a/b/2.md', 'a/3.md', 'a/b/c/4.md', '5.md'].map((k) => r.writeFile(k, Buffer.from(k), 1000, undefined, null)))
    const folders = d.live().filter((f) => f.mimeType === 'application/vnd.google-apps.folder').map((f) => f.name).sort()
    expect(folders).toEqual(['Vault', 'a', 'b', 'c', 'inner'])
    const again = await remote('Vault/inner').walk()
    expect(again.map((e) => e.key).sort()).toEqual(['5.md', 'a/3.md', 'a/b/1.md', 'a/b/2.md', 'a/b/c/4.md'])
  })

  it('新建(expectedId=null):walk 之后另一台已建同名 → cas-conflict,不出重复文件', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const r = remote()
    await r.walk()
    d.put({ name: 'n.md', parents: [base.id] }, Buffer.from('theirs'))
    await expect(r.writeFile('n.md', Buffer.from('mine'), 1000, undefined, null)).rejects.toThrow(/cas-conflict/)
    expect(d.live().filter((f) => f.name === 'n.md')).toHaveLength(1)
  })

  it('更新:身份不符 → cas-conflict 且内容不动;相符 → 写入,返回的身份与下一次 walk 一致', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const f = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('v1'))
    const r = remote()
    const [ent] = await r.walk()
    // 另一台在 walk 之后改了它
    Object.assign(f, { headRevisionId: 'other', content: Buffer.from('theirs') })
    await expect(r.writeFile('a.md', Buffer.from('mine'), 1000, undefined, ent.id)).rejects.toThrow(/cas-conflict/)
    expect(f.content!.toString()).toBe('theirs')

    const [ent2] = await remote().walk()
    const written = await r.writeFile('a.md', Buffer.from('mine'), Date.parse('2026-11-02T00:00:00Z'), undefined, ent2.id)
    expect(f.content!.toString()).toBe('mine')
    expect(f.modifiedTime).toBe('2026-11-02T00:00:00.000Z')
    const [ent3] = await remote().walk()
    expect(written.id).toBe(ent3.id)
    expect(written.id).not.toBe(ent2.id)
  })

  it('冲突 key 指向自己的文件:写 / 删它只动那一份', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const old = d.put({ name: 'x.md', parents: [base.id] }, Buffer.from('old'))
    const young = d.put({ name: 'x.md', parents: [base.id] }, Buffer.from('young'))
    const r = remote()
    const list = await r.walk()
    const alias = list.find((e) => e.key !== 'x.md')!
    expect(alias.key).toBe(dupKey('x.md', young.id))
    expect((await r.readFile(alias.key)).toString()).toBe('young')
    await r.rm(alias.key, undefined, alias.id)
    expect(young.trashed).toBe(true)
    expect(old.trashed).toBe(false)
    expect((await remote().walk()).map((e) => e.key)).toEqual(['x.md'])
  })

  it('rm:进回收站(不硬删);身份不符 = cas-conflict;已不在 = 幂等', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const f = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('v1'))
    const r = remote()
    const [ent] = await r.walk()
    await expect(r.rm('a.md', undefined, `${f.id}@stale`)).rejects.toThrow(/cas-conflict/)
    expect(f.trashed).toBe(false)
    await r.rm('a.md', undefined, ent.id)
    expect(f.trashed).toBe(true)
    expect(d.files.has(f.id)).toBe(true) // 还在回收站里
    await r.rm('a.md', undefined, ent.id) // 幂等
    await r.rm('never.md') // 不在清单 = 幂等
  })

  it('写删前核对名字和父目录:walk 之后在网页版改名 / 移走(内容版本不变)→ cas-conflict', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const other = d.folder('Elsewhere', 'root')
    const a = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('a'))
    const b = d.put({ name: 'b.md', parents: [base.id] }, Buffer.from('b'))
    const r = remote()
    const list = await r.walk()
    const ida = list.find((e) => e.key === 'a.md')!.id
    const idb = list.find((e) => e.key === 'b.md')!.id
    a.name = 'renamed.md'
    b.parents = [other.id]
    await expect(r.rm('a.md', undefined, ida)).rejects.toThrow(/cas-conflict/)
    await expect(r.writeFile('b.md', Buffer.from('x'), 1, undefined, idb)).rejects.toThrow(/cas-conflict/)
    expect(a.trashed).toBe(false)
    expect(b.content!.toString()).toBe('b')
  })

  it('限流重试前重新核对:退避期间另一台改了文件 → 不拿旧判断重发回收', async () => {
    let f: Stored | undefined
    const d = fakeDrive({ rateLimitPatchOnce: () => { Object.assign(f!, { headRevisionId: 'newer' }) } })
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const base = d.folder('Forsion-Vault', 'root')
      f = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('v1'))
      const r = remote()
      const [ent] = await r.walk()
      const p = r.rm('a.md', undefined, ent.id)
      const settled = expect(p).rejects.toThrow(/cas-conflict/)
      await vi.advanceTimersByTimeAsync(1500)
      await settled
      expect(f.trashed).toBe(false)
    } finally {
      vi.useRealTimers()
    }
  })

  it('建前复查查全部同名父目录:另一台在第二个同名文件夹里先建了 → cas-conflict', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    d.folder('notes', base.id)
    const n2 = d.folder('notes', base.id)
    d.put({ name: 'seed.md', parents: [n2.id] }, Buffer.from('s')) // 让 notes 非空
    const r = remote()
    await r.walk()
    d.put({ name: 'x.md', parents: [n2.id] }, Buffer.from('theirs'))
    await expect(r.writeFile('notes/x.md', Buffer.from('mine'), 1, undefined, null)).rejects.toThrow(/cas-conflict/)
    expect(d.live().filter((x) => x.name === 'x.md')).toHaveLength(1)
  })

  it('rm 前置条件:null 而远端有 = 冲突;期望的那份已删但同名被重建 = 冲突;真没了 = 幂等', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const f = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('v1'))
    const r = remote()
    const [ent] = await r.walk()
    await expect(r.rm('a.md', undefined, null)).rejects.toThrow(/cas-conflict/)
    f.trashed = true
    const again = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('new'))
    await expect(r.rm('a.md', undefined, ent.id)).rejects.toThrow(/cas-conflict/)
    expect(again.trashed).toBe(false)
    again.trashed = true
    await r.rm('a.md', undefined, ent.id) // 两份都没了 = 已删,幂等
  })

  it('walk:Drive 自报结果不完整(incompleteSearch)→ 抛,不当成完整清单', async () => {
    const d = fakeDrive({ incomplete: true })
    d.folder('Forsion-Vault', 'root')
    await expect(remote().walk()).rejects.toThrow(/incomplete/)
  })

  it('readFile:同样大小但内容换了一版(sha256 对不上)→ 抛,不把新内容记到旧身份上', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const f = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('abc'))
    const r = remote()
    await r.walk()
    f.content = Buffer.from('xyz')
    await expect(r.readFile('a.md')).rejects.toThrow(/content mismatch/)
  })

  it('readFile:内容长度对清单 size 校验,不符即抛', async () => {
    const d = fakeDrive()
    const base = d.folder('Forsion-Vault', 'root')
    const f = d.put({ name: 'a.md', parents: [base.id] }, Buffer.from('abc'))
    const r = remote()
    await r.walk()
    f.content = Buffer.from('a') // 下载被截断
    await expect(r.readFile('a.md')).rejects.toThrow(/size mismatch/)
  })

  it('限流(403 userRateLimitExceeded):退避后重试成功', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    try {
      const d = fakeDrive({ rateLimitOnce: true })
      d.folder('Forsion-Vault', 'root')
      const p = remote().walk()
      await vi.advanceTimersByTimeAsync(1500)
      expect(await p).toEqual([])
      expect(d.log.filter((l) => l.url.includes('/drive/v3/files?')).length).toBeGreaterThanOrEqual(3)
    } finally {
      vi.useRealTimers()
    }
  })

  it('check:about 通 = ok;token 只刷一次', async () => {
    const d = fakeDrive()
    const r = remote()
    expect(await r.check()).toEqual({ ok: true })
    expect(await r.check()).toEqual({ ok: true })
    expect(d.log.filter((l) => l.url.includes('oauth2')).length).toBe(1)
    expect(d.log[0].body).toMatchObject({ grant_type: 'refresh_token', client_secret: 'sec' })
  })
})
