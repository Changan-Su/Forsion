/**
 * 「进造物」宿主半边:建作品文件夹 / 把做好的文件夹复制进托管根。
 *   - 名字清洗(分隔符 / 保留名 / 首尾点)+ 撞名接序号(大小写不敏感)
 *   - 源目录闸:按真实路径必须在 within 里(工作目录里指向别处的软链过不去);根 / 家目录及其上级 / 托管根本身 / 托管根里面 / 托管根的上级
 *   - 复制:不跟软链、跳过 .git / node_modules / 两个作品身份文件(大小写不敏感);超上限不复制;复制失败不留半截目标
 *   (「量完之后源又变大」由复制时逐项计数兜住:fs.cp 的 filter 抛错会中止整次复制,已手动探针实测;计数器与「先量」同一个)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AdoptError, adoptIntoProjects, createCreationDir, safeCreationName } from './productAdopt'

let base: string
let root: string
let home: string
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok' } catch (e) { return e instanceof AdoptError ? e.code : `other: ${(e as Error).message}` } }
const w = (file: string, body = 'x'): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body) }

beforeAll(() => {
  base = mkdtempSync(path.join(tmpdir(), 'forsion-adopt-'))
  home = path.join(base, 'home'); mkdirSync(home)
  root = path.join(home, 'Forsion', 'Project'); mkdirSync(root, { recursive: true })
})
afterAll(() => rmSync(base, { recursive: true, force: true }))

describe('safeCreationName / createCreationDir', () => {
  it('分隔符与控制字符换成 -,去掉首尾的点,保留名改名,空的退回 fallback', () => {
    expect(safeCreationName('番茄钟 / Timer')).toBe('番茄钟 - Timer')
    expect(safeCreationName('..hidden.')).toBe('hidden')
    expect(safeCreationName('CON')).toBe('CON-app')
    expect(safeCreationName('   ', 'my app')).toBe('my app')
    expect(safeCreationName('', '')).toBe('creation')
    expect(safeCreationName('ab\u202Ecd\u200F')).toBe('abcd') // 双向控制符之类的不可见格式字符剥掉
    expect(safeCreationName(`${'a'.repeat(99)}.b`)).toBe('a'.repeat(99)) // 截断落在点上 → 尾点再剥一次
  })

  it('撞名接序号(大小写不敏感),独占创建', async () => {
    const a = await createCreationDir(root, 'Pomodoro')
    const b = await createCreationDir(root, 'pomodoro')
    expect(a.name).toBe('Pomodoro')
    expect(b.name).toBe('pomodoro 2')
    expect(existsSync(b.dir)).toBe(true)
  })
})

describe('adoptIntoProjects', () => {
  it('复制成新作品:不跟软链、跳过 .git / node_modules / 身份文件,原文件夹一个字不动', async () => {
    const src = path.join(home, 'Notes', 'Sessions', 'game')
    w(path.join(src, 'index.html'), '<h1>hi</h1>')
    w(path.join(src, 'js', 'app.js'), 'console.log(1)')
    w(path.join(src, '.git', 'HEAD'), 'ref: refs/heads/main')
    w(path.join(src, 'node_modules', 'x', 'index.js'))
    w(path.join(src, '.forsion-product.json'), '{"id":"p_000000000000"}')
    const secret = path.join(home, '.ssh', 'id_rsa'); w(secret, 'KEY')
    symlinkSync(secret, path.join(src, 'leak.txt'))
    const r = await adoptIntoProjects(root, src, 'Space Game', { home, within: src })
    expect(r).toMatchObject({ name: 'Space Game', files: 2 })
    expect(readFileSync(path.join(r.dir, 'index.html'), 'utf8')).toBe('<h1>hi</h1>')
    expect(existsSync(path.join(r.dir, 'js', 'app.js'))).toBe(true)
    for (const gone of ['.git', 'node_modules', '.forsion-product.json', 'leak.txt']) expect(existsSync(path.join(r.dir, gone)), gone).toBe(false)
    expect(existsSync(path.join(src, '.git', 'HEAD'))).toBe(true) // 源不动
  })

  it('源目录闸:根 / 家目录 / 家目录上级 / 托管根 / 托管根里面 / 托管根上级 → forbidden_source;不存在 / 相对路径 → invalid_source', async () => {
    const within = path.parse(home).root // 这组只测目录闸:within 放到最宽
    for (const bad of [path.parse(home).root, home, path.dirname(home), root, path.join(root, 'Pomodoro'), path.dirname(root)]) {
      expect(await code(adoptIntoProjects(root, bad, 'x', { home, within })), bad).toBe('forbidden_source')
    }
    expect(await code(adoptIntoProjects(root, path.join(home, 'nope'), 'x', { home, within }))).toBe('invalid_source')
    expect(await code(adoptIntoProjects(root, 'relative/dir', 'x', { home, within }))).toBe('invalid_source')
  })

  it('按真实路径限定在 within 里:工作目录里指向别处的软链 → outside;strict 时就是工作目录本身也不行', async () => {
    const cwd = path.join(home, 'Notes', 'Sessions')
    w(path.join(home, 'private', 'secret.txt'))
    symlinkSync(path.join(home, 'private'), path.join(cwd, 'secrets'))
    expect(await code(adoptIntoProjects(root, path.join(cwd, 'secrets'), 'x', { home, within: cwd }))).toBe('outside')
    expect(await code(adoptIntoProjects(root, cwd, 'x', { home, within: cwd, strict: true }))).toBe('outside')
    expect(await code(adoptIntoProjects(root, path.join(cwd, 'game'), 'ok', { home, within: cwd, strict: true }))).toBe('ok')
    w(path.join(cwd, '..draft', 'index.html')) // 名字以 .. 开头的子目录是合法的
    expect(await code(adoptIntoProjects(root, path.join(cwd, '..draft'), 'draft', { home, within: cwd, strict: true }))).toBe('ok')
  })

  it('排除名单不分大小写:.GIT / NODE_MODULES / .Forsion-Connect.json 都不带过去', async () => {
    const src = path.join(home, 'caps')
    w(path.join(src, 'index.html'))
    w(path.join(src, '.GIT', 'HEAD'))
    w(path.join(src, 'NODE_MODULES', 'x.js'))
    w(path.join(src, '.Forsion-Connect.json'), '{"published":true}')
    const r = await adoptIntoProjects(root, src, 'Caps', { home, within: src })
    expect(readdirSync(r.dir)).toEqual(['index.html'])
  })

  it('超上限不复制,托管根里也不留空目录', async () => {
    const src = path.join(home, 'big')
    for (let i = 0; i < 4; i++) w(path.join(src, `f${i}.txt`))
    const before = readdirSync(root).length
    expect(await code(adoptIntoProjects(root, src, 'Big', { home, within: src, limits: { maxFiles: 3, maxBytes: 1024 } }))).toBe('too_large')
    expect(readdirSync(root).length).toBe(before)
  })

  it('名字给空就用源文件夹名', async () => {
    const src = path.join(home, 'weather-widget'); w(path.join(src, 'index.html'))
    expect((await adoptIntoProjects(root, src, '  ', { home, within: src })).name).toBe('weather-widget')
  })
})
