/**
 * 造物 IPC 的宿主边界(真文件系统 + 假 ipcMain,不起 Electron):
 *   - 原地加入(products:register):写身份 sidecar + 宿主侧登记;托管根的直接子目录本来就是造物,不登记
 *   - products:isCreation 按目录身份判:别的目录、没登记的目录都不算
 *   - products:trash:外部造物只取消登记(不调 trashItem、文件夹与 sidecar 都在);托管的进废纸篓;
 *     用户确认的动作与宿主重解的情况对不上(期间被挪过位置)→ 拒绝
 *   - git:外部造物还没有仓 → 可手动保存(writable)但不自动存(auto=false);自动提交回 null、不建仓;不是造物的目录只读
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { registerProductsIpc } from './productsIpc'
import { findGit } from './gitHistory'
import { PRODUCT_SIDECAR } from '../shared/products'

type Handler = (e: unknown, ...args: unknown[]) => Promise<unknown>
let handlers: Map<string, Handler>
let home: string
let root: string
let trashItem: ReturnType<typeof vi.fn>
const call = (channel: string, ...args: unknown[]): Promise<any> => handlers.get(channel)!({}, ...args) // eslint-disable-line @typescript-eslint/no-explicit-any
const folder = async (dir: string): Promise<string> => { await fs.mkdir(dir, { recursive: true }); await fs.writeFile(path.join(dir, 'index.html'), '<h1>x</h1>'); return dir }

beforeEach(async () => {
  home = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'products-ipc-')))
  root = path.join(home, 'Forsion', 'Project')
  await fs.mkdir(root, { recursive: true })
  handlers = new Map()
  trashItem = vi.fn(async (p: string) => { await fs.rm(p, { recursive: true, force: true }) })
  registerProductsIpc({
    ipcMain: { handle: (channel: string, fn: Handler) => { handlers.set(channel, fn) } } as never,
    isTrustedSender: () => true,
    projectsRoot: () => root,
    homeDir: () => path.join(home, '.forsion-dev'),
    env: () => process.env,
    isPackaged: false,
    desktopDir: () => home,
    execPath: process.execPath,
    trashItem,
    broadcast: () => {},
  })
})
afterEach(async () => { await fs.rm(home, { recursive: true, force: true }) })

describe('products IPC × 原地加入的外部造物', () => {
  it('原地加入:写身份 sidecar + 宿主侧登记;isCreation 按目录身份判;托管根的直接子目录不登记', async () => {
    const app = await folder(path.join(home, 'code', 'app'))
    const other = await folder(path.join(home, 'code', 'other'))
    expect(await call('products:isCreation', app)).toBe(false)
    const r = await call('products:register', app, app, false)
    expect(r).toMatchObject({ ok: true, dir: app, product: { external: true } })
    expect(existsSync(path.join(app, '.tangu', PRODUCT_SIDECAR))).toBe(true)
    expect(await call('products:isCreation', app)).toBe(true)
    expect(await call('products:isCreation', other)).toBe(false)
    expect((await call('products:list')).map((p: { root: string }) => p.root)).toContain(app)
    const child = await folder(path.join(root, 'game'))
    const m = await call('products:register', child, child, false)
    expect(m.ok && !m.product.external).toBe(true)
    expect(await call('products:isCreation', child)).toBe(true)
    // 目录闸的失败按结果回(IPC 抛错会丢 code)
    expect(await call('products:register', path.join(app, 'nope'), app, false)).toMatchObject({ ok: false, code: 'invalid_source' })
  })

  it('删除:外部造物只取消登记(文件夹与 sidecar 都在,不进废纸篓);托管的进废纸篓;确认的动作对不上 → 拒绝', async () => {
    const app = await folder(path.join(home, 'code', 'app'))
    const { product } = await call('products:register', app, app, false)
    await expect(call('products:trash', product.id, { action: 'trash', dirId: product.dirId })).rejects.toThrow(/changed/) // 确认框说的是「移到废纸篓」,实际是外部的
    await expect(call('products:trash', product.id, 'unregister')).rejects.toThrow(/changed/) // 没带目录身份:不认
    expect(await call('products:trash', product.id, { action: 'unregister', dirId: product.dirId })).toMatchObject({ ok: true, unregistered: true })
    expect(trashItem).not.toHaveBeenCalled()
    expect(existsSync(path.join(app, 'index.html')) && existsSync(path.join(app, '.tangu', PRODUCT_SIDECAR))).toBe(true)
    expect(await call('products:isCreation', app)).toBe(false)

    const child = await folder(path.join(root, 'game'))
    const managed = (await call('products:register', child, child, false)).product
    await expect(call('products:trash', managed.id, { action: 'unregister', dirId: managed.dirId })).rejects.toThrow(/changed/) // 确认框说的是「只移除」,实际会删文件夹
    expect(existsSync(child)).toBe(true)
    // 用户看的是这个目录;确认之前它被挪走、同一个 id 的 sidecar 落进了路径上的另一个文件夹 → 不删那个新来的
    await fs.rename(child, path.join(home, 'moved-away'))
    await folder(child)
    await fs.copyFile(path.join(home, 'moved-away', '.tangu', PRODUCT_SIDECAR), path.join(child, PRODUCT_SIDECAR)) // 旧位置(根目录)照样认
    await expect(call('products:trash', managed.id, { action: 'trash', dirId: managed.dirId })).rejects.toThrow(/changed/)
    expect(existsSync(child)).toBe(true)
    const fresh = (await call('products:list')).find((p: { root: string }) => p.root === child)
    await call('products:trash', fresh.id, { action: 'trash', dirId: fresh.dirId })
    expect(trashItem).toHaveBeenCalledWith(child)
  })

  it.skipIf(!findGit())('git:外部造物还没有仓 → 可手动保存但不自动存;自动提交回 null、不建仓;不是造物的目录只读', async () => {
    const app = await folder(path.join(home, 'code', 'app'))
    await call('products:register', app, app, false)
    expect(await call('codeStudio:gitStatus', app)).toMatchObject({ available: true, state: 'none', writable: true, auto: false })
    expect(await call('codeStudio:gitCommit', app, { name: 'auto', auto: true })).toBeNull()
    expect(existsSync(path.join(app, '.git'))).toBe(false)
    const plain = await folder(path.join(home, 'code', 'plain'))
    await expect(call('codeStudio:gitCommit', plain, { name: 'x', auto: false })).rejects.toThrow(/read-only/)
    expect(await call('codeStudio:gitStatus', plain)).toMatchObject({ writable: false, auto: false })
  })
})
