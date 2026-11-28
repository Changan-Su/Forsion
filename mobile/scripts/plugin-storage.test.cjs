/**
 * Android 插件数据文件夹(ctx.storage)宿主单测 —— `npm run test:pluginstorage`(mobile 目录,不用先 build)。
 * 对象:src/plugins/pluginStorageHost.ts(契约 = 桌面 electron/amadeus/pluginStorage.ts)。文件系统用内存替身
 * (PluginStorageFs 接缝:目录显式存在、能注入读 / stat / 列目录失败、能切「换名不盖已存在的文件」),不碰 Capacitor。
 * 真机上的换名覆盖语义与 url() 的本地文件服务没有在这里验(要模拟器)。
 */
const assert = require('node:assert/strict')
const { build } = require('esbuild')

const loadAll = async (entries) => {
  const out = (await build({
    stdin: { contents: entries.map((e) => `export * from ${JSON.stringify(e)}`).join('\n'), resolveDir: __dirname, loader: 'ts' },
    bundle: true, write: false, logLevel: 'silent', platform: 'node', format: 'cjs',
  })).outputFiles[0].text
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', out)(mod, mod.exports, require)
  return mod.exports
}

const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '')
const ancestors = (p) => { const out = []; for (let q = parentOf(p); ; q = parentOf(q)) { out.push(q); if (!q) return out } }

/** 内存 PluginStorageFs。failRead / failStat / failList:这些路径在、却读不出来(EIO);failWrite:写这些路径就抛。
 *  文件换名**从不盖已存在的目标**(严格:宿主若靠「换名会覆盖」就当场红);renameHook(from, to) 可在换名前抛错注入失败
 *  (deleteTarget:像安卓那样先删目标再失败)。 */
function memFs() {
  const files = new Map() // path → { bytes, mtime }
  const dirs = new Set([''])
  let clock = 1000
  const eio = (p) => Object.assign(new Error(`EIO: ${p}`), { code: 'EIO' })
  const api = {
    files, dirs,
    failRead: new Set(), failStat: new Set(), failList: new Set(), failWrite: new Set(),
    renameHook: null,
    renames: 0,
    ensureDir(p) {
      for (const a of [...ancestors(p).reverse(), p]) {
        if (files.has(a)) throw new Error(`Not a directory: ${a}`)
        dirs.add(a)
      }
    },
    async readBytes(p) {
      if (api.failRead.has(p)) throw eio(p)
      if (files.has(p)) return new Uint8Array(files.get(p).bytes)
      if (dirs.has(p)) throw new Error(`Is a directory: ${p}`)
      return null
    },
    async writeBytes(p, bytes) {
      if (api.failWrite.has(p)) throw eio(p)
      if (dirs.has(p)) throw new Error(`Is a directory: ${p}`)
      api.ensureDir(parentOf(p))
      files.set(p, { bytes: new Uint8Array(bytes), mtime: ++clock })
    },
    async appendBytes(p, bytes) {
      if (!dirs.has(parentOf(p))) throw new Error(`Missing parent directory: ${p}`)
      if (dirs.has(p)) throw new Error(`Is a directory: ${p}`)
      const cur = files.get(p)?.bytes ?? new Uint8Array(0)
      const next = new Uint8Array(cur.length + bytes.length)
      next.set(cur); next.set(bytes, cur.length)
      files.set(p, { bytes: next, mtime: ++clock })
    },
    async stat(p) {
      if (api.failStat.has(p)) throw eio(p)
      if (files.has(p)) return { type: 'file', size: files.get(p).bytes.length, mtime: files.get(p).mtime }
      if (dirs.has(p)) return { type: 'directory', size: 0, mtime: 1 }
      return null
    },
    async list(d) {
      if (api.failList.has(d)) throw eio(d)
      if (files.has(d)) throw new Error(`Not a directory: ${d}`)
      if (!dirs.has(d)) return null
      const out = []
      for (const [k, v] of files) if (parentOf(k) === d && k !== d) out.push({ name: k.slice(d ? d.length + 1 : 0), type: 'file', size: v.bytes.length, mtime: v.mtime })
      for (const k of dirs) if (k && parentOf(k) === d) out.push({ name: k.slice(d ? d.length + 1 : 0), type: 'directory', size: 0, mtime: 1 })
      return out.reverse() // 故意乱序:宿主自己排
    },
    async mkdir(p) { if (p) api.ensureDir(p) },
    async rename(from, to) {
      api.renames += 1
      if (!dirs.has(parentOf(to))) throw new Error(`Missing parent directory: ${to}`)
      if (files.has(from)) {
        if (dirs.has(to)) throw new Error(`Cannot overwrite a directory with a file: ${to}`)
        const hook = api.renameHook && api.renameHook(from, to)
        if (hook) { if (hook === 'deleteTarget') files.delete(to); throw new Error(`rename failed: ${from} -> ${to}`) }
        if (files.has(to)) throw new Error(`Destination exists: ${to}`)
        files.set(to, files.get(from)); files.delete(from)
        return
      }
      if (dirs.has(from)) {
        if (files.has(to) || dirs.has(to)) throw new Error(`Destination directory exists: ${to}`)
        for (const k of [...files.keys()]) if (k.startsWith(`${from}/`)) { files.set(`${to}${k.slice(from.length)}`, files.get(k)); files.delete(k) }
        for (const k of [...dirs]) if (k === from || k.startsWith(`${from}/`)) { dirs.add(`${to}${k.slice(from.length)}`); dirs.delete(k) }
        return
      }
      throw new Error(`File does not exist: ${from}`)
    },
    async remove(p) {
      files.delete(p)
      for (const k of [...files.keys()]) if (k.startsWith(`${p}/`)) files.delete(k)
      for (const k of [...dirs]) if (k === p || k.startsWith(`${p}/`)) dirs.delete(k)
    },
  }
  return api
}
const enc = (s) => new TextEncoder().encode(s)
const dec = (b) => new TextDecoder('utf-8', { ignoreBOM: true }).decode(b)
const put = (fs, p, text) => fs.writeBytes(p, typeof text === 'string' ? enc(text) : text)
const text = (fs, p) => (fs.files.has(p) ? dec(fs.files.get(p).bytes) : undefined)
const tmpLeft = (fs) => [...fs.files.keys()].filter((k) => /\.tmp-\d+-\d+$/.test(k))

const results = []
const test = async (name, fn) => {
  try { await fn(); results.push([name, true]); console.log(`PASS  ${name}`) }
  catch (e) { results.push([name, false]); console.log(`FAIL  ${name}\n      ${e && e.stack ? e.stack.split('\n').slice(0, 14).join('\n      ') : e}`) }
}

;(async () => {
  const { createMobilePluginStorage, PLUGIN_STORAGE_DIR, storageVaultKey } = await loadAll([
    '../src/plugins/pluginStorageHost.ts', '../../desktop/shared/amadeus/pluginStorage.ts',
  ])
  const setup = (o = {}) => {
    const fs = memFs()
    const state = { root: o.root === undefined ? '/vault' : o.root, base: o.base ?? null }
    const host = createMobilePluginStorage({
      fs,
      vaultRoot: o.vaultRoot ? () => o.vaultRoot(state) : async () => state.root,
      vaultDir: (r) => (/^\/[^/]/.test(r) ? r.replace(/^\/+/, '') : null), // 同 main.tsx
      baseUrl: () => state.base,
    })
    const call = (req) => host.handle({ id: 'demo', ...req })
    return { fs, state, host, call }
  }
  const ROOT = `${PLUGIN_STORAGE_DIR}/demo`
  const VKEY = () => storageVaultKey('/vault')

  await test('落点 = plugin-data/<id>/(单数、每插件一个文件夹,和 plugins-data/<id>.json 分开)', async () => {
    assert.equal(PLUGIN_STORAGE_DIR, 'plugin-data')
    const { fs, call } = setup()
    await call({ op: 'write', path: 'a.txt', data: 'x' })
    assert.deepEqual([...fs.files.keys()], ['plugin-data/demo/a.txt'])
  })

  await test('分库迁移动到新库层，保留冲突、应用层与其它库，重复迁移无害', async () => {
    const oldRoot = 'cloud://vault/vault:Amadeus/Notes/'
    const newRoot = 'cloud://split'
    const { fs, state, host, call } = setup({ root: oldRoot })
    const from = `${ROOT}/vaults/${storageVaultKey(oldRoot)}`
    const to = `${ROOT}/vaults/${storageVaultKey(newRoot)}`
    const unrelated = `${ROOT}/vaults/${VKEY()}/file.txt`
    await put(fs, `${ROOT}/app.txt`, 'app')
    await put(fs, unrelated, 'local')
    await put(fs, `${from}/collision.txt`, 'old')
    await put(fs, `${to}/collision.txt`, 'new')
    const write = call({ op: 'write', vault: oldRoot, path: 'nested/file.txt', data: 'queued' })
    await host.migrateVaultRoot(oldRoot, newRoot)
    await write
    const snapshot = [...fs.files]
    await host.migrateVaultRoot(oldRoot, newRoot)
    assert.deepEqual([...fs.files], snapshot)
    state.root = newRoot
    assert.equal(await call({ op: 'readText', vault: newRoot, path: 'nested/file.txt' }), 'queued')
    assert.equal(text(fs, `${from}/nested/file.txt`), 'queued')
    assert.equal(text(fs, `${from}/collision.txt`), 'old')
    assert.equal(text(fs, `${to}/collision.txt`), 'new')
    assert.equal(text(fs, `${ROOT}/app.txt`), 'app')
    assert.equal(text(fs, unrelated), 'local')
    await call({ op: 'remove', vault: newRoot, path: 'collision.txt' })
    await call({ op: 'remove', vault: newRoot, path: 'nested/file.txt' })
    await host.migrateVaultRoot(oldRoot, newRoot)
    assert.equal(await call({ op: 'readText', vault: newRoot, path: 'collision.txt' }), null)
    assert.equal(await call({ op: 'readText', vault: newRoot, path: 'nested/file.txt' }), null)
  })

  await test('分库遇到读取、目标状态或换名失败时保留原件，下次可重试', async () => {
    const oldRoot = 'cloud://vault/vault:Amadeus/Work/'
    const newRoot = 'cloud://split'
    const { fs, host, state, call } = setup({ root: oldRoot })
    const from = `${ROOT}/vaults/${storageVaultKey(oldRoot)}`
    const to = `${ROOT}/vaults/${storageVaultKey(newRoot)}`
    const paths = ['read.txt', 'stat.txt', 'rename.txt']
    for (const p of paths) await put(fs, `${from}/${p}`, p)
    host.pauseVaultMigration(newRoot)
    state.root = newRoot
    await assert.rejects(call({ op: 'readText', vault: newRoot, path: 'read.txt' }), /Vault changed/)
    fs.failRead.add(`${from}/read.txt`)
    fs.failStat.add(`${to}/stat.txt`)
    fs.renameHook = (_, dest) => dest === `${to}/rename.txt`
    await assert.rejects(host.migrateVaultRoot(oldRoot, newRoot))
    state.root = newRoot
    await assert.rejects(call({ op: 'readText', vault: newRoot, path: 'read.txt' }), /Vault changed/)
    await assert.rejects(call({ op: 'write', vault: newRoot, path: 'read.txt', data: 'default' }), /Vault changed/)
    for (const p of paths) {
      assert.equal(text(fs, `${from}/${p}`), p)
      assert.equal(text(fs, `${to}/${p}`), undefined)
    }
    assert.deepEqual(tmpLeft(fs), [])
    fs.failRead.clear()
    fs.failStat.clear()
    fs.renameHook = null
    await host.migrateVaultRoot(oldRoot, newRoot)
    for (const p of paths) {
      assert.equal(text(fs, `${from}/${p}`), p)
      assert.equal(text(fs, `${to}/${p}`), p)
    }
  })

  await test('分库开始前的首次插件写入完成后才枚举目录', async () => {
    const oldRoot = 'cloud://vault/vault:Amadeus/Notes/'
    const newRoot = 'cloud://split'
    let release
    const waiting = new Promise((resolve) => { release = resolve })
    const { fs, state, host, call } = setup({ root: oldRoot, vaultRoot: async (state) => {
      await waiting
      return state.root
    } })
    const first = call({ op: 'write', vault: oldRoot, path: 'prefs.json', data: 'first write' })
    const moving = host.migrateVaultRoot(oldRoot, newRoot)
    assert.deepEqual([...fs.files], [])
    release()
    await first
    await moving
    state.root = newRoot
    assert.equal(await call({ op: 'readText', vault: newRoot, path: 'prefs.json' }), 'first write')
    assert.equal(text(fs, `${ROOT}/vaults/${storageVaultKey(oldRoot)}/prefs.json`), 'first write')
  })

  await test('越界路径一律拒(..、`/` / `\\` 开头、盘符、空、NUL),跟应用那一层不许写 vaults/;坏插件 id 拒', async () => {
    const { fs, call, host } = setup()
    for (const p of ['../x', 'a/../../b', '/abs', '\\abs\\x.txt', 'C:/x', '', '/', '//srv/x', 'a\0b', './a', 'a//b']) {
      await assert.rejects(call({ op: 'write', path: p, data: 'x' }), TypeError, `path ${JSON.stringify(p)}`)
      await assert.rejects(call({ op: 'readText', path: p }), TypeError, `read ${JSON.stringify(p)}`)
    }
    await assert.rejects(call({ op: 'write', path: 'vaults/k/x', data: 'x' }), /reserved/)
    await assert.rejects(call({ op: 'move', path: 'a', to: '../b' }), TypeError)
    for (const id of ['../evil', 'Evil', '', '.x', 'a/b']) await assert.rejects(host.handle({ id, op: 'write', path: 'a', data: 'x' }), /Invalid plugin id/)
    await assert.rejects(host.handle({ id: '../evil', op: 'usage' }), /Invalid plugin id/)
    assert.equal(fs.files.size, 0)
    // 末尾斜杠照去(共享 normalizeStoragePath 的口径,桌面同)
    await call({ op: 'write', path: 'sub/x.txt/', data: 'x' })
    assert.deepEqual([...fs.files.keys()], ['plugin-data/demo/sub/x.txt'])
  })

  await test('保留名(共享 normalizeStoragePath):跟应用那层 vaults 不分大小写都拒;库那层第一段 .forsion-imports 不分大小写都拒', async () => {
    const { call } = setup()
    for (const p of ['vaults/x', 'Vaults/x', 'VAULTS']) await assert.rejects(call({ op: 'write', path: p, data: 'x' }), TypeError, p)
    for (const p of ['.forsion-imports/m.json', '.Forsion-Imports/m.json']) {
      await assert.rejects(call({ vault: '/vault', op: 'write', path: p, data: 'x' }), TypeError, p)
      await assert.rejects(call({ vault: '/vault', op: 'readText', path: p }), TypeError, p)
    }
    await call({ op: 'write', path: '.forsion-imports/ok.txt', data: 'ok' }) // 跟应用那层不是保留名
    await call({ vault: '/vault', op: 'write', path: 'sub/.forsion-imports/ok.txt', data: 'ok' }) // 只管第一段
  })

  await test('读写往返:文本按 UTF-8、字节原样、readBytes 回 Uint8Array;父目录自动建、不留临时文件;BOM 照留(同桌面)', async () => {
    const { fs, call } = setup()
    await call({ op: 'write', path: 'notes/deep/a.txt', data: '你好 🌱 hello' })
    assert.equal(await call({ op: 'readText', path: 'notes/deep/a.txt' }), '你好 🌱 hello')
    const bytes = new Uint8Array([0, 1, 2, 250, 255])
    await call({ op: 'write', path: 'bin/x.bin', data: bytes })
    const back = await call({ op: 'readBytes', path: 'bin/x.bin' })
    assert.ok(back instanceof Uint8Array)
    assert.deepEqual([...back], [0, 1, 2, 250, 255])
    assert.deepEqual([...(await call({ op: 'readBytes', path: 'notes/deep/a.txt' }))], [...enc('你好 🌱 hello')])
    // 子视图只写自己那一段
    const big = new Uint8Array([9, 9, 7, 8, 9])
    await call({ op: 'write', path: 'bin/sub.bin', data: big.subarray(2, 4) })
    assert.deepEqual([...(await call({ op: 'readBytes', path: 'bin/sub.bin' }))], [7, 8])
    await call({ op: 'write', path: 'bom.txt', data: '\uFEFFx' })
    assert.equal(await call({ op: 'readText', path: 'bom.txt' }), '\uFEFFx')
    // 覆盖写
    await call({ op: 'write', path: 'notes/deep/a.txt', data: 'v2' })
    assert.equal(await call({ op: 'readText', path: 'notes/deep/a.txt' }), 'v2')
    assert.deepEqual(tmpLeft(fs), [])
    await assert.rejects(call({ op: 'write', path: 'x', data: 42 }), TypeError)
  })

  await test('覆盖写 = 旧文件先挪开再换名:成功后不留临时 / 备份文件;目标是文件夹 → 拒、清掉临时文件', async () => {
    const { fs, call } = setup()
    await call({ op: 'write', path: 'a.json', data: '1' })
    await call({ op: 'write', path: 'a.json', data: '2' })
    assert.equal(await call({ op: 'readText', path: 'a.json' }), '2')
    await call({ op: 'write', path: 'dir/inner.txt', data: 'x' })
    await assert.rejects(call({ op: 'write', path: 'dir', data: 'y' }), /folder/)
    assert.equal(text(fs, `${ROOT}/dir/inner.txt`), 'x')
    assert.deepEqual(tmpLeft(fs), [])
  })

  await test('新内容换名到目标失败(安卓那样先删目标再失败也一样):旧内容挪回原处照样读得到、reject、不留临时文件', async () => {
    for (const how of ['plain', 'deleteTarget']) {
      const { fs, call } = setup()
      await call({ op: 'write', path: 'a.json', data: 'old' })
      const abs = `${ROOT}/a.json`
      let failed = 0
      // 只让「临时文件 → 目标」那一次失败(挪开 = 目标 → bak、挪回 = bak → 目标,都不拦)
      fs.renameHook = (from, to) => (to === abs && failed++ === 0 ? (how === 'deleteTarget' ? 'deleteTarget' : true) : null)
      await assert.rejects(call({ op: 'write', path: 'a.json', data: 'new' }), /rename failed/, how)
      assert.equal(await call({ op: 'readText', path: 'a.json' }), 'old', how)
      assert.deepEqual(tmpLeft(fs), [], how)
    }
  })

  await test('挪开旧文件那一步失败:旧文件原地没动、reject、临时文件删掉', async () => {
    const { fs, call } = setup()
    await call({ op: 'write', path: 'a.json', data: 'old' })
    fs.renameHook = (from) => (from === `${ROOT}/a.json` ? true : null)
    await assert.rejects(call({ op: 'write', path: 'a.json', data: 'new' }), /rename failed/)
    assert.equal(await call({ op: 'readText', path: 'a.json' }), 'old')
    assert.deepEqual(tmpLeft(fs), [])
  })

  await test('换名和挪回都失败:旧(bak)和新(临时文件)两份都留在盘上、reject;list 不露它们', async () => {
    const { fs, call } = setup()
    await call({ op: 'write', path: 'a.json', data: 'old' })
    const abs = `${ROOT}/a.json`
    fs.renameHook = (from, to) => (to === abs ? true : null)
    await assert.rejects(call({ op: 'write', path: 'a.json', data: 'new' }), /rename failed/)
    assert.deepEqual(tmpLeft(fs).map((k) => text(fs, k)).sort(), ['new', 'old'])
    assert.equal(await call({ op: 'readText', path: 'a.json' }), null)
    assert.deepEqual(await call({ op: 'list' }), [])
  })

  await test('同一插件的改动按调用先后落盘:前一次卡在 await(库根查得慢)时,紧跟着的 append / remove 也不会抢到前面', async () => {
    let n = 0
    const slowFirst = (state) => (n++ === 0 ? new Promise((r) => setTimeout(() => r(state.root), 30)) : state.root)
    {
      const { call } = setup({ vaultRoot: slowFirst })
      const a = call({ vault: '/vault', op: 'write', path: 'o.txt', data: 'A' })
      const b = call({ vault: '/vault', op: 'append', path: 'o.txt', data: 'B' })
      await Promise.all([a, b])
      assert.equal(await call({ vault: '/vault', op: 'readText', path: 'o.txt' }), 'AB')
    }
    n = 0
    {
      const { call } = setup({ vaultRoot: slowFirst })
      const a = call({ vault: '/vault', op: 'write', path: 'gone.txt', data: 'x' })
      const b = call({ vault: '/vault', op: 'remove', path: 'gone.txt' })
      await Promise.all([a, b])
      assert.equal(await call({ vault: '/vault', op: 'stat', path: 'gone.txt' }), null)
    }
    // 入参当场取:排队期间调用方改了 buffer,写进去的还是调用那一刻的字节
    {
      const { call } = setup({ vaultRoot: (() => { let k = 0; return (st) => (k++ === 0 ? new Promise((r) => setTimeout(() => r(st.root), 20)) : st.root) })() })
      const first = call({ vault: '/vault', op: 'write', path: 'first.txt', data: '1' })
      const buf = new Uint8Array([1, 2, 3])
      const second = call({ vault: '/vault', op: 'write', path: 'buf.bin', data: buf })
      buf[0] = 9
      await Promise.all([first, second])
      assert.deepEqual([...(await call({ vault: '/vault', op: 'readBytes', path: 'buf.bin' }))], [1, 2, 3])
    }
  })

  await test('同一路径的写排队:并发 5 次写,最后一份胜出、没有交错的临时文件残留', async () => {
    const { fs, call } = setup()
    await Promise.all([1, 2, 3, 4, 5].map((n) => call({ op: 'write', path: 'q.txt', data: `v${n}` })))
    assert.equal(await call({ op: 'readText', path: 'q.txt' }), 'v5')
    assert.deepEqual(tmpLeft(fs), [])
  })

  await test('不存在 → null / [] / stat null;读失败 ≠ 不存在(读 / stat / 列目录出错一律 reject)', async () => {
    const { fs, call } = setup()
    assert.equal(await call({ op: 'readText', path: 'nope.txt' }), null)
    assert.equal(await call({ op: 'readBytes', path: 'deep/nope.bin' }), null)
    assert.equal(await call({ op: 'stat', path: 'nope' }), null)
    assert.deepEqual(await call({ op: 'list' }), [])
    assert.deepEqual(await call({ op: 'list', path: 'nope/folder' }), [])
    await call({ op: 'write', path: 'data.json', data: '{"a":1}' })
    fs.failRead.add(`${ROOT}/data.json`)
    await assert.rejects(call({ op: 'readText', path: 'data.json' }), /EIO/)
    await assert.rejects(call({ op: 'readBytes', path: 'data.json' }), /EIO/)
    fs.failStat.add(`${ROOT}/data.json`)
    await assert.rejects(call({ op: 'stat', path: 'data.json' }), /EIO/)
    fs.failList.add(ROOT)
    await assert.rejects(call({ op: 'list' }), /EIO/)
    await assert.rejects(call({ op: 'usage' }), /EIO/)
    // 读文件夹 / 把文件当文件夹列:抛,不当空
    fs.failList.clear()
    await call({ op: 'write', path: 'f/x.txt', data: 'x' })
    await assert.rejects(call({ op: 'readText', path: 'f' }))
    await assert.rejects(call({ op: 'list', path: 'f/x.txt' }))
  })

  await test('stat:文件 size / mtime,文件夹 size 0', async () => {
    const { call } = setup()
    await call({ op: 'write', path: 'd/a.bin', data: new Uint8Array(7) })
    const f = await call({ op: 'stat', path: 'd/a.bin' })
    assert.equal(f.kind, 'file'); assert.equal(f.size, 7); assert.ok(f.mtime > 0)
    assert.deepEqual(await call({ op: 'stat', path: 'd' }), { kind: 'folder', size: 0, mtime: 1 })
  })

  await test('list:按名排序;跟应用那一层的根上藏 vaults,库那一层的根上藏 .forsion-imports;藏临时文件;子目录带路径前缀', async () => {
    const { fs, call } = setup()
    await call({ op: 'write', path: 'b.txt', data: 'bb' })
    await call({ op: 'write', path: 'a/inner.txt', data: 'i' })
    await call({ op: 'write', path: 'c.json', data: '{}' })
    await put(fs, `${ROOT}/c.json.tmp-123-4`, 'half')
    await call({ vault: '/vault', op: 'write', path: 'v.txt', data: 'v' }) // 建出 vaults/
    await put(fs, `${ROOT}/vaults/${VKEY()}/.forsion-imports/m.json`, '{}')
    const app = await call({ op: 'list' })
    assert.deepEqual(app.map((e) => [e.name, e.kind, e.path, e.size]), [['a', 'folder', 'a', 0], ['b.txt', 'file', 'b.txt', 2], ['c.json', 'file', 'c.json', 2]])
    assert.deepEqual((await call({ op: 'list', path: 'a' })).map((e) => e.path), ['a/inner.txt'])
    const v = await call({ vault: '/vault', op: 'list' })
    assert.deepEqual(v.map((e) => e.name), ['v.txt'])
    // 库那一层里叫 vaults 的普通文件夹照常列(只有跟应用那一层的根上才是保留名)
    await call({ vault: '/vault', op: 'write', path: 'vaults/x.txt', data: 'x' })
    assert.deepEqual((await call({ vault: '/vault', op: 'list' })).map((e) => e.name), ['v.txt', 'vaults'])
  })

  await test('库那一层:落在 vaults/<storageVaultKey(库根)>/;库换了(或没开库)→ reject「Vault changed」', async () => {
    const { fs, call, state } = setup()
    await call({ vault: '/vault', op: 'write', path: 'cfg.json', data: '{"k":1}' })
    assert.ok(fs.files.has(`${ROOT}/vaults/${VKEY()}/cfg.json`))
    assert.equal(await call({ vault: '/vault', op: 'readText', path: 'cfg.json' }), '{"k":1}')
    assert.equal(await call({ op: 'readText', path: 'cfg.json' }), null) // 跟应用那一层看不见
    state.root = 'cloud://v1'
    await assert.rejects(call({ vault: '/vault', op: 'readText', path: 'cfg.json' }), /Vault changed/)
    await assert.rejects(call({ vault: '/vault', op: 'write', path: 'cfg.json', data: 'x' }), /Vault changed/)
    // 云端库也有自己的一层(按 cloud://<v> 的字符串分区)
    await call({ vault: 'cloud://v1', op: 'write', path: 'c.txt', data: 'c' })
    assert.ok(fs.files.has(`${ROOT}/vaults/${storageVaultKey('cloud://v1')}/c.txt`))
    state.root = null
    await assert.rejects(call({ vault: 'cloud://v1', op: 'list' }), /Vault changed/)
    await assert.rejects(call({ vault: '', op: 'list' }), /Vault changed/)
    assert.equal(text(fs, `${ROOT}/vaults/${VKEY()}/cfg.json`), '{"k":1}')
  })

  await test('append:不存在就建(父目录自动建),再追加接在后面;字节 / 文本混着来', async () => {
    const { call } = setup()
    await call({ op: 'append', path: 'logs/run.log', data: 'a\n' })
    await call({ op: 'append', path: 'logs/run.log', data: enc('b\n') })
    await Promise.all(['c', 'd', 'e'].map((x) => call({ op: 'append', path: 'logs/run.log', data: x })))
    assert.equal(await call({ op: 'readText', path: 'logs/run.log' }), 'a\nb\ncde')
  })

  await test('remove 递归、不存在算删过;move 目标已存在 → reject、不能挪进自己、新父目录自动建', async () => {
    const { fs, call } = setup()
    await call({ op: 'write', path: 'd/x/1.txt', data: '1' })
    await call({ op: 'write', path: 'd/2.txt', data: '2' })
    await call({ op: 'remove', path: 'd' })
    assert.equal(await call({ op: 'stat', path: 'd' }), null)
    assert.equal(fs.files.size, 0)
    await call({ op: 'remove', path: 'never/was' })
    await assert.rejects(call({ op: 'remove', path: '' }), TypeError) // 不许删整层
    await call({ op: 'write', path: 'a.txt', data: 'A' })
    await call({ op: 'write', path: 'b.txt', data: 'B' })
    await assert.rejects(call({ op: 'move', path: 'a.txt', to: 'b.txt' }), (e) => e.code === 'EEXIST' && /already exists: b\.txt/.test(e.message))
    assert.equal(await call({ op: 'readText', path: 'b.txt' }), 'B')
    await call({ op: 'move', path: 'a.txt', to: 'new/deep/a.txt' })
    assert.equal(await call({ op: 'readText', path: 'new/deep/a.txt' }), 'A')
    assert.equal(await call({ op: 'readText', path: 'a.txt' }), null)
    await assert.rejects(call({ op: 'move', path: 'new', to: 'new/inside' }), /into itself/)
    await call({ op: 'move', path: 'new', to: 'moved' })
    assert.equal(await call({ op: 'readText', path: 'moved/deep/a.txt' }), 'A')
    await assert.rejects(call({ op: 'move', path: 'ghost.txt', to: 'g2.txt' }))
    await call({ op: 'move', path: 'b.txt', to: 'b.txt' }) // 同一处:什么都不做
  })

  await test('usage 算整个插件文件夹(两层),cache = 根上的 cache/ + 每个 vaults/<key>/cache/;clearCache 只清它们并回新的 usage', async () => {
    const { fs, call } = setup()
    assert.deepEqual(await call({ op: 'usage' }), { bytes: 0, cacheBytes: 0 })
    await call({ op: 'write', path: 'keep.txt', data: '12345' }) // 5
    await call({ op: 'write', path: 'cache/a.bin', data: new Uint8Array(10) }) // 10 cache
    await call({ op: 'write', path: 'sub/cache/not-cache.bin', data: new Uint8Array(3) }) // 3(嵌套的 cache 不算)
    await call({ vault: '/vault', op: 'write', path: 'v.txt', data: 'vv' }) // 2
    await call({ vault: '/vault', op: 'write', path: 'cache/t.png', data: new Uint8Array(20) }) // 20 cache
    assert.deepEqual(await call({ op: 'usage' }), { bytes: 40, cacheBytes: 30 })
    assert.deepEqual(await call({ op: 'clearCache' }), { bytes: 10, cacheBytes: 0 })
    assert.equal(await call({ op: 'readText', path: 'keep.txt' }), '12345')
    assert.equal(await call({ vault: '/vault', op: 'readText', path: 'v.txt' }), 'vv')
    assert.equal(fs.files.has(`${ROOT}/cache/a.bin`), false)
    assert.equal(await call({ op: 'reveal' }), false) // 手机上没有文件管理器
    assert.equal(await call({ op: 'hostPath', path: 'tools' }), null) // 手机上没有本机托管引擎
    await assert.rejects(call({ op: 'hostPath', path: '../x' }), TypeError) // 不合法照样拒,和桌面一致
    await assert.rejects(call({ op: 'hostPath', path: 'vaults/x' }), TypeError)
    await assert.rejects(call({ op: 'bogus' }), /Unknown plugin storage op/)
  })

  await test('叫 cache 的普通文件不算缓存、clearCache 不删;vaults 是文件时不往下看;库分区里的 cache 文件同理', async () => {
    const { fs, call, host } = setup()
    await call({ op: 'write', path: 'cache', data: '1234' }) // 4,普通文件
    await call({ vault: '/vault', op: 'write', path: 'cache', data: '12' }) // 2,普通文件
    await call({ vault: '/vault', op: 'write', path: 'x.txt', data: '1' }) // 1
    assert.deepEqual(await call({ op: 'usage' }), { bytes: 7, cacheBytes: 0 })
    assert.deepEqual(await call({ op: 'clearCache' }), { bytes: 7, cacheBytes: 0 })
    assert.equal(await call({ op: 'readText', path: 'cache' }), '1234')
    assert.equal(await call({ vault: '/vault', op: 'readText', path: 'cache' }), '12')
    // 别的插件:根上 vaults 是个文件(不该有,但盘上就是这样)→ usage / clearCache 不往里列、不抛
    await put(fs, `${PLUGIN_STORAGE_DIR}/other/vaults`, 'odd')
    await put(fs, `${PLUGIN_STORAGE_DIR}/other/cache/c.bin`, new Uint8Array(5))
    const other = (req) => host.handle({ id: 'other', ...req })
    assert.deepEqual(await other({ op: 'usage' }), { bytes: 8, cacheBytes: 5 })
    assert.deepEqual(await other({ op: 'clearCache' }), { bytes: 3, cacheBytes: 0 })
    assert.equal(text(fs, `${PLUGIN_STORAGE_DIR}/other/vaults`), 'odd')
  })

  // ── import(复制进来) ──────────────────────────────────────────────────────
  const seedVault = async (fs) => {
    await put(fs, 'vault/Plugins/demo/data.json', '{"old":true}')
    await put(fs, 'vault/Plugins/demo/.cache/idx.bin', new Uint8Array([1, 2, 3])) // 点开头的也要搬
    await put(fs, 'vault/Plugins/demo/sub/b.txt', 'b')
    await put(fs, 'vault/Other/secret.md', 'no')
  }
  const imp = (o) => ({ op: 'import', vault: '/vault', from: 'Plugins/demo', to: 'legacy', migration: 'm1', allowed: ['Plugins/demo', 'Work/Demo'], into: 'app', ...o })
  const logPath = (m) => `${ROOT}/vaults/${VKEY()}/.forsion-imports/${m}.json`

  await test('import:逐个文件复制(含点开头的)、写完成记录;同一个迁移再来 → already-done(当初的数)', async () => {
    const { fs, call } = setup()
    await seedVault(fs)
    const r = await call(imp())
    assert.deepEqual(r, { status: 'complete', copied: 3, skipped: [] })
    assert.equal(text(fs, `${ROOT}/legacy/data.json`), '{"old":true}')
    assert.deepEqual([...fs.files.get(`${ROOT}/legacy/.cache/idx.bin`).bytes], [1, 2, 3])
    assert.equal(text(fs, `${ROOT}/legacy/sub/b.txt`), 'b')
    assert.equal(text(fs, 'vault/Plugins/demo/data.json'), '{"old":true}') // 原件不动
    const log = JSON.parse(text(fs, logPath('m1')))
    assert.equal(log.status, 'complete'); assert.equal(log.copied, 3); assert.equal(log.from, 'Plugins/demo'); assert.equal(log.into, 'app')
    assert.deepEqual(await call(imp()), { status: 'already-done', copied: 3, skipped: [] })
    // 完成记录不在跟应用那一层露面,在库那一层的根上也藏着
    assert.deepEqual((await call({ vault: '/vault', op: 'list' })).map((e) => e.name), [])
    assert.deepEqual(tmpLeft(fs), [])
  })

  await test('import:目标已有且内容不同 → 不覆盖、进 skipped;内容相同 → 算复制过;into vault 落在库那一层', async () => {
    const { fs, call } = setup()
    await seedVault(fs)
    await call({ op: 'write', path: 'legacy/data.json', data: '{"mine":1}' })
    await call({ op: 'write', path: 'legacy/sub/b.txt', data: 'b' })
    const r = await call(imp({ migration: 'm2' }))
    assert.deepEqual(r, { status: 'complete', copied: 2, skipped: ['legacy/data.json'] })
    assert.equal(await call({ op: 'readText', path: 'legacy/data.json' }), '{"mine":1}')
    assert.deepEqual(JSON.parse(text(fs, logPath('m2'))).skipped, ['legacy/data.json'])
    const v = await call(imp({ migration: 'm3', into: 'vault', to: '' }))
    assert.deepEqual(v, { status: 'complete', copied: 3, skipped: [] })
    assert.equal(await call({ vault: '/vault', op: 'readText', path: 'data.json' }), '{"old":true}')
    // 单个文件:要给目标文件路径
    await assert.rejects(call(imp({ migration: 'm4', from: 'Plugins/demo/data.json', to: '' })), /target file path/)
    assert.deepEqual(await call(imp({ migration: 'm5', from: 'Plugins/demo/data.json', to: 'one.json' })), { status: 'complete', copied: 1, skipped: [] })
    assert.equal(await call({ op: 'readText', path: 'one.json' }), '{"old":true}')
  })

  await test('import:来源不在 → missing、不记;来源不在本插件文件夹 / 迁移 id 坏 / 库换了 → reject', async () => {
    const { fs, call, state } = setup()
    await seedVault(fs)
    assert.deepEqual(await call(imp({ from: 'Work/Demo' })), { status: 'missing', copied: 0, skipped: [] })
    assert.equal(fs.files.has(logPath('m1')), false)
    await assert.rejects(call(imp({ from: 'Other' })), /working folder/)
    await assert.rejects(call(imp({ from: 'Plugins/demo-evil' })), /working folder/)
    await assert.rejects(call(imp({ from: 'Plugins/demo/../../Other' })), TypeError)
    await assert.rejects(call(imp({ migration: 'Bad Id' })), /Invalid migration id/)
    await assert.rejects(call(imp({ migration: '' })), /Invalid migration id/)
    await assert.rejects(call(imp({ to: 'vaults/x' })), /reserved/)
    state.root = '/other'
    await assert.rejects(call(imp()), /Vault changed/)
    assert.equal([...fs.files.keys()].some((k) => k.startsWith(`${ROOT}/legacy`)), false)
  })

  await test('import:完成记录只有「确实没有」才从头做;坏 JSON / null / {} / 别的状态 / 读不出来 → reject、什么都不拷', async () => {
    const { fs, call } = setup()
    await seedVault(fs)
    for (const bad of ['{"status":"partial"', 'null', '{}', '{"status":"partial"}', '"complete"', '[]']) {
      await put(fs, logPath('m1'), bad)
      await assert.rejects(call(imp()), /not complete/, bad)
    }
    fs.failRead.add(logPath('m1'))
    await assert.rejects(call(imp()), /EIO/)
    assert.equal([...fs.files.keys()].some((k) => k.startsWith(`${ROOT}/legacy`)), false)
  })

  await test('import:复制中途读源失败 → reject、不记完成;下一趟照常,已拷的那份算复制过', async () => {
    const { fs, call } = setup()
    await seedVault(fs)
    fs.failRead.add('vault/Plugins/demo/sub/b.txt')
    await assert.rejects(call(imp()), /EIO/)
    assert.equal(fs.files.has(logPath('m1')), false)
    fs.failRead.clear()
    assert.deepEqual(await call(imp()), { status: 'complete', copied: 3, skipped: [] })
    assert.deepEqual(tmpLeft(fs), [])
  })

  await test('import:落点第一段撞宿主保留名 → 不写、进 skipped(跟应用那层 vaults 不分大小写;库那层 .forsion-imports)', async () => {
    const { fs, call } = setup()
    await put(fs, 'vault/Plugins/demo/vaults/x.txt', 'x')
    await put(fs, 'vault/Plugins/demo/VAULTS/y.txt', 'y')
    await put(fs, 'vault/Plugins/demo/.forsion-imports/z.json', '{"status":"complete"}')
    await put(fs, 'vault/Plugins/demo/keep.txt', 'k')
    const app = await call(imp({ to: '', migration: 'r1' }))
    assert.deepEqual({ ...app, skipped: [...app.skipped].sort() }, { status: 'complete', copied: 2, skipped: ['VAULTS/y.txt', 'vaults/x.txt'] })
    assert.equal(fs.files.has(`${ROOT}/vaults/x.txt`), false)
    assert.equal(fs.files.has(`${ROOT}/VAULTS/y.txt`), false)
    assert.equal(await call({ op: 'readText', path: '.forsion-imports/z.json' }), '{"status":"complete"}') // 跟应用那层不是保留名
    const v = await call(imp({ to: '', migration: 'r2', into: 'vault' }))
    assert.deepEqual(v.skipped, ['.forsion-imports/z.json'])
    assert.equal(v.copied, 3)
    assert.equal(fs.files.has(`${ROOT}/vaults/${VKEY()}/.forsion-imports/z.json`), false)
    assert.equal(await call({ vault: '/vault', op: 'readText', path: 'keep.txt' }), 'k')
    // 目标路径本身撞保留名:当场拒
    await assert.rejects(call(imp({ to: 'Vaults/sub', migration: 'r3' })), TypeError)
    await assert.rejects(call(imp({ to: '.forsion-imports', migration: 'r4', into: 'vault' })), TypeError)
  })

  await test('import:入参在入口当场取 —— 调用后改调用方的对象(from / allowed)不影响这次复制', async () => {
    const { fs, call, host } = setup({ vaultRoot: (() => { let k = 0; return (st) => (k++ === 0 ? new Promise((r) => setTimeout(() => r(st.root), 20)) : st.root) })() })
    await seedVault(fs)
    const first = call({ vault: '/vault', op: 'write', path: 'first.txt', data: '1' }) // 让 import 排在后面
    const req = { id: 'demo', ...imp({ migration: 'snap' }) }
    const p = host.handle(req) // 原对象直接递过去(桥就是这么递的)
    req.from = 'Other'; req.allowed.push('Other'); req.migration = 'evil'; req.to = 'stolen'
    await first
    assert.deepEqual(await p, { status: 'complete', copied: 3, skipped: [] })
    assert.equal(fs.files.has(`${ROOT}/stolen/secret.md`), false)
    assert.ok(fs.files.has(logPath('snap')))
  })

  await test('import:云端库(宿主读不到它的文件)→ 明确拒绝,什么都不写', async () => {
    const { fs, call, state } = setup({ root: 'cloud://v9' })
    await seedVault(fs)
    const before = fs.files.size
    await assert.rejects(call(imp({ vault: 'cloud://v9' })), /importFromVault is not available on this host/)
    assert.equal(fs.files.size, before)
    state.root = 'cloud://v9'
  })

  await test('url():同步;基址没拿到 → null;按段百分号编码;坏 id / 越界 → null;库那一层的前缀照收', async () => {
    const { host, state } = setup()
    assert.equal(host.url('demo', 'a.png'), null)
    state.base = 'https://localhost/_capacitor_file_/data/user/0/app/files/plugin-data'
    assert.equal(host.url('demo', 'img/封面 #1.png'), `${state.base}/demo/img/${encodeURIComponent('封面 #1.png')}`)
    assert.equal(host.url('demo', `vaults/${VKEY()}/cache/t.png`), `${state.base}/demo/vaults/${VKEY()}/cache/t.png`)
    assert.equal(host.url('../x', 'a.png'), null)
    assert.equal(host.url('demo', '../x.png'), null)
    assert.equal(host.url('demo', ''), null)
    assert.equal(host.url('demo', '/a.png'), null)
  })

  const failed = results.filter(([, ok]) => !ok)
  console.log(`\n${results.length - failed.length}/${results.length} passed`)
  process.exit(failed.length ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
