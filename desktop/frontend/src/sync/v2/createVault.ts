/**
 * 智库同步第 4 步 U4 ⑪「新建智库…」对话框背后的逻辑(契约 step34 §4.2、实现期修订 E4-9/17/19;方案图第 2 页 ⑪)。
 * 没有 JSX、不出文案:状态一律回码,界面按码说。
 *
 * 顺序(勾着「上传到云端」时):
 *   1. 用 Extend 的 resolveName 预判；通道不在或失败时由 create 裁决。
 *   2. 宿主 vaultCreate 建 `Vaults/<名>`、登记进清单,**不切过去**(切过去会挂载、建索引,文件夹就不再是空的,也成了 forget 不掉的当前库);
 *   3. vaultsync:create {root};
 *   4. 成功,或「离线 / 老服务器 / 准入挡住」这类只是上不了云的 → 本机那个库照样留着,打开它;
 *      name_exists / reserved / invalid_name(名字本身不行,对话框留着让人换名)→ 把第 2 步刚建的空文件夹撤掉:
 *      只在确认它是本次新建、仍为空、没有绑定时才删(createdFolder.ts),否则留着并回报。
 * 不勾:建、打开,和今天一样(只是改成先建再开)。
 */
import type { VsResult } from './client'
import { discardCreatedFolder, type CreatedFolderHost, type DiscardOutcome } from './createdFolder'
import { hostCreateError, type HostCreateError, type VaultCreateFn } from './download'
import type { CreateOk, ResolveNameResult, VaultSyncGet } from './types'
import type { SyncUiMode } from './mode'

// ── 「上传到云端」这个勾 ──

export type UploadOption =
  | { available: true; defaultChecked: true }
  /** 灰掉,原因:没登录 / 云端暂不支持多个库 / 不是完整模式(兼容模式、老 Extend、Extend 停用)/ 还没问出来 */
  | { available: false; defaultChecked: false; reason: 'not_signed_in' | 'server_unsupported' | 'not_full' | 'unknown' }

/** 登录着、完整模式、serverCaps.vaults 为真时缺省勾上(§4.2)。signedIn = null(还不知道)按没登录灰掉,不替人勾。 */
export function uploadOption(o: { mode: SyncUiMode; signedIn: boolean | null; get?: Pick<VaultSyncGet, 'serverCaps'> | null }): UploadOption {
  if (o.mode === 'unknown') return { available: false, defaultChecked: false, reason: 'unknown' }
  if (o.mode !== 'full') return { available: false, defaultChecked: false, reason: 'not_full' }
  if (o.signedIn !== true) return { available: false, defaultChecked: false, reason: 'not_signed_in' }
  if (!o.get) return { available: false, defaultChecked: false, reason: 'unknown' }
  if (o.get.serverCaps?.vaults !== true) return { available: false, defaultChecked: false, reason: 'server_unsupported' }
  return { available: true, defaultChecked: true }
}

// ── 边打字边判 ──

export type NameCheck =
  | { kind: 'clear' }
  | { kind: 'unknown' }
  | { kind: 'name_exists'; libraryId?: string }
  | { kind: 'reserved' | 'invalid_name' }

export async function checkNewVaultName(resolve: (name: string) => Promise<VsResult<ResolveNameResult>>, name: string): Promise<NameCheck> {
  const r = await resolve(name)
  if (!r.ok || !r.value || !Array.isArray(r.value.candidates)) return { kind: 'unknown' }
  if (r.value.error === 'reserved' || r.value.error === 'invalid_name') return { kind: r.value.error }
  if (r.value.error) return { kind: 'unknown' }
  const [candidate] = r.value.candidates
  if (!candidate) return { kind: 'clear' }
  if (r.value.candidates.length !== 1 || !candidate.vaultId) return { kind: 'name_exists' }
  if (candidate.kind === 'own') return { kind: 'name_exists', libraryId: candidate.vaultId }
  if (candidate.kind === 'legacy' && candidate.prefix) return { kind: 'name_exists', libraryId: candidate.vaultId + ':' + candidate.prefix }
  return { kind: 'name_exists' }
}

// ── 点了「新建」──

export interface CreateVaultDeps {
  /** 宿主 vaultCreate,existing:'refuse'(同名文件夹已在 → 抛 EEXIST,不并进别人的文件夹)。parent 不给 = 宿主 `<工作区>/Vaults`。 */
  vaultCreate: VaultCreateFn
  resolveName?(name: string): Promise<VsResult<ResolveNameResult>>
  create(root: string): Promise<VsResult<CreateOk>>
  /** 打开这个库(pageStore.switchLocalVault:先在旧根落盘再换根)。 */
  open(root: string): Promise<void>
  folder: CreatedFolderHost
}

/** 上不了云、但本机的库照样留着的原因(那一行写「只在这台 · 上传到云端…」):服务器的码,或外层的 stale / state_unreadable / compat_mode / channel_missing… */
export type CreateLocalReason = string

export type CreateVaultRun =
  /** 建好了、打开了(opened = false 时 openError 带原文);upload:on = 上云成功,off = 没勾,failed = 勾了但没上去 */
  | { kind: 'created'; root: string; upload: 'on'; bindingId: string; opened: boolean; openError?: string }
  | { kind: 'created'; root: string; upload: 'off'; opened: boolean; openError?: string }
  | { kind: 'created'; root: string; upload: 'failed'; reason: CreateLocalReason; opened: boolean; openError?: string }
  /** 撞了云端的名字。source:resolver = 预判挡住(本机什么都没建),server = 建的时候服务器才说(cleanup 是刚建的空文件夹撤没撤)。
   *  libraryId 可能没有(服务器没回、Extend 也没查到)→ 「落盘它到这台…」只能灰着 */
  | { kind: 'name_exists'; source: 'resolver' | 'server'; libraryId?: string; cleanup: DiscardOutcome | null }
  /** 名字本身上不了云(保留名 / 云端不认):对话框留着让人换名;cleanup 同上 */
  | { kind: 'name_rejected'; code: 'reserved' | 'invalid_name'; source: 'resolver' | 'server'; cleanup: DiscardOutcome | null }
  /** 名字是空的:什么都不做 */
  | { kind: 'empty_name' }
  /** 宿主没建成(名字不合本机规矩 / 同名文件夹已在 / 其他):什么都没写 */
  | { kind: 'host_failed'; code: HostCreateError }
  /** 宿主回的形状不对:不知道建没建,不往下做 */
  | { kind: 'host_invalid' }

const NAME_REJECTED = new Set(['reserved', 'invalid_name'])
const codeOf = (err: string): string => /([a-z][a-z0-9_-]+)\s*$/.exec(err)?.[1] ?? err

export async function runCreateVault(deps: CreateVaultDeps, o: { name: string; upload: boolean }): Promise<CreateVaultRun> {
  const name = o.name.trim()
  if (!name) return { kind: 'empty_name' }
  if (o.upload && deps.resolveName) {
    const pre = await checkNewVaultName(deps.resolveName, name)
    if (pre.kind === 'name_exists') return { kind: 'name_exists', source: 'resolver', libraryId: pre.libraryId, cleanup: null }
    if (pre.kind === 'reserved' || pre.kind === 'invalid_name') return { kind: 'name_rejected', code: pre.kind, source: 'resolver', cleanup: null }
  }
  let made: { root: string; created: boolean }
  try {
    made = await deps.vaultCreate({ name, existing: 'refuse' })
  } catch (e) {
    return { kind: 'host_failed', code: hostCreateError(e) }
  }
  if (!made || typeof made.root !== 'string' || !made.root || typeof made.created !== 'boolean') return { kind: 'host_invalid' }
  const open = async (): Promise<{ opened: boolean; openError?: string }> => {
    try { await deps.open(made.root); return { opened: true } } catch (e) { return { opened: false, openError: String((e as Error)?.message ?? e) } }
  }
  if (!o.upload) return { kind: 'created', root: made.root, upload: 'off', ...(await open()) }
  const r = await deps.create(made.root)
  if (r.ok && r.value && typeof r.value.bindingId === 'string' && r.value.bindingId) {
    return { kind: 'created', root: made.root, upload: 'on', bindingId: r.value.bindingId, ...(await open()) }
  }
  const code = r.ok ? 'invalid_reply' : codeOf(r.error)
  if (code === 'name_exists') {
    const cleanup = await discardCreatedFolder(deps.folder, made)
    const libraryId = r.ok ? undefined : r.detail?.libraryId
    return { kind: 'name_exists', source: 'server', ...(libraryId ? { libraryId } : {}), cleanup }
  }
  if (NAME_REJECTED.has(code)) {
    const cleanup = await discardCreatedFolder(deps.folder, made)
    return { kind: 'name_rejected', code: code as 'reserved' | 'invalid_name', source: 'server', cleanup }
  }
  // 离线 / 老服务器 / 没登录 / 准入挡住 / 换了账号(stale)/ 状态读不出…:任何一种都不建绑定,本机的库照样在(E4 create 表)
  return { kind: 'created', root: made.root, upload: 'failed', reason: code, ...(await open()) }
}
