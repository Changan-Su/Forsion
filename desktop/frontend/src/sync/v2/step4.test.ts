// 智库同步第 4 步 U4 的接线与对话框逻辑(不带界面):两层回复里第 4 步通道带的字段、落盘 ⑧、新建 ⑪、停止落盘 ⑩、撤本次新建的空文件夹。
// 撤文件夹的用例用真临时目录,桩的删除是递归删(最坏的宿主):挡住误删的只能是逻辑里的判断。
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { normalizeReply, type VsResult } from './client'
import { discardCreatedFolder, type CreatedFolderHost } from './createdFolder'
import {
  checkDownload, classifyDownloadCheck, downloadBlock, downloadEntry, downloadFolderName, downloadPreviewHandoff, downloadSettled, downloadTargetPath,
  parseDownloadPreview, runDownload, type DownloadDeps, type DownloadLibrary,
} from './download'
import { checkNewVaultName, runCreateVault, uploadOption, type CreateVaultDeps } from './createVault'
import { classifyUnbind, runStopLanding, stopPreflight } from './stopLanding'
import { downloadPreviewFocus, parseSyncFocus } from './openSyncSettings'
import { VAULT_SYNC_CHANNELS as CH, type CreateOk, type DownloadCheckOk, type DownloadOk, type LibrariesValue, type LibraryInfo, type UnbindOk, type VaultSyncPreviewArgs } from './types'
import type { Pending } from '../../components/SyncSettings'

// ── 夹具 ──
let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'u4-step4-')) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

/** 宿主桩:真文件系统;removeEmptyDir 故意是递归删(最坏的宿主),只有逻辑里的判断能挡住误删。 */
function folderHost(over: Partial<CreatedFolderHost> & { bound?: string[] | null } = {}): CreatedFolderHost & { forgot: string[]; removed: string[] } {
  const forgot: string[] = [], removed: string[] = []
  return {
    forgot, removed,
    isEmptyDir: async (root) => { try { return readdirSync(root).length === 0 } catch { return null } },
    boundRoots: async () => (over.bound === undefined ? [] : over.bound),
    inUse: async () => false,
    forgetVault: async (root) => { forgot.push(root); return true },
    removeEmptyDir: async (root) => { removed.push(root); rmSync(root, { recursive: true, force: true }) },
    ...over,
  }
}
/** 宿主 vaultCreate 桩:真建文件夹,回 created。 */
function vaultCreateStub(base: string) {
  const calls: Array<{ parent?: string; name: string; existing: string }> = []
  const fn = async (a: { parent?: string; name: string; existing: 'reuse' | 'refuse' }): Promise<{ root: string; created: boolean }> => {
    calls.push(a)
    const root = join(a.parent ?? base, a.name)
    if (existsSync(root)) { if (a.existing === 'refuse') throw new Error("Error invoking remote method 'x': Error: EEXIST: file already exists"); return { root, created: false } }
    mkdirSync(root)
    return { root, created: true }
  }
  return Object.assign(fn, { calls })
}
const lib = (over: Partial<LibraryInfo> = {}): LibraryInfo => ({
  id: 'v-own-1', kind: 'own', vaultId: 'v-own-1', prefix: 'Amadeus/', name: 'Lab', nameKey: 'lab', files: 3, bytes: 1200, updatedAt: null, devices: [], ...over,
})
const libs = (list: LibraryInfo[], stale = false): VsResult<LibrariesValue> => ({ ok: true, value: { list: { generatedAt: '2026-11-28T00:00:00Z', libraries: list }, fetchedAt: 1, stale } })
const okCheck = (over: Partial<DownloadCheckOk> = {}): VsResult<DownloadCheckOk> => ({ ok: true, value: { ok: true, root: join(tmp, 'Lab'), name: 'Lab', kind: 'own', files: 3, bytes: 1200, freeBytes: 10_000, state: 'new', ...over } })
const LAB: DownloadLibrary = { id: 'v-own-1', kind: 'own', name: 'Lab' }

// ── 两层回复 ──
describe('normalizeReply:第 4 步通道(value 里藏着失败,另带字段)', () => {
  it('downloadCheck already_local 带出 root / bindingId;insufficient_space 带出 bytes / freeBytes', () => {
    expect(normalizeReply(CH.downloadCheck, { ok: true, value: { ok: false, error: 'already_local', root: '/v/Lab', bindingId: 'b1' } }))
      .toEqual({ ok: false, error: 'already_local', detail: { root: '/v/Lab', bindingId: 'b1' } })
    expect(normalizeReply(CH.download, { ok: true, value: { ok: false, error: 'insufficient_space', bytes: 5000, freeBytes: 10 } }))
      .toEqual({ ok: false, error: 'insufficient_space', detail: { bytes: 5000, freeBytes: 10 } })
  })
  it('create name_exists 带 libraryId;unbind pending 带三个数', () => {
    expect(normalizeReply(CH.create, { ok: true, value: { ok: false, error: 'name_exists', libraryId: 'v9' } })).toEqual({ ok: false, error: 'name_exists', detail: { libraryId: 'v9' } })
    expect(normalizeReply(CH.unbind, { ok: true, value: { ok: false, error: 'pending', pending: 2, held: 1, failures: 0 } }))
      .toEqual({ ok: false, error: 'pending', detail: { pending: 2, held: 1, failures: 0 } })
  })
  it('类型不对的字段丢掉(空串、负数、小数的计数、字符串的字节数)', () => {
    expect(normalizeReply(CH.downloadCheck, { ok: true, value: { ok: false, error: 'already_local', root: 5, bindingId: '' } })).toEqual({ ok: false, error: 'already_local' })
    expect(normalizeReply(CH.unbind, { ok: true, value: { ok: false, error: 'pending', pending: -1, held: 1.5, failures: '2' } })).toEqual({ ok: false, error: 'pending' })
    expect(normalizeReply(CH.download, { ok: true, value: { ok: false, error: 'insufficient_space', bytes: '9', freeBytes: Number.NaN } })).toEqual({ ok: false, error: 'insufficient_space' })
  })
  it('外层失败也带出码(和带着的字段);内层没有 error 的 ok:false 回 failed', () => {
    expect(normalizeReply(CH.unbind, { ok: false, error: 'state_unreadable' })).toEqual({ ok: false, error: 'state_unreadable' })
    expect(normalizeReply(CH.download, { ok: false, error: 'stale', root: '/v/Lab' })).toEqual({ ok: false, error: 'stale', detail: { root: '/v/Lab' } })
    expect(normalizeReply(CH.create, { ok: true, value: { ok: false } })).toEqual({ ok: false, error: 'failed' })
  })
  it('成功原样:download 的 next:preview、unbind 的 root、downloadCheck 的数字', () => {
    const preview = { root: '/v/Lab', target: { kind: 'penzor', candidate: { kind: 'own', vaultId: 'v1', name: 'Lab' } }, scope: { mode: 'all' } }
    expect(normalizeReply(CH.download, { ok: true, value: { ok: true, next: 'preview', preview } })).toEqual({ ok: true, value: { ok: true, next: 'preview', preview } })
    expect(normalizeReply(CH.unbind, { ok: true, value: { ok: true, root: '/v/Lab' } })).toEqual({ ok: true, value: { ok: true, root: '/v/Lab' } })
  })
  it('libraries:{error} = 读不出(不是空清单);有清单 = 成功', () => {
    expect(normalizeReply(CH.libraries, { ok: true, value: { error: 'libraries_cache_unreadable' } })).toEqual({ ok: false, error: 'libraries_cache_unreadable' })
    const value = { list: { generatedAt: 'x', libraries: [] }, fetchedAt: 1, stale: true }
    expect(normalizeReply(CH.libraries, { ok: true, value })).toEqual({ ok: true, value })
    expect(normalizeReply(CH.libraries, { ok: false, error: 'compat_mode' })).toEqual({ ok: false, error: 'compat_mode' })
  })
  it('老通道的失败形状不变(没有第 4 步字段就不带 detail)', () => {
    expect(normalizeReply(CH.preview, { ok: true, value: { ok: false, error: 'remote_dir_in_use', inUseBy: { bindingId: 'b2', name: 'Archive' } } }))
      .toEqual({ ok: false, error: 'remote_dir_in_use', inUseBy: { bindingId: 'b2', name: 'Archive' } })
  })
})

// ── ⑧ 落盘 ──
describe('落盘 ⑧:路径与入口', () => {
  it('文件夹名 = 库名,默认库用调用方给的(跟界面语言);只换上级', () => {
    expect(downloadFolderName({ kind: 'own', name: 'Lab' }, 'Cloud notes')).toBe('Lab')
    expect(downloadFolderName({ kind: 'default', name: 'My Vault' }, 'Cloud notes')).toBe('Cloud notes')
    expect(downloadTargetPath('/Users/a/Forsion/Vaults', 'Lab')).toBe('/Users/a/Forsion/Vaults/Lab')
    expect(downloadTargetPath('/Users/a/Forsion/Vaults/', 'Lab')).toBe('/Users/a/Forsion/Vaults/Lab')
    expect(downloadTargetPath('D:\\Notes\\', 'Lab')).toBe('D:\\Notes\\Lab')
    expect(downloadTargetPath('/', 'Lab')).toBe('/Lab')
  })
  it('入口:默认库灰(default_unsupported)、不是完整模式灰、没有 libraryId(老 Extend)灰', () => {
    expect(downloadEntry({ kind: 'own', libraryId: 'v1' }, true)).toEqual({ enabled: true })
    expect(downloadEntry({ kind: 'default', libraryId: 'v0' }, true)).toEqual({ enabled: false, reason: 'default_unsupported' })
    expect(downloadEntry({ kind: 'own', libraryId: 'v1' }, false)).toEqual({ enabled: false, reason: 'not_full' })
    expect(downloadEntry({ kind: 'legacy' }, true)).toEqual({ enabled: false, reason: 'no_library_id' })
  })
})

describe('落盘 ⑧:downloadCheck → 对话框状态(每种一条)', () => {
  it('new / empty → 能落;nonempty → 比对两边', () => {
    expect(classifyDownloadCheck(okCheck())).toMatchObject({ kind: 'ready', state: 'new', primary: 'download', canChangeLocation: true, files: 3, bytes: 1200, freeBytes: 10_000 })
    expect(classifyDownloadCheck(okCheck({ state: 'empty', freeBytes: null }))).toMatchObject({ kind: 'ready', state: 'empty', freeBytes: null })
    expect(classifyDownloadCheck(okCheck({ state: 'nonempty', bytes: 99_999 }))).toMatchObject({ kind: 'compare', primary: 'compare' }) // 非空不按整库大小挡
  })
  it('already_local → 同步它…(带这台那份的路径),位置不能换', () => {
    expect(classifyDownloadCheck({ ok: false, error: 'already_local', detail: { root: '/v/Lab', bindingId: 'b1' } }))
      .toEqual({ kind: 'already_local', root: '/v/Lab', bindingId: 'b1', primary: 'sync_existing', canChangeLocation: false })
  })
  it('空间不够 → 挡住、带数字、能换位置;回包自相矛盾(bytes > freeBytes 却 ok)也挡', () => {
    expect(classifyDownloadCheck({ ok: false, error: 'insufficient_space', detail: { bytes: 5000, freeBytes: 10 } }))
      .toEqual({ kind: 'blocked', group: 'space', code: 'insufficient_space', bytes: 5000, freeBytes: 10, primary: 'none', canChangeLocation: true })
    expect(classifyDownloadCheck(okCheck({ bytes: 20_000, freeBytes: 10 }))).toMatchObject({ kind: 'blocked', group: 'space' })
  })
  it('嵌套四种同一种挡法、码各自留着', () => {
    for (const code of ['root_nested', 'primary_exists', 'mirror_root', 'folder_target_nested']) {
      expect(classifyDownloadCheck({ ok: false, error: code })).toEqual({ kind: 'blocked', group: 'nested', code, primary: 'none', canChangeLocation: true })
    }
  })
  it('旧同步占着(entry_sync_active / 原来的网盘同步)→ 去设置的出口,也能换位置', () => {
    expect(classifyDownloadCheck({ ok: false, error: 'entry_sync_active' })).toEqual({ kind: 'blocked', group: 'legacy_sync', code: 'entry_sync_active', primary: 'open_settings', canChangeLocation: true })
    expect(classifyDownloadCheck({ ok: false, error: 'legacy_remote_same_root' })).toMatchObject({ group: 'legacy_sync' })
  })
  it('名字对不上 / 位置不在 / 是文件 / 读不出 → 位置那一类', () => {
    for (const code of ['name_mismatch', 'parent_missing', 'not_a_directory', 'root_unreadable', 'root_missing']) expect(downloadBlock(code)).toMatchObject({ group: 'location', code, canChangeLocation: true })
  })
  it('默认库 → default(不调通道);清单读不出 → list_unreadable;其余(含外层码、带前缀的错误串)→ unavailable,不能换位置', async () => {
    const check = vi.fn()
    expect(await checkDownload({ downloadCheck: check }, { id: 'v0', kind: 'default', name: 'My Vault' }, '/p')).toMatchObject({ group: 'default', code: 'default_unsupported' })
    expect(check).not.toHaveBeenCalled()
    expect(classifyDownloadCheck(okCheck({ kind: 'default' }))).toMatchObject({ group: 'default' })
    expect(downloadBlock('vault_list_unreadable')).toMatchObject({ group: 'list_unreadable', canChangeLocation: false })
    for (const code of ['not_signed_in', 'server_unsupported', 'offline', 'library_not_found', 'state_unreadable', 'compat_mode', 'channel_missing', 'extend_unavailable', 'stale']) {
      expect(downloadBlock(code)).toMatchObject({ kind: 'blocked', group: 'unavailable', code, primary: 'none', canChangeLocation: false })
    }
    expect(downloadBlock("Error invoking remote method 'vaultsync:downloadCheck': Error: state_unreadable")).toMatchObject({ code: 'state_unreadable' })
  })
})

describe('落盘 ⑧:点了主按钮(vaultCreate → download)', () => {
  const deps = (download: DownloadDeps['download'], folder = folderHost(), vc = vaultCreateStub(tmp)) => ({ download: vi.fn(download), vaultCreate: vc, folder })

  it('check 没过不建任何东西', async () => {
    const d = deps(async () => ({ ok: true, value: { ok: true, bindingId: 'b1' } }))
    expect(await runDownload(d, LAB, classifyDownloadCheck({ ok: false, error: 'already_local' }), { parent: tmp, folderName: 'Lab' })).toEqual({ kind: 'not_ready' })
    expect(d.vaultCreate.calls).toHaveLength(0)
    expect(d.download).not.toHaveBeenCalled()
    expect(readdirSync(tmp)).toEqual([])
  })
  it('空的:宿主建好(reuse)→ download 用宿主回的 root → started', async () => {
    const d = deps(async () => ({ ok: true, value: { ok: true, bindingId: 'b7' } }))
    const r = await runDownload(d, LAB, classifyDownloadCheck(okCheck({ root: '/claimed/elsewhere/Lab' })), { parent: tmp, folderName: 'Lab' })
    expect(r).toEqual({ kind: 'started', root: join(tmp, 'Lab'), bindingId: 'b7', created: true })
    expect(d.vaultCreate.calls).toEqual([{ parent: tmp, name: 'Lab', existing: 'reuse' }])
    expect(d.download).toHaveBeenCalledWith('v-own-1', join(tmp, 'Lab'))
  })
  it('非空:回 needs_preview,交接 = SyncSettings 的 Pending 同形(candidate 原样,不按名字重找)', async () => {
    mkdirSync(join(tmp, 'Lab')); writeFileSync(join(tmp, 'Lab', 'a.md'), 'x')
    const preview: VaultSyncPreviewArgs = { root: join(tmp, 'Lab'), target: { kind: 'penzor', candidate: { kind: 'own', vaultId: 'v-own-1', name: 'Lab' } }, scope: { mode: 'all' } }
    const d = deps(async () => ({ ok: true, value: { ok: true, next: 'preview', preview } as DownloadOk }))
    const r = await runDownload(d, LAB, classifyDownloadCheck(okCheck({ state: 'nonempty' })), { parent: tmp, folderName: 'Lab' })
    expect(r).toMatchObject({ kind: 'needs_preview', created: false, preview })
    if (r.kind !== 'needs_preview') throw new Error('x')
    const p: Pending = r.handoff // 类型上能直接交给 runPreview
    expect(p).toEqual({ root: preview.root, name: 'Lab', kind: 'cloud', target: preview.target, scope: { mode: 'all' }, added: [], preview: null })
    expect(downloadPreviewHandoff(preview, 'Lab')).toEqual(p)
  })
  it('download 挡回来:本次新建、仍为空、没有绑定 → 撤掉(移出清单 + 删空目录)', async () => {
    const folder = folderHost()
    const d = deps(async () => ({ ok: false, error: 'primary_exists' }), folder)
    const r = await runDownload(d, LAB, classifyDownloadCheck(okCheck()), { parent: tmp, folderName: 'Lab' })
    expect(r).toMatchObject({ kind: 'blocked', state: { group: 'nested', code: 'primary_exists' }, created: true, cleanup: 'removed' })
    expect(existsSync(join(tmp, 'Lab'))).toBe(false)
    expect(folder.forgot).toEqual([join(tmp, 'Lab')])
  })
  it('download 挡回来、但这期间文件夹里被写进了东西 → 留着,文件一个不少', async () => {
    const folder = folderHost()
    const d = deps(async (_id, root) => { writeFileSync(join(root, 'note.md'), 'keep me'); return { ok: false, error: 'stale' } }, folder)
    const r = await runDownload(d, LAB, classifyDownloadCheck(okCheck()), { parent: tmp, folderName: 'Lab' })
    expect(r).toMatchObject({ kind: 'blocked', cleanup: 'kept_not_empty' })
    expect(readdirSync(join(tmp, 'Lab'))).toEqual(['note.md'])
    expect(folder.removed).toEqual([])
    expect(folder.forgot).toEqual([])
  })
  it('文件夹本来就在(created:false)→ 不撤;有绑定指着它 → 不撤;绑定读不出 → 不撤', async () => {
    mkdirSync(join(tmp, 'Lab'))
    const f1 = folderHost()
    expect(await runDownload(deps(async () => ({ ok: false, error: 'offline' }), f1), LAB, classifyDownloadCheck(okCheck({ state: 'empty' })), { parent: tmp, folderName: 'Lab' }))
      .toMatchObject({ kind: 'blocked', created: false, cleanup: null })
    expect(existsSync(join(tmp, 'Lab'))).toBe(true)
    rmSync(join(tmp, 'Lab'), { recursive: true })
    const f2 = folderHost({ bound: [join(tmp, 'Lab')] })
    expect(await runDownload(deps(async () => ({ ok: true, value: { weird: true } as unknown as DownloadOk }), f2), LAB, classifyDownloadCheck(okCheck()), { parent: tmp, folderName: 'Lab' }))
      .toMatchObject({ kind: 'blocked', state: { code: 'invalid_reply' }, cleanup: 'kept_bound' })
    expect(existsSync(join(tmp, 'Lab'))).toBe(true)
    rmSync(join(tmp, 'Lab'), { recursive: true })
    const f3 = folderHost({ bound: null })
    expect(await runDownload(deps(async () => ({ ok: false, error: 'stale' }), f3), LAB, classifyDownloadCheck(okCheck()), { parent: tmp, folderName: 'Lab' }))
      .toMatchObject({ cleanup: 'kept_bindings_unknown' })
    expect(existsSync(join(tmp, 'Lab'))).toBe(true)
    expect([...f1.removed, ...f2.removed, ...f3.removed]).toEqual([])
  })
  it('宿主没建成 → host_failed,不调 download;宿主回的形状不对 → host_invalid', async () => {
    const d = { download: vi.fn(), vaultCreate: async () => { throw new Error("Error invoking remote method 'amadeus:vaults:create-at': Error: invalid-name") }, folder: folderHost() }
    expect(await runDownload(d, LAB, classifyDownloadCheck(okCheck()), { parent: tmp, folderName: 'Lab' })).toEqual({ kind: 'host_failed', code: 'invalid_name' })
    const d2 = { download: vi.fn(), vaultCreate: async () => ({ root: '' }) as unknown as { root: string; created: boolean }, folder: folderHost() }
    expect(await runDownload(d2, LAB, classifyDownloadCheck(okCheck()), { parent: tmp, folderName: 'Lab' })).toEqual({ kind: 'host_invalid' })
    expect(d.download).not.toHaveBeenCalled()
    expect(d2.download).not.toHaveBeenCalled()
  })
})

describe('落盘 ⑧:跨窗口交给汇总卡(只认 download 会回的那种)', () => {
  const preview: VaultSyncPreviewArgs = { root: '/v/Lab', target: { kind: 'penzor', candidate: { kind: 'legacy', vaultId: 'v0', prefix: 'Amadeus/Lab/' } }, scope: { mode: 'all' } }
  it('parseSyncFocus 认 preview / download,逐字段核', () => {
    expect(parseSyncFocus(downloadPreviewFocus(preview))).toEqual({ root: '/v/Lab', intent: 'preview', preview })
    expect(parseSyncFocus({ intent: 'download', libraryId: 'v1' })).toEqual({ intent: 'download', libraryId: 'v1' })
    expect(parseSyncFocus({ intent: 'download' })).toEqual({}) // 缺 libraryId 不认这个 intent
    expect(parseSyncFocus({ intent: 'preview', root: '/v/Lab', preview: { ...preview, target: { kind: 'penzor', candidate: { kind: 'new' } } } })).toEqual({ root: '/v/Lab' })
    expect(parseSyncFocus({ intent: 'preview', root: '/v/Lab', preview: { ...preview, target: { kind: 'remote', targetId: 'x' } } })).toEqual({ root: '/v/Lab' })
    expect(parseSyncFocus({ intent: 'start', libraryId: 7, preview })).toEqual({ intent: 'start' }) // 别的 intent 不带 preview
  })
  it('parseDownloadPreview 丢掉多余字段、核范围', () => {
    expect(parseDownloadPreview({ ...preview, bindingId: 'b1', extra: 1 })).toEqual(preview)
    expect(parseDownloadPreview({ ...preview, scope: { mode: 'some', items: [{ path: 'A', kind: 'folder' }] } })).toMatchObject({ scope: { mode: 'some' } })
    expect(parseDownloadPreview({ ...preview, scope: { mode: 'some', items: [{ path: 'A', kind: 'x' }] } })).toBeUndefined()
    expect(parseDownloadPreview({ ...preview, root: '' })).toBeUndefined()
  })
})

describe('落盘 ⑧:下完了没有(E4-7 / E4-15)', () => {
  const round = { startedAt: 200, endedAt: 300, completed: true, failures: 0, skipped: 0, held: 0 }
  it('每种一条', () => {
    expect(downloadSettled({ lastRound: round }, 100)).toBe('settled')
    expect(downloadSettled({ firstRound: 'pair', lastRound: round }, 100)).toBe('first_round')
    expect(downloadSettled({ lastRound: null }, 100)).toBe('no_round')
    expect(downloadSettled({}, 100)).toBe('no_round') // 老 Extend 不给
    expect(downloadSettled({ lastRound: round }, 200)).toBe('round_before_seal')
    expect(downloadSettled({ lastRound: { ...round, completed: false } }, 100)).toBe('incomplete')
    expect(downloadSettled({ lastRound: { ...round, failures: 1 } }, 100)).toBe('failures')
    expect(downloadSettled({ lastRound: { ...round, skipped: 2 } }, 100)).toBe('skipped')
    expect(downloadSettled({ lastRound: { ...round, held: -1 } }, 100)).toBe('held') // 读不出当有
  })
})

// ── ⑪ 新建 ──
describe('新建 ⑪:上传到云端那个勾', () => {
  const get = { serverCaps: { vaults: true, realMove: false } }
  it('登录 + 完整模式 + 服务器支持多个库才缺省勾上,否则灰掉写原因', () => {
    expect(uploadOption({ mode: 'full', signedIn: true, get })).toEqual({ available: true, defaultChecked: true })
    expect(uploadOption({ mode: 'full', signedIn: false, get })).toMatchObject({ available: false, reason: 'not_signed_in' })
    expect(uploadOption({ mode: 'full', signedIn: null, get })).toMatchObject({ available: false, reason: 'not_signed_in' })
    expect(uploadOption({ mode: 'full', signedIn: true, get: { serverCaps: { vaults: false, realMove: false } } })).toMatchObject({ available: false, reason: 'server_unsupported' })
    expect(uploadOption({ mode: 'legacy', signedIn: true, get })).toMatchObject({ available: false, reason: 'not_full' })
    expect(uploadOption({ mode: 'unknown', signedIn: true, get })).toMatchObject({ available: false, reason: 'unknown' })
    expect(uploadOption({ mode: 'full', signedIn: true, get: null })).toMatchObject({ available: false, reason: 'unknown' })
  })
})

describe('新建 ⑪:边打字边判(清单缓存,只做提示)', () => {
  const list = libs([lib(), lib({ id: 'v0:Amadeus/Reading/', kind: 'legacy', vaultId: 'v0', prefix: 'Amadeus/Reading/', name: 'Reading', nameKey: 'reading' }), lib({ id: 'v0', kind: 'default', name: 'My Vault', nameKey: null })])
  it('空 / 不勾 / 没撞 / 撞了 own / 撞了 legacy / 保留名 / 清单读不出', () => {
    expect(checkNewVaultName('  ', true, list)).toEqual({ kind: 'empty' })
    expect(checkNewVaultName('Lab', false, list)).toEqual({ kind: 'clear' })
    expect(checkNewVaultName('Notes', true, list)).toEqual({ kind: 'clear' })
    expect(checkNewVaultName(' LAB ', true, list)).toMatchObject({ kind: 'name_exists', libraryId: 'v-own-1', libraryKind: 'own' })
    expect(checkNewVaultName('reading', true, list)).toMatchObject({ kind: 'name_exists', libraryId: 'v0:Amadeus/Reading/', libraryKind: 'legacy', prefix: 'Amadeus/Reading/' })
    expect(checkNewVaultName('云端笔记', true, list)).toEqual({ kind: 'reserved' })
    expect(checkNewVaultName('Cloud Notes', true, null)).toEqual({ kind: 'reserved' })
    expect(checkNewVaultName('Lab', true, { ok: false, error: 'libraries_cache_unreadable' })).toEqual({ kind: 'unknown' })
    expect(checkNewVaultName('Lab', true, null)).toEqual({ kind: 'unknown' })
    expect(checkNewVaultName('Lab', true, libs([lib()], true))).toMatchObject({ kind: 'name_exists' }) // stale 的照用
  })
})

describe('新建 ⑪:点了「新建」', () => {
  const mk = (create: CreateVaultDeps['create'], folder = folderHost()) => {
    const vc = vaultCreateStub(tmp)
    const open = vi.fn(async () => {})
    return { vaultCreate: vc, create: vi.fn(create), open, folder }
  }
  it('预判撞名:本机什么都不建、不调 create', async () => {
    const d = mk(async () => ({ ok: true, value: { ok: true, bindingId: 'b1' } as CreateOk }))
    expect(await runCreateVault(d, { name: 'lab', upload: true, libraries: libs([lib()]) })).toEqual({ kind: 'name_exists', source: 'cache', libraryId: 'v-own-1', cleanup: null })
    expect(d.vaultCreate.calls).toHaveLength(0)
    expect(d.create).not.toHaveBeenCalled()
    expect(readdirSync(tmp)).toEqual([])
  })
  it('上云成功:建(refuse)→ create → 打开', async () => {
    const d = mk(async () => ({ ok: true, value: { ok: true, bindingId: 'b3' } as CreateOk }))
    expect(await runCreateVault(d, { name: 'Lab', upload: true, libraries: libs([]) })).toEqual({ kind: 'created', root: join(tmp, 'Lab'), upload: 'on', bindingId: 'b3', opened: true })
    expect(d.vaultCreate.calls).toEqual([{ name: 'Lab', existing: 'refuse' }])
    expect(d.create).toHaveBeenCalledWith(join(tmp, 'Lab'))
    expect(d.open).toHaveBeenCalledWith(join(tmp, 'Lab'))
  })
  it('不勾:建、打开,不调 create', async () => {
    const d = mk(async () => ({ ok: true, value: { ok: true, bindingId: 'b3' } as CreateOk }))
    expect(await runCreateVault(d, { name: 'Lab', upload: false })).toEqual({ kind: 'created', root: join(tmp, 'Lab'), upload: 'off', opened: true })
    expect(d.create).not.toHaveBeenCalled()
  })
  it('服务器才说 name_exists:刚建的空文件夹撤掉,不打开;libraryId 带上', async () => {
    const folder = folderHost()
    const d = mk(async () => ({ ok: false, error: 'name_exists', detail: { libraryId: 'v9' } }), folder)
    expect(await runCreateVault(d, { name: 'Lab', upload: true, libraries: null })).toEqual({ kind: 'name_exists', source: 'server', libraryId: 'v9', cleanup: 'removed' })
    expect(existsSync(join(tmp, 'Lab'))).toBe(false)
    expect(folder.forgot).toEqual([join(tmp, 'Lab')])
    expect(d.open).not.toHaveBeenCalled()
  })
  it('服务器才说 name_exists、但文件夹此刻不空了:留着,一个文件不动,回报 kept_not_empty', async () => {
    const folder = folderHost()
    const d = mk(async (root) => { writeFileSync(join(root, 'draft.md'), 'typed meanwhile'); return { ok: false, error: 'name_exists' } }, folder)
    expect(await runCreateVault(d, { name: 'Lab', upload: true })).toEqual({ kind: 'name_exists', source: 'server', cleanup: 'kept_not_empty' })
    expect(readdirSync(join(tmp, 'Lab'))).toEqual(['draft.md'])
    expect(folder.removed).toEqual([])
    expect(folder.forgot).toEqual([])
  })
  it('服务器说保留名:同样撤掉空文件夹;预判保留名:什么都不建', async () => {
    const d = mk(async () => ({ ok: false, error: 'reserved' }))
    expect(await runCreateVault(d, { name: 'Notes', upload: true })).toEqual({ kind: 'name_rejected', code: 'reserved', source: 'server', cleanup: 'removed' })
    expect(existsSync(join(tmp, 'Notes'))).toBe(false)
    const d2 = mk(async () => ({ ok: true, value: { ok: true, bindingId: 'b' } as CreateOk }))
    expect(await runCreateVault(d2, { name: 'Cloud notes', upload: true })).toEqual({ kind: 'name_rejected', code: 'reserved', source: 'cache', cleanup: null })
    expect(d2.vaultCreate.calls).toHaveLength(0)
  })
  it('离线 / 老服务器 / 换了账号 / 准入挡住:本机的库留着、打开,upload = failed 带原码', async () => {
    for (const error of ['offline', 'server_unsupported', 'stale', 'root_nested', "Error invoking remote method 'vaultsync:create': Error: state_unreadable"]) {
      rmSync(join(tmp, 'Lab'), { recursive: true, force: true })
      const folder = folderHost()
      const d = mk(async () => ({ ok: false, error }), folder)
      const r = await runCreateVault(d, { name: 'Lab', upload: true })
      expect(r).toMatchObject({ kind: 'created', upload: 'failed', opened: true })
      expect(existsSync(join(tmp, 'Lab'))).toBe(true)
      expect(folder.removed).toEqual([])
    }
  })
  it('宿主:同名文件夹已在 → host_failed exists(不并进别人的文件夹、不调 create);打开失败照实回', async () => {
    mkdirSync(join(tmp, 'Lab'))
    const d = mk(async () => ({ ok: true, value: { ok: true, bindingId: 'b' } as CreateOk }))
    expect(await runCreateVault(d, { name: 'Lab', upload: true })).toEqual({ kind: 'host_failed', code: 'exists' })
    expect(d.create).not.toHaveBeenCalled()
    const d2 = mk(async () => ({ ok: true, value: { ok: true, bindingId: 'b' } as CreateOk }))
    d2.open.mockRejectedValueOnce(new Error('vault-missing'))
    expect(await runCreateVault(d2, { name: 'Other', upload: false })).toEqual({ kind: 'created', root: join(tmp, 'Other'), upload: 'off', opened: false, openError: 'vault-missing' })
    expect(await runCreateVault(d2, { name: '   ', upload: true })).toEqual({ kind: 'empty_name' })
  })
})

describe('撤本次新建的空文件夹:其余挡法', () => {
  it('读不出是不是空 / 成了当前库 / rmdir 失败(整个留着、照旧在清单里)/ 删了但清单那行没去掉', async () => {
    const root = join(tmp, 'X'); mkdirSync(root)
    expect(await discardCreatedFolder(folderHost({ isEmptyDir: async () => null }), { root, created: true })).toBe('kept_unreadable')
    expect(await discardCreatedFolder(folderHost({ inUse: async () => true }), { root, created: true })).toBe('kept_in_use')
    expect(await discardCreatedFolder(folderHost({ inUse: async () => null }), { root, created: true })).toBe('kept_in_use')
    const noRm = folderHost({ removeEmptyDir: async () => { throw new Error('ENOTEMPTY') } })
    expect(await discardCreatedFolder(noRm, { root, created: true })).toBe('kept_remove_failed')
    expect(noRm.forgot).toEqual([])
    expect(existsSync(root)).toBe(true)
    expect(await discardCreatedFolder(folderHost({ forgetVault: async () => false }), { root, created: true })).toBe('removed_still_listed')
    expect(existsSync(root)).toBe(false)
  })
  it('点开头的文件也算不空', async () => {
    const root = join(tmp, 'Y'); mkdirSync(root); writeFileSync(join(root, '.DS_Store'), '')
    expect(await discardCreatedFolder(folderHost(), { root, created: true })).toBe('kept_not_empty')
    expect(existsSync(join(root, '.DS_Store'))).toBe(true)
  })
})

// ── ⑩ 停止落盘 ──
describe('停止落盘 ⑩:开卡前', () => {
  const status = { phase: 'idle' as const, lastSyncAt: 1, pendingChanges: 0, held: 0, deletesPending: 0, failures: 0 }
  it('干净 → 平时那张;有没传上去的 / 等你定的 → 主按钮先同步再停;数读不出当有;接手中 / 换去处中不能停', () => {
    expect(stopPreflight({ state: 'active', status })).toEqual({ eligible: true, unsynced: 0, held: 0, unknown: false, recommendSyncFirst: false })
    expect(stopPreflight({ state: 'active', status: { ...status, pendingChanges: 2, deletesPending: 1 } })).toMatchObject({ unsynced: 3, recommendSyncFirst: true })
    expect(stopPreflight({ state: 'active', status: { ...status, held: 4 } })).toMatchObject({ held: 4, recommendSyncFirst: true })
    expect(stopPreflight({ state: 'active', status: { ...status, held: -1 } })).toMatchObject({ unknown: true, recommendSyncFirst: true })
    expect(stopPreflight({ state: 'takeover', status })).toEqual({ eligible: false, reason: 'takeover_in_progress' })
    expect(stopPreflight({ state: 'active', firstRound: 'takeover', status })).toEqual({ eligible: false, reason: 'takeover_in_progress' })
    expect(stopPreflight({ state: 'active', status: { ...status, reason: 'move_in_progress' } })).toEqual({ eligible: false, reason: 'move_in_progress' })
  })
})

describe('停止落盘 ⑩:unbind 的几种结果(每种一条)', () => {
  const run = async (reply: VsResult<UnbindOk>, syncFirst = false) => {
    const unbind = vi.fn(async () => reply)
    const phases: string[] = []
    const r = await runStopLanding({ unbind }, { bindingId: 'b1', syncFirst, onPhase: (p) => phases.push(p) })
    return { r, unbind, phases }
  }
  it('成功 → stopped(只回 root)', async () => {
    const { r, unbind, phases } = await run({ ok: true, value: { ok: true, root: '/v/Lab' } })
    expect(r).toEqual({ kind: 'stopped', root: '/v/Lab' })
    expect(unbind).toHaveBeenCalledWith('b1', false)
    expect(phases).toEqual(['stopping'])
  })
  it('先同步再停 = 一次 unbind(syncFirst);跑完有剩 → pending,不自己再调一次「直接停」', async () => {
    const { r, unbind, phases } = await run({ ok: false, error: 'pending', detail: { pending: 2, held: 1, failures: 0 } }, true)
    expect(r).toEqual({ kind: 'pending', pending: 2, held: 1, failures: 0 })
    expect(unbind).toHaveBeenCalledTimes(1)
    expect(unbind).toHaveBeenCalledWith('b1', true)
    expect(phases).toEqual(['syncing'])
  })
  it('pending 三个数都是 0 → unconfirmed(确认不了干净,不当没剩)', async () => {
    expect((await run({ ok: false, error: 'pending', detail: { pending: 0, held: 0, failures: 0 } }, true)).r).toEqual({ kind: 'unconfirmed' })
    expect((await run({ ok: false, error: 'pending' }, true)).r).toEqual({ kind: 'unconfirmed' })
  })
  it('local_pending / binding_not_running / binding_not_found / 忙 / 外层失败', async () => {
    expect(classifyUnbind({ ok: false, error: 'local_pending' })).toEqual({ kind: 'local_pending' })
    expect(classifyUnbind({ ok: false, error: 'binding_not_running' })).toEqual({ kind: 'not_running' })
    expect(classifyUnbind({ ok: false, error: 'binding_not_found' })).toEqual({ kind: 'gone' })
    expect(classifyUnbind({ ok: false, error: 'takeover_in_progress' })).toEqual({ kind: 'busy', code: 'takeover_in_progress' })
    expect(classifyUnbind({ ok: false, error: 'move_in_progress' })).toEqual({ kind: 'busy', code: 'move_in_progress' })
    expect(classifyUnbind({ ok: false, error: "Error invoking remote method 'vaultsync:unbind': Error: state_unreadable" })).toEqual({ kind: 'failed', code: 'state_unreadable' })
    expect(classifyUnbind({ ok: false, error: 'channel_missing' })).toEqual({ kind: 'failed', code: 'channel_missing' })
    expect(classifyUnbind({ ok: true, value: {} as UnbindOk })).toEqual({ kind: 'failed', code: 'invalid_reply' })
  })
})
