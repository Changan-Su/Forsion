// 本机智库清单(多智库第 1 步):纯函数,不碰 electron,单测直接跑。
// 配置里 localVault = 本地侧当前打开的库(Tangu 读的 lastVault 跟着它走);vaults = 用过的本地库;
// syncVault = 同步绑定的库。旧配置没有 vaults / syncVault:清单从 localVault 推出来,不在启动时回写。
import path from 'node:path'

export interface VaultEntry { root: string; lastPage?: string }

export interface VaultFields {
  lastVault?: string
  localVault?: string
  lastPage?: string
  vaults?: VaultEntry[]
  syncVault?: string
}

// ponytail: 只做 resolve,不按大小写 / 软链归一;macOS 上同一目录换大小写选进来会算两条,真撞上再上 realpath
export const samePath = (a?: string, b?: string): boolean => !!a && !!b && path.resolve(a) === path.resolve(b)

/** 老配置只有 lastVault(还没有 localVault 那一版):本地侧当前库就是它,云镜像除外。清单、切换、移除都先过这一道。 */
export const normalizeLocal = <T extends VaultFields>(cfg: T, isCloud: (root: string) => boolean): T =>
  cfg.localVault || !cfg.lastVault || isCloud(cfg.lastVault) ? cfg : { ...cfg, localVault: cfg.lastVault }

/** 新同步 / 旧版设备同步的根:钉在第一次切走前的那个库,切库不能让同步把旧库当成「全删了」。 */
export const syncVaultRoot = (cfg: VaultFields): string | undefined => cfg.syncVault ?? cfg.localVault

export function vaultList(cfg: VaultFields): VaultEntry[] {
  const out: VaultEntry[] = []
  for (const v of [...(cfg.vaults ?? []), ...(cfg.localVault ? [{ root: cfg.localVault }] : [])]) {
    if (v?.root && !out.some((o) => samePath(o.root, v.root))) out.push({ ...v })
  }
  return out
}

/** 切到 target(已存在的本地目录):记下离开那个库的 lastPage,目标进清单,首次切走时钉住同步库。 */
export function switchPatch(cfg: VaultFields, target: string): Required<Pick<VaultFields, 'vaults'>> & VaultFields {
  const onLocal = samePath(cfg.lastVault, cfg.localVault)
  const vaults = vaultList(cfg).map((v) => samePath(v.root, cfg.localVault) && onLocal ? { ...v, lastPage: cfg.lastPage } : v)
  let entry = vaults.find((v) => samePath(v.root, target))
  if (!entry) vaults.push(entry = { root: target })
  return {
    vaults,
    ...(!cfg.syncVault && cfg.localVault && !samePath(cfg.localVault, target) ? { syncVault: cfg.localVault } : {}),
    localVault: entry.root,
    lastVault: entry.root,
    lastPage: samePath(entry.root, cfg.localVault) && onLocal ? cfg.lastPage : entry.lastPage,
  }
}

/** 从清单移除(不删文件)。当前库和同步库不许移除,返回 null。 */
export function forgetPatch(cfg: VaultFields, root: string): { vaults: VaultEntry[] } | null {
  if (samePath(root, cfg.localVault) || samePath(root, syncVaultRoot(cfg))) return null
  return { vaults: vaultList(cfg).filter((v) => !samePath(v.root, root)) }
}

/** 新建智库的名字:一层目录名,不带路径分隔符、不以点开头。 */
export function vaultDirName(name: unknown): string | null {
  const n = typeof name === 'string' ? name.trim() : ''
  if (!n || n.length > 80 || n.startsWith('.') || /[/\\:*?"<>|\u0000-\u001f]/.test(n)) return null
  return n
}
