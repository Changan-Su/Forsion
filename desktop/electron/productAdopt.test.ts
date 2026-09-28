/**
 * 「进造物」宿主半边:建作品文件夹 / 原地加入前的目录闸。
 *   - 名字清洗(分隔符 / 保留名 / 首尾点 / 不可见格式字符)+ 撞名接序号(大小写不敏感)
 *   - 目录闸:按真实路径必须在 within 里(工作目录里指向别处的软链过不去);根 / 家目录及其上级 / 托管根本身及其上级拒绝;
 *     托管根的直接子目录本来就是造物(managed);托管根里更深的、与已有外部造物互相嵌套的拒绝(nested)
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { AdoptError, checkAdoptable, createCreationDir, safeCreationName } from './productAdopt'
import { dirIdentity } from './dirIdentity'

const reg = (root: string) => ({ root, dir: dirIdentity(root)! })

let base: string
let root: string
let home: string
const code = async (p: Promise<unknown>): Promise<string> => { try { await p; return 'ok' } catch (e) { return e instanceof AdoptError ? e.code : `other: ${(e as Error).message}` } }
const w = (file: string, body = 'x'): void => { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, body) }

beforeAll(() => {
  base = realpathSync(mkdtempSync(path.join(tmpdir(), 'forsion-adopt-')))
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

describe('checkAdoptable', () => {
  it('普通文件夹 → 真实路径、不是托管的;再加一次(已登记)照样放行', async () => {
    const app = path.join(home, 'code', 'app'); mkdirSync(app, { recursive: true })
    expect(await checkAdoptable(root, app, { within: app, home })).toEqual({ real: app, managed: false })
    expect(await checkAdoptable(root, app, { within: app, home, externals: [reg(app)] })).toEqual({ real: app, managed: false })
  })

  it('按真实路径限定在 within 里:工作目录里指向别处的软链 → outside;strict 时就是工作目录本身也不行;名字以 .. 开头的子目录合法', async () => {
    const cwd = path.join(home, 'Notes', 'Sessions')
    w(path.join(home, 'private', 'secret.txt'))
    mkdirSync(cwd, { recursive: true })
    symlinkSync(path.join(home, 'private'), path.join(cwd, 'secrets'))
    expect(await code(checkAdoptable(root, path.join(cwd, 'secrets'), { within: cwd, home }))).toBe('outside')
    expect(await code(checkAdoptable(root, cwd, { within: cwd, strict: true, home }))).toBe('outside')
    w(path.join(cwd, 'game', 'index.html')); w(path.join(cwd, '..draft', 'index.html'))
    expect(await code(checkAdoptable(root, path.join(cwd, 'game'), { within: cwd, strict: true, home }))).toBe('ok')
    expect(await code(checkAdoptable(root, path.join(cwd, '..draft'), { within: cwd, strict: true, home }))).toBe('ok')
  })

  it('目录闸:根 / 家目录 / 家目录上级 / 托管根 / 托管根上级 → forbidden_source;不存在 / 相对路径 → invalid_source', async () => {
    const within = path.parse(home).root // 这组只测目录闸:within 放到最宽
    for (const bad of [path.parse(home).root, home, path.dirname(home), root, path.dirname(root)]) {
      expect(await code(checkAdoptable(root, bad, { within, home })), bad).toBe('forbidden_source')
    }
    expect(await code(checkAdoptable(root, path.join(home, 'nope'), { within, home }))).toBe('invalid_source')
    expect(await code(checkAdoptable(root, 'relative/dir', { within, home }))).toBe('invalid_source')
  })

  it('托管根的直接子目录本来就是造物(managed);托管根里更深的 → nested', async () => {
    const child = path.join(root, 'Game'); mkdirSync(path.join(child, 'src'), { recursive: true })
    expect(await checkAdoptable(root, child, { within: child, home })).toEqual({ real: child, managed: true })
    expect(await code(checkAdoptable(root, path.join(child, 'src'), { within: child, home }))).toBe('nested')
  })

  it('与已加入的外部造物互相嵌套 → nested(两个预览根盖同一棵树、一个仓套在另一个里)', async () => {
    const outer = path.join(home, 'work', 'site'); const inner = path.join(outer, 'blog'); mkdirSync(inner, { recursive: true })
    expect(await code(checkAdoptable(root, inner, { within: outer, home, externals: [reg(outer)] }))).toBe('nested')
    expect(await code(checkAdoptable(root, outer, { within: outer, home, externals: [reg(inner)] }))).toBe('nested')
    expect(await code(checkAdoptable(root, path.join(home, 'work'), { within: home, home, externals: [reg(inner)] }))).toBe('nested')
  })
})
