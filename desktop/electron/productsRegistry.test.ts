import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, promises as fs, rmSync } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { PRODUCT_SIDECAR } from '../shared/products'
import { detectKind, ensureProduct, getProduct, isProductId, scanProducts, updateProduct } from './productsRegistry'

let home: string
let root: string // 托管根(~/Forsion/Project 的替身)
beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'products-registry-')))
  root = path.join(home, 'Project')
  await fs.mkdir(root)
})
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true })
})

async function project(name: string, files: Record<string, string> = {}): Promise<string> {
  const dir = path.join(root, name)
  await fs.mkdir(dir, { recursive: true })
  for (const [relative, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(dir, relative)), { recursive: true })
    await fs.writeFile(path.join(dir, relative), content)
  }
  return dir
}
const sidecarFile = (dir: string): string => path.join(dir, PRODUCT_SIDECAR)
const sidecarOf = async (dir: string): Promise<Record<string, unknown>> => JSON.parse(await fs.readFile(sidecarFile(dir), 'utf8'))
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms) })

/** 本机的卷是不是大小写不敏感(macOS APFS / NTFS 默认是,APFS 也能格成敏感的)。 */
const CASE_INSENSITIVE_VOLUME = ((): boolean => {
  const probe = mkdtempSync(path.join(os.tmpdir(), 'products-case-'))
  try {
    mkdirSync(path.join(probe, 'demo'))
    return existsSync(path.join(probe, 'DEMO'))
  } catch { return false } finally { rmSync(probe, { recursive: true, force: true }) }
})()

describe('产物身份(sidecar)', () => {
  it('铸一次身份,重复 ensure 不重写,改文件夹名后 id 不变', async () => {
    const dir = await project('demo', { 'index.html': '<h1>hi</h1>' })
    const first = await ensureProduct(root, dir)
    expect(isProductId(first.id)).toBe(true)
    expect(first).toMatchObject({ kind: 'web', entry: 'index.html', name: 'demo', root: dir, published: false })
    const raw = await sidecarOf(dir)
    expect(raw).toMatchObject({ version: 1, id: first.id, createdAt: first.createdAt })

    const before = (await fs.stat(sidecarFile(dir))).mtimeMs
    const again = await ensureProduct(root, dir)
    expect(again.id).toBe(first.id)
    expect(again.createdAt).toBe(first.createdAt)
    expect((await fs.stat(sidecarFile(dir))).mtimeMs).toBe(before) // 已有身份 → 一个字节都不该重写

    const renamed = path.join(root, 'demo-renamed')
    await fs.rename(dir, renamed)
    const list = await scanProducts(root)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ id: first.id, name: 'demo-renamed', root: renamed })
  })

  it('发布标记如实反映', async () => {
    const dir = await project('shipped', { 'index.html': 'x', '.forsion-connect.json': '{}' })
    expect((await ensureProduct(root, dir)).published).toBe(true)
  })

  it('⚠️sidecar 里的 devLoad 一律不认:项目目录不可信,「以插件权限执行这个目录」的授权不能住在里面', async () => {
    // 克隆 / 解压来的文件夹自带一份写好的 sidecar —— 注册表保住它的 id,但绝不把 devLoad 透出去。
    const dir = await project('cloned', { 'manifest.json': JSON.stringify({ id: 'evil', apiVersion: 1, main: 'main.js' }), 'main.js': '' })
    await fs.writeFile(path.join(dir, '.forsion-product.json'), JSON.stringify({ version: 1, id: 'p_0123456789ab', createdAt: 1, devLoad: true }))
    const product = await ensureProduct(root, dir)
    expect(product).toMatchObject({ id: 'p_0123456789ab', kind: 'plugin' })
    expect(product.devLoad).toBeUndefined()
    expect((await scanProducts(root))[0].devLoad).toBeUndefined()
  })

  it('updatedAt 倒序', async () => {
    for (const name of ['a', 'b', 'c']) await project(name, { 'index.html': 'x' })
    await scanProducts(root) // 先让它补完 sidecar(写 sidecar 会顶起目录 mtime)
    const when = (minutes: number): Date => new Date(Date.now() - minutes * 60_000)
    await fs.utimes(path.join(root, 'a'), when(30), when(30))
    await fs.utimes(path.join(root, 'b'), when(10), when(10))
    await fs.utimes(path.join(root, 'c'), when(20), when(20))
    expect((await scanProducts(root)).map((p) => p.name)).toEqual(['b', 'c', 'a'])
  })

  // 重铸 = 销毁身份:快捷方式里的 id 当场断头,预览的 pinned token 换 origin,产物自己的 localStorage 全丢。
  // 所以「解析得出来、id 也是好的」这种 sidecar 一律不许重铸,哪怕 version 是将来的。
  it('version ≥ 1 的 sidecar 保住身份,只有解析不了 / 没 id 的才重铸', async () => {
    const dir = await project('v2', { 'index.html': 'x' })
    const first = await ensureProduct(root, dir)
    await fs.writeFile(sidecarFile(dir), JSON.stringify({ ...(await sidecarOf(dir)), version: 2, future: 'keep' }, null, 2))
    const before = (await fs.stat(sidecarFile(dir))).mtimeMs

    const listed = (await scanProducts(root)).find((p) => p.root === dir)!
    expect(listed.id).toBe(first.id)
    expect(listed.createdAt).toBe(first.createdAt)
    expect(await sidecarOf(dir)).toMatchObject({ version: 2, id: first.id, future: 'keep' })
    expect((await fs.stat(sidecarFile(dir))).mtimeMs).toBe(before) // 一个字节都没动
    // 改名也不该顺手把 version 降回 1(未知字段原样留下,version 也是)
    await updateProduct(root, first.id, { name: 'Kept' })
    expect(await sidecarOf(dir)).toMatchObject({ version: 2, id: first.id, future: 'keep', name: 'Kept' })

    // version 不是数 / < 1 = 身份不齐,照旧重铸
    const zero = await project('v0', { 'index.html': 'x' })
    await fs.writeFile(sidecarFile(zero), JSON.stringify({ version: 0, id: 'p_0123456789ab', createdAt: 1 }))
    const minted = (await scanProducts(root)).find((p) => p.root === zero)!
    expect(minted.id).not.toBe('p_0123456789ab')
    expect(await sidecarOf(zero)).toMatchObject({ version: 1, id: minted.id })
  })
})

describe('判型', () => {
  it('插件三项齐全才算插件,PWA 的 manifest.json 不算', async () => {
    const plugin = await project('my-plugin', {
      'manifest.json': JSON.stringify({ id: 'demo-plugin', version: '1.0.0', apiVersion: 1, main: 'main.js' }),
      'main.js': 'exports.activate = () => {}',
    })
    expect(await detectKind(plugin)).toEqual({ kind: 'plugin', entry: null, pluginId: 'demo-plugin' })
    expect(await ensureProduct(root, plugin)).toMatchObject({ kind: 'plugin', entry: null, pluginId: 'demo-plugin' })

    // ⚠️生效 id 与装载器同一条规则(shared effectivePluginId):清单 id 不合 kebab-case 时退回目录名 —— 两边各判各的话,
    //   「在 Forsion 中加载」重载的是一个装载器压根不认识的 id。
    const dotted = await project('dotted-plugin', {
      'manifest.json': JSON.stringify({ id: 'com.demo.plugin', apiVersion: 1, main: 'main.js' }), 'main.js': '',
    })
    expect((await detectKind(dotted)).pluginId).toBe('dotted-plugin')

    // PWA 清单:有 name/icons/start_url,没有 main/apiVersion —— 判成 web,别当插件加载。
    const pwa = await project('pwa-app', {
      'manifest.json': JSON.stringify({ name: 'PWA', short_name: 'PWA', start_url: '/', display: 'standalone', icons: [] }),
      'index.html': '<h1>pwa</h1>',
    })
    expect(await detectKind(pwa)).toEqual({ kind: 'web', entry: 'index.html' })
    // 只缺 apiVersion 也不算(id + main 齐全)
    const half = await project('half-plugin', { 'manifest.json': JSON.stringify({ id: 'x', main: 'main.js' }) })
    expect((await detectKind(half)).kind).toBe('unknown')
    // 坏掉的 json 不抛
    const broken = await project('broken-manifest', { 'manifest.json': '{oops' })
    expect(await detectKind(broken)).toEqual({ kind: 'unknown', entry: null })
  })

  it('入口 html:根 index.html > 子目录 index.html > 字典序第一个;跳过 dot/依赖目录与过深层级', async () => {
    const rooted = await project('rooted', { 'index.html': 'x', 'app/index.html': 'y' })
    expect((await detectKind(rooted)).entry).toBe('index.html')

    const nested = await project('nested', { 'docs/about.html': 'x', 'app/index.html': 'y' })
    expect(await detectKind(nested)).toEqual({ kind: 'web', entry: 'app/index.html' })

    const loose = await project('loose', { 'zz.html': 'z', 'aa.htm': 'a' })
    expect((await detectKind(loose)).entry).toBe('aa.htm')

    const skipped = await project('skipped', { 'node_modules/pkg/index.html': 'x', 'dist/index.html': 'y', '.cache/index.html': 'z' })
    expect(await detectKind(skipped)).toEqual({ kind: 'unknown', entry: null })

    const deep = await project('deep', { 'a/b/c/d/index.html': 'x' })
    expect((await detectKind(deep)).kind).toBe('unknown')

    const plain = await project('plain', { 'README.md': '# hi' })
    expect(await detectKind(plain)).toEqual({ kind: 'unknown', entry: null })
  })

  // 浅搜预算记在**目录**上:根目录下一堆素材文件(生成式项目的常态)不该把额度烧光 ——
  // 烧光了这个项目就判成 unknown,用户点不开,界面上还没有任何理由。
  it('根目录下几百个非 html 文件,照样找得到子目录里的入口', async () => {
    const dir = await project('assets-heavy', { 'zapp/index.html': '<h1>go</h1>' })
    await Promise.all(Array.from({ length: 500 }, (_, i) => fs.writeFile(path.join(dir, `a${String(i).padStart(4, '0')}.txt`), 'x')))
    expect(await detectKind(dir)).toEqual({ kind: 'web', entry: 'zapp/index.html' })
    expect((await ensureProduct(root, dir)).entry).toBe('zapp/index.html')
  })

  it('目录数仍有硬顶:超宽的树扫到额度就收手', async () => {
    const dir = await project('too-wide')
    await Promise.all(Array.from({ length: 500 }, (_, i) => fs.mkdir(path.join(dir, `d${String(i).padStart(3, '0')}`))))
    await fs.writeFile(path.join(dir, 'd499', 'index.html'), 'x') // 排在 400 个目录的额度之外
    expect(await detectKind(dir)).toEqual({ kind: 'unknown', entry: null })
  })

  it('显式 kind / entry 赢过判型;entry 没了退回判型', async () => {
    const dir = await project('mixed', { 'index.html': 'x', 'pages/app.html': 'y' })
    const product = await ensureProduct(root, dir)
    expect(product.entry).toBe('index.html')
    expect((await updateProduct(root, product.id, { entry: 'pages/app.html' })).entry).toBe('pages/app.html')
    expect((await getProduct(root, product.id))?.entry).toBe('pages/app.html')

    await fs.rm(path.join(dir, 'pages/app.html'))
    expect((await getProduct(root, product.id))?.entry).toBe('index.html') // 落盘没了 → 退回判型

    const forced = await updateProduct(root, product.id, { kind: 'unknown' })
    expect(forced.kind).toBe('unknown')
    expect(forced.entry).toBeNull() // 不是 web 了,判型出来的 html 就不该再当入口
  })

  it('pluginId 跟生效后的 kind 走;没有清单不许标成 plugin', async () => {
    const plugin = await project('kind-plugin', {
      'manifest.json': JSON.stringify({ id: 'demo-kind', apiVersion: 1, main: 'main.js' }),
      'main.js': 'x',
    })
    const p = await ensureProduct(root, plugin)
    expect(p.pluginId).toBe('demo-kind')
    const asWeb = await updateProduct(root, p.id, { kind: 'web' })
    expect(asWeb.kind).toBe('web')
    expect(asWeb.pluginId).toBeUndefined() // 已经不是插件了,别再挂着插件 id
    expect((await getProduct(root, p.id))?.pluginId).toBeUndefined()
    expect((await updateProduct(root, p.id, { kind: 'plugin' })).pluginId).toBe('demo-kind') // 改回去就回来

    // 没有 manifest.json 的目录标成 plugin = 造出一个没有 pluginId 的「插件」,下游全拿 undefined
    const web = await project('kind-web', { 'index.html': 'x' })
    const w = await ensureProduct(root, web)
    await expect(updateProduct(root, w.id, { kind: 'plugin' })).rejects.toThrow(/plugin manifest/)
    expect(await sidecarOf(web)).not.toHaveProperty('kind')
    expect((await getProduct(root, w.id))?.kind).toBe('web')
  })
})

describe('containment', () => {
  it('软链项目:scan 跳过、ensure 拒绝,而且绝不写进被指向的目录', async () => {
    const outside = path.join(home, 'outside')
    await fs.mkdir(outside)
    await fs.writeFile(path.join(outside, 'index.html'), 'x')
    await fs.symlink(outside, path.join(root, 'linked'))
    await project('real', { 'index.html': 'x' })
    await fs.writeFile(path.join(root, 'loose-file.txt'), 'not a project')
    await project('.hidden', { 'index.html': 'x' })

    expect((await scanProducts(root)).map((p) => p.name)).toEqual(['real'])
    expect(await fs.readdir(outside)).toEqual(['index.html']) // 没跟着软链写 sidecar
    await expect(ensureProduct(root, path.join(root, 'linked'))).rejects.toThrow(/managed project/)
    await expect(ensureProduct(root, path.join(root, '.hidden'))).rejects.toThrow(/managed project/)
    await expect(ensureProduct(root, path.join(root, 'loose-file.txt'))).rejects.toThrow(/managed project/)
  })

  it('越界路径一律拒绝,且不留下任何 sidecar', async () => {
    const outside = path.join(home, 'outside')
    await fs.mkdir(outside)
    await project('app/nested', { 'index.html': 'x' })
    for (const dir of [path.join(root, '..', 'outside'), outside, path.join(root, 'app', 'nested'), root, path.join(root, 'missing')]) {
      await expect(ensureProduct(root, dir)).rejects.toThrow(/managed project/)
    }
    expect(await fs.readdir(outside)).toEqual([])
    expect(await fs.readdir(path.join(root, 'app', 'nested'))).toEqual(['index.html'])
    await expect(ensureProduct(path.join(home, 'no-such-root'), path.join(root, 'app'))).rejects.toThrow()
  })

  // macOS/Windows 的卷大小写不敏感:`<root>/DEMO` 打开的就是磁盘上的 `demo`,containedName 放行,
  // 索引却按 dirent 的 `demo` 记名 —— 精确匹配在这里假性失败,调用方(previewOriginFor)吞掉这一抛
  // 就退到一次性 origin,产物的 localStorage 活不到「启动」。
  it.skipIf(!CASE_INSENSITIVE_VOLUME)('大小写不敏感的卷上,`<root>/DEMO` 找得到磁盘上的 demo', async () => {
    const dir = await project('demo-case', { 'index.html': 'x' })
    const first = await ensureProduct(root, dir)
    const upper = await ensureProduct(root, path.join(root, 'DEMO-CASE'))
    expect(upper.id).toBe(first.id)
    expect(upper.name).toBe('demo-case') // 报磁盘上的大小写,不是调用方给的
    expect(upper.root).toBe(dir)
  })

  // safeEntry 只看字符串,isFile 只 lstat 末端 —— 中间那段软链两道闸都看不见。
  describe('entry 的软链逃逸', () => {
    it('中间目录是软链:updateProduct 拒绝,落盘不留 entry', async () => {
      const secrets = path.join(home, 'secrets')
      await fs.mkdir(secrets)
      await fs.writeFile(path.join(secrets, 'id_rsa.html'), 'PRIVATE KEY')
      const dir = await project('escape-write', { 'index.html': 'x' })
      await fs.symlink(secrets, path.join(dir, 'esc'))
      const { id } = await ensureProduct(root, dir)

      await expect(updateProduct(root, id, { entry: 'esc/id_rsa.html' })).rejects.toThrow(/must stay inside the project/)
      expect(await sidecarOf(dir)).not.toHaveProperty('entry')
      expect((await getProduct(root, id))?.entry).toBe('index.html')
    })

    it('手工塞进来的 sidecar 走同一把闸:逃逸的 entry 忽略,判型接手', async () => {
      const loot = path.join(home, 'loot')
      await fs.mkdir(loot)
      await fs.writeFile(path.join(loot, 'loot.html'), 'secret')
      const dir = await project('escape-read', { 'index.html': 'x' })
      await fs.symlink(loot, path.join(dir, 'pub'))
      // 克隆 / 下载来的模板可以自带 sidecar —— 这条路从来不经过 updateProduct
      await fs.writeFile(sidecarFile(dir), JSON.stringify({ version: 1, id: 'p_aaaaaaaaaaaa', createdAt: 1, entry: 'pub/loot.html' }))

      const product = (await scanProducts(root)).find((p) => p.root === dir)!
      expect(product.id).toBe('p_aaaaaaaaaaaa') // 身份是齐的,不该被重铸
      expect(product.entry).toBe('index.html') // 逃逸的 entry 不作数
    })
  })
})

describe('复制来的项目', () => {
  it('重复 id:老的留着,只有新的那个重铸', async () => {
    // 老的取字典序靠后的名字:纯按名字判的实现会在这里翻车。
    const original = await project('zeta', { 'index.html': 'x' })
    const first = await ensureProduct(root, original)
    await sleep(40) // 拉开目录 birthtime
    const copy = await project('alpha', { 'index.html': 'x' })
    await fs.copyFile(sidecarFile(original), sidecarFile(copy)) // 访达里整个复制 = 连 id/createdAt 一起复制

    const list = await scanProducts(root)
    const zeta = list.find((p) => p.name === 'zeta')!
    const alpha = list.find((p) => p.name === 'alpha')!
    expect(zeta.id).toBe(first.id) // 老的留着
    expect(alpha.id).not.toBe(first.id)
    expect(isProductId(alpha.id)).toBe(true)
    expect((await sidecarOf(original)).id).toBe(first.id) // 只铸了一边
    expect((await sidecarOf(copy)).id).toBe(alpha.id)

    // 判完就稳:再扫一次 / 走 ensure 都不该继续换 id
    const again = await scanProducts(root)
    expect(again.map((p) => p.id).sort()).toEqual([alpha.id, zeta.id].sort())
    expect((await ensureProduct(root, copy)).id).toBe(alpha.id)
    expect(await getProduct(root, first.id)).toMatchObject({ name: 'zeta' })
  })
})

describe('坏 sidecar 与未知字段', () => {
  it('坏掉的 sidecar 当作没有,重铸而不抛', async () => {
    const dir = await project('corrupt', { 'index.html': 'x' })
    await fs.writeFile(sidecarFile(dir), 'not json {')
    const list = await scanProducts(root)
    expect(list).toHaveLength(1)
    expect(isProductId(list[0].id)).toBe(true)
    expect(await sidecarOf(dir)).toMatchObject({ version: 1, id: list[0].id })

    // 能解析但身份不合格(id 形状不对)→ 同样重铸,其余字段留着
    const bad = await project('bad-id', { 'index.html': 'x' })
    await fs.writeFile(sidecarFile(bad), JSON.stringify({ version: 1, id: 'nope', createdAt: 1, name: 'Kept', custom: { keep: 'me' } }))
    const second = (await scanProducts(root)).find((p) => p.root === bad)!
    expect(isProductId(second.id)).toBe(true)
    expect(second.name).toBe('Kept')
    expect(await sidecarOf(bad)).toMatchObject({ custom: { keep: 'me' }, name: 'Kept' })
  })

  it('重写时保留未知字段', async () => {
    const dir = await project('extra', { 'index.html': 'x' })
    const product = await ensureProduct(root, dir)
    await fs.writeFile(sidecarFile(dir), JSON.stringify({ ...(await sidecarOf(dir)), futureField: { a: 1 }, note: 'keep me' }))
    await updateProduct(root, product.id, { name: 'Renamed' })
    expect(await sidecarOf(dir)).toMatchObject({ id: product.id, name: 'Renamed', futureField: { a: 1 }, note: 'keep me' })
  })

  // 名字会被 productShortcut 原样当**落盘文件名**用,而项目目录可以是克隆 / 下载来的:
  // 读这条路必须和 IPC 改名同一把闸,不然 U+202E 能把桌面上的 `x.lnk` 显示成 `x.png`。
  it('sidecar 里不合格的名字退回文件夹名', async () => {
    const dir = await project('folder-name', { 'index.html': 'x' })
    const { id } = await ensureProduct(root, dir)
    const base = await sidecarOf(dir)
    const rtl = String.fromCharCode(0x202e) // U+202E,双向覆写
    const bad: unknown[] = [`report${rtl}gnp.lnk`, `bad${String.fromCharCode(1)}name`, '   ', 'x'.repeat(101), 42, null]
    for (const name of bad) {
      await fs.writeFile(sidecarFile(dir), JSON.stringify({ ...base, name }))
      expect((await getProduct(root, id))?.name).toBe('folder-name')
    }
    await fs.writeFile(sidecarFile(dir), JSON.stringify({ ...base, name: '  好名字 Good  ' }))
    expect((await getProduct(root, id))?.name).toBe('好名字 Good') // 合格的照常用,并且 trim
  })
})

describe('updateProduct 校验', () => {
  it('名字 / 种类非法就抛', async () => {
    const dir = await project('valid', { 'index.html': 'x' })
    const { id } = await ensureProduct(root, dir)
    await expect(updateProduct(root, id, { name: '   ' })).rejects.toThrow(/1-100 characters/)
    await expect(updateProduct(root, id, { name: 'x'.repeat(101) })).rejects.toThrow(/1-100 characters/)
    await expect(updateProduct(root, id, { name: `bad${String.fromCharCode(1)}name` })).rejects.toThrow(/control characters/)
    await expect(updateProduct(root, id, { name: 42 as unknown as string })).rejects.toThrow(/1-100 characters/)
    await expect(updateProduct(root, id, { kind: 'nope' as never })).rejects.toThrow(/Invalid product kind/)
    await expect(updateProduct(root, 'p_000000000000', { name: 'x' })).rejects.toThrow(/Unknown product/)
    await expect(updateProduct(root, 'nonsense', { name: 'x' })).rejects.toThrow(/Invalid product id/)
    expect((await updateProduct(root, id, { name: '  My app  ' })).name).toBe('My app') // 存的是 trim 过的
    expect((await getProduct(root, id))?.name).toBe('My app')
  })

  it('双向覆写字符的名字一律拒绝', async () => {
    const dir = await project('rtl', { 'index.html': 'x' })
    const { id } = await ensureProduct(root, dir)
    for (const code of [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f]) {
      await expect(updateProduct(root, id, { name: `a${String.fromCharCode(code)}b` })).rejects.toThrow(/bidirectional control characters/)
    }
    expect(await sidecarOf(dir)).not.toHaveProperty('name')
    expect((await updateProduct(root, id, { name: '正常名字 ok' })).name).toBe('正常名字 ok') // 别误伤普通文字
  })

  it('entry 出目录 / 不存在 / 不是文件一律拒绝,失败后落盘不变', async () => {
    const dir = await project('entries', { 'index.html': 'x', 'assets/logo.svg': '<svg/>' })
    // ⚠️诱饵放在穿越**真正会落到的地方**(`<root>/entries/../outside.html` = `<root>/outside.html`):
    //   放去 home 下的话两条穿越都是因为「文件不存在」才被拒,语法闸被删掉照样绿 —— 假绿。
    await fs.writeFile(path.join(root, 'outside.html'), 'secret')
    const { id } = await ensureProduct(root, dir)

    const syntax = ['../outside.html', '/abs.html', 'a\\b.html', 'assets/../../outside.html', '', './index.html',
      `index.html${String.fromCharCode(0)}.png`, `in${String.fromCharCode(10)}dex.html`, 'C:/abs.html']
    for (const entry of syntax) {
      await expect(updateProduct(root, id, { entry })).rejects.toThrow(/must be a relative path inside the project/)
    }
    for (const entry of ['missing.html', 'assets']) { // 语法过了,存在性没过 —— 两种拒绝不能混为一谈
      await expect(updateProduct(root, id, { entry })).rejects.toThrow(/is not a file in the project/)
    }
    expect(await fs.readFile(path.join(root, 'outside.html'), 'utf8')).toBe('secret')
    expect(await sidecarOf(dir)).not.toHaveProperty('entry')
    expect((await getProduct(root, id))?.entry).toBe('index.html')

    expect((await updateProduct(root, id, { entry: 'assets/logo.svg' })).entry).toBe('assets/logo.svg') // 存在即可,不限扩展名
    expect((await updateProduct(root, id, { entry: null })).entry).toBe('index.html') // 清空 → 退回判型
    expect(await sidecarOf(dir)).toMatchObject({ entry: null })
  })

  // 空 patch 来自渲染层一次没带字段的往返(productsIpc 里就是 `patch ?? {}`)。
  it('没改动就不写 sidecar,也不把产物顶到栅格最前', async () => {
    const older = await project('older', { 'index.html': 'x' })
    await project('newer', { 'index.html': 'x' })
    await scanProducts(root) // 先补完 sidecar(写 sidecar 会顶起目录 mtime)
    const when = (minutes: number): Date => new Date(Date.now() - minutes * 60_000)
    await fs.utimes(older, when(30), when(30))
    await fs.utimes(path.join(root, 'newer'), when(10), when(10))
    const target = (await scanProducts(root)).find((p) => p.name === 'older')!
    const ino = (await fs.stat(sidecarFile(older))).ino

    const same = await updateProduct(root, target.id, {})
    expect(same.updatedAt).toBe(target.updatedAt)
    expect((await fs.stat(sidecarFile(older))).ino).toBe(ino) // 原子写会换 inode,没换 = 一个字节都没写
    expect((await scanProducts(root)).map((p) => p.name)).toEqual(['newer', 'older'])

    // 值没变的 patch 同理(trim 之后完全相同)
    await updateProduct(root, target.id, { name: 'Older app' })
    const ino2 = (await fs.stat(sidecarFile(older))).ino
    await updateProduct(root, target.id, { name: '  Older app  ' })
    expect((await fs.stat(sidecarFile(older))).ino).toBe(ino2)
  })
})

describe('边界', () => {
  it('托管根不存在 / 不是目录 → 空表;未知 id → null', async () => {
    expect(await scanProducts(path.join(home, 'no-such-root'))).toEqual([])
    const file = path.join(home, 'a-file')
    await fs.writeFile(file, 'x')
    expect(await scanProducts(file)).toEqual([])
    expect(await scanProducts(root)).toEqual([])
    expect(await getProduct(root, 'p_000000000000')).toBeNull()
    expect(await getProduct(root, 'nonsense')).toBeNull()
    expect(await getProduct(path.join(home, 'no-such-root'), 'p_000000000000')).toBeNull()
  })

  it('isProductId', async () => {
    expect(isProductId('p_0123456789ab')).toBe(true)
    for (const v of ['p_0123456789AB', 'p_0123456789ag', 'p_0123456789', 'p_0123456789abc', '0123456789ab', 'p-0123456789ab', '', 42, null, undefined, {}]) {
      expect(isProductId(v)).toBe(false)
    }
  })

  it('并发的 ensure 与 scan 只铸一个 id', async () => {
    const dir = await project('racy', { 'index.html': 'x' })
    const [ensured, listed] = await Promise.all([ensureProduct(root, dir), scanProducts(root)])
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(ensured.id)
    expect((await sidecarOf(dir)).id).toBe(ensured.id)
    expect((await fs.readdir(dir)).filter((n) => n.startsWith(PRODUCT_SIDECAR))).toEqual([PRODUCT_SIDECAR]) // 没留下 tmp
  })
})
