/**
 * Creations(造物)Space 与 Coding Studio git 版本的 IPC 接线。main.ts 只吃一行 `registerProductsIpc(...)`,
 * 逻辑都在无 Electron 依赖的 productsRegistry / productShortcut / gitHistory / codePreview 里(各自有单测)。
 *
 * 信任口径:每个 handler 都要 isTrustedSender(webview / 子 frame 出局);渲染层给的只有**产物 id 或目录**,
 * id → 目录一律回注册表重解(containment 在 productsRegistry 里),落盘值与参数都不直接当路径用。
 */
import { promises as fs, realpathSync, readFileSync, writeFileSync, renameSync, mkdirSync, statSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import type { IpcMain, IpcMainInvokeEvent } from 'electron'
import { PRODUCT_NO_WEB_ENTRY, type GitPanelStatus, type ProductKind, type ProductSummary, type ShortcutResult } from '../shared/products'
import { ensureProduct, getProduct, isProductId, scanProducts, updateProduct } from './productsRegistry'
import { createProductShortcut } from './productShortcut'
import { isDevLoaded, readDevLoads, setDevLoad } from './devLoadStore'
import { allowExternalLaunch, gitOwners, isExternalLaunchAllowed, revokeExternalLaunch } from './productTrust'
import { commitGitVersion, gitHistoryStatus, listGitVersions, restoreGitVersion } from './gitHistory'
import { serveProductRoot, servePathRoot, setPreviewPersistence, type PreviewPersistedState } from './codePreview'

export interface ProductsIpcDeps {
  ipcMain: IpcMain
  isTrustedSender(e: IpcMainInvokeEvent): boolean
  /** ~/Forsion/Project(dev = ~/Forsion-Dev/Project)。 */
  projectsRoot(): string
  /** forsionHomeDir():dev 一律 ~/.forsion-dev,绝不写进正式家目录。 */
  homeDir(): string
  /** envWithFullPath():GUI 进程的 PATH 残缺,git 探测必须用补全后的。 */
  env(): NodeJS.ProcessEnv
  isPackaged: boolean
  desktopDir(): string
  execPath: string
  trashItem(path: string): Promise<void>
  /** 向**每一个**可信窗口广播(主窗 / 分离窗 / mini)。开发态插件的加载 / 卸载必须全窗生效:只重载发起的那个渲染层,
   *  别的窗口里那份插件实例照旧握着笔记库与账号权限(Codex HIGH)。 */
  broadcast(channel: string, payload: unknown): void
  writeShortcutLink?: (path: string, options: { target: string; args: string; description?: string; icon?: string; iconIndex?: number }) => boolean
}

/** 稳定源的落盘位:`<home>/products.json`(0600,tmp+rename)。
 *  ⚠️load 只吞「文件不存在」:其余读盘错误(EACCES / EMFILE…)必须**原样抛出** —— codePreview 收到 throw 会把
 *  本次启动降级成只读(不写回);若在这里吞成 null,它会把残缺的空状态整份写回,**抹掉所有产物的令牌**
 *  (= 所有产物的本地数据孤儿化,评审实测)。JSON 坏了救不回来:把坏文件挪到一旁留证,再从空状态重来。 */
export function installPreviewPersistence(homeDir: () => string): void {
  const file = (): string => join(homeDir(), 'products.json')
  setPreviewPersistence({
    load(): PreviewPersistedState | null {
      let raw: string
      try { raw = readFileSync(file(), 'utf8') } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code === 'ENOENT') return null
        throw e
      }
      try { return JSON.parse(raw) as PreviewPersistedState } catch {
        try { renameSync(file(), `${file()}.corrupt`) } catch { /* 留不了证也不挡启动 */ }
        return null
      }
    },
    save(state: PreviewPersistedState) {
      const target = file()
      mkdirSync(dirname(target), { recursive: true })
      const tmp = `${target}.${process.pid}.tmp`
      writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 })
      renameSync(tmp, target)
    },
  })
}

/** dir 是托管根的**直接子目录**(realpath 后)→ 它是产物,预览走产物的稳定源;否则走一次性令牌根。
 *  Coding Studio 预览与「造物」里启动同一个项目因此是**同一个源**:编辑时存的本地数据,启动后还在。 */
/** real 是不是托管根的**直接子目录**。按 dev+ino 认父目录,不比字符串:APFS / NTFS 大小写不敏感,同一个目录换个大小写
 *  传进来就会被判成「根外」→ git 只读、预览退回一次性源(本地数据不再跨重启),而且全程不报错。 */
export function isDirectChild(projectsRoot: string, real: string): boolean {
  try {
    const parent = statSync(dirname(real)), root = statSync(realpathSync(projectsRoot))
    return parent.ino === root.ino && parent.dev === root.dev && dirname(real) !== real
  } catch { return false }
}

export async function previewOriginFor(projectsRoot: string, dir: string): Promise<{ origin: string; token: string; base: string }> {
  const real = realpathSync(dir)
  try {
    if (isDirectChild(projectsRoot, real)) {
      const product = await ensureProduct(projectsRoot, real)
      return await serveProductRoot(product.id, product.root)
    }
  } catch { /* 根不存在 / sidecar 写不了 → 退回一次性源,预览照常 */ }
  return servePathRoot(real)
}

export function registerProductsIpc(d: ProductsIpcDeps): void {
  const guard = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) => async (e: IpcMainInvokeEvent, ...args: A): Promise<R> => {
    if (!d.isTrustedSender(e)) throw new Error('forbidden')
    return fn(...args)
  }
  const product = async (id: unknown) => {
    if (!isProductId(id)) throw new Error('invalid product id')
    const p = await getProduct(d.projectsRoot(), id)
    if (!p) throw new Error('product not found')
    return p
  }
  const dirArg = async (root: unknown): Promise<string> => {
    if (typeof root !== 'string' || !root) throw new Error('invalid project root')
    const real = await fs.realpath(root)
    if (!(await fs.stat(real)).isDirectory()) throw new Error('project root is not a directory')
    return real
  }
  /** 托管根的直接子目录才允许宿主写 git(init / add -A / restore);根外导入的目录只读。 */
  const managed = (real: string): boolean => isDirectChild(d.projectsRoot(), real)
  // owners = 「这个仓是 Forsion 建的」的宿主侧登记处(nonce);只看 .git 里的标记文件是可伪造的(见 gitHistory.GitOwners)。
  const git = () => ({ env: d.env(), owners: gitOwners(d.homeDir()) })
  /** devLoad 叠加:授权住在宿主家目录(devLoadStore),不在不可信的项目 sidecar 里。只有插件产物才可能为 true。 */
  //  ⚠️**不看当前判型**:授权过的插件项目把 manifest.json 写坏(少个逗号)的那一刻会被判成 web / unknown ——
  //  若这时 devLoad 跟着消失,Studio 就把 Sandbox 入口收起来,而宿主那边授权还在、开发副本以 blocked:'invalid' 挂着,
  //  用户既看不到报错也卸不掉它。授权在 → devLoad 恒 true,pluginId 沿用授权当时的那个。
  const withDevLoad = <T extends ProductSummary | null>(p: T, loads = readDevLoads(d.homeDir())): T => {
    if (!p) return p
    if (!isDevLoaded(loads, p)) return (p.kind === 'plugin' ? { ...p, devLoad: false } : p)
    return { ...p, devLoad: true, pluginId: p.pluginId ?? loads[p.id]?.pluginId ?? undefined }
  }
  /** 渲染层传来的本地化标签:只收短字符串,其余当没传(各模块有英文兜底)。 */
  const label = (v: unknown): string | undefined => (typeof v === 'string' && v.length <= 120 ? v : undefined)

  d.ipcMain.handle('products:list', guard(async () => {
    const loads = readDevLoads(d.homeDir())
    return (await scanProducts(d.projectsRoot())).map((p) => withDevLoad(p, loads))
  }))
  d.ipcMain.handle('products:get', guard(async (id: unknown) => (isProductId(id) ? withDevLoad(await getProduct(d.projectsRoot(), id)) : null)))
  d.ipcMain.handle('products:ensure', guard(async (dir: unknown) => {
    const real = await dirArg(dir)
    return managed(real) ? withDevLoad(await ensureProduct(d.projectsRoot(), real)) : null // 根外项目不是产物(方案 §3.3)
  }))
  d.ipcMain.handle('products:update', guard(async (id: unknown, patch: { name?: string; entry?: string | null; kind?: ProductKind; devLoad?: boolean }) => {
    const p = await product(id)
    const { devLoad, ...rest } = patch ?? {}
    const next = await updateProduct(d.projectsRoot(), p.id, rest)
    // 「在 Forsion 中加载」= 授权这个目录的代码以插件权限执行。**这里是全应用唯一的写口**(用户在 Sandbox 面板点按钮
    // → 可信 sender 的 IPC);只认真插件项目,且把授权钉在此刻的真实根上(见 devLoadStore 头注)。
    if (devLoad !== undefined) {
      if (typeof devLoad !== 'boolean') throw new Error('Product devLoad must be a boolean')
      if (devLoad && next.kind !== 'plugin') throw new Error('Only plugin projects can be loaded into Forsion')
      const previous = readDevLoads(d.homeDir())[next.id]?.pluginId ?? null
      setDevLoad(d.homeDir(), next, devLoad)
      // 全窗重载:新旧两个 id 都要(改过 manifest.id 时旧实例得拆掉)。
      d.broadcast('plugins:devChanged', { pluginIds: [...new Set([next.pluginId, previous].filter((x): x is string => !!x))] })
    }
    return withDevLoad(next)
  }))
  d.ipcMain.handle('products:serve', guard(async (id: unknown) => {
    const p = await product(id)
    if (p.kind !== 'web' || !p.entry) throw new Error(PRODUCT_NO_WEB_ENTRY)
    const { origin } = await serveProductRoot(p.id, p.root)
    return { origin, url: `${origin}/${p.entry.split('/').map(encodeURIComponent).join('/')}`, product: p }
  }))
  // fallbackName = 产物名清洗后为空时的桌面文件名。落盘产物命名跟随界面语言,而语言只有渲染层知道 → 由它传入
  // (模块内会再过同一把筛子,传什么都进不了路径)。
  d.ipcMain.handle('products:shortcut', guard(async (id: unknown, fallbackName?: unknown): Promise<ShortcutResult> => {
    let p
    try { p = await product(id) } catch { return { ok: false, code: 'not_found' } }
    const result = await createProductShortcut({ id: p.id, name: p.name }, {
      isPackaged: d.isPackaged, desktopDir: d.desktopDir(), execPath: d.execPath,
      appImage: process.env.APPIMAGE, writeShortcutLink: d.writeShortcutLink,
      fallbackName: label(fallbackName),
    })
    // 「添加到桌面」是用户在应用内亲手点的 —— 只有这一步才把该产物登记成「允许从应用外拉起」(见 productTrust)。
    if (result.ok) allowExternalLaunch(d.homeDir(), p)
    return result
  }))
  // 深链 / 快捷方式落地前问这一句:产物在、且用户为它建过快捷方式。深链是任意网页可达的输入,而产物页面握着
  // Forsion Connect 代理(读账号、花额度)—— 一个下载来的文件夹配一条链接,不该零点击跑起来;也顺带挡掉
  // 「一串形态合法但不存在的 id 各开一个空窗口」。应用内点开不走这里。
  d.ipcMain.handle('products:externalLaunchAllowed', guard(async (id: unknown) => {
    if (!isProductId(id)) return false
    const p = await getProduct(d.projectsRoot(), id).catch(() => null)
    return !!p && p.kind === 'web' && !!p.entry && isExternalLaunchAllowed(d.homeDir(), p)
  }))
  // 删除 = 移入系统回收站(可恢复)。目录来自注册表重解,不吃渲染层路径。
  d.ipcMain.handle('products:trash', guard(async (id: unknown) => {
    const p = await product(id)
    // 先撤权再删:开发副本的授权不撤,回收站里的代码下次启动照样以插件权限加载(目录被「放回原处」就更是了);
    // 已加载的实例也得当场全窗拆掉。
    const grant = readDevLoads(d.homeDir())[p.id]
    if (grant) { setDevLoad(d.homeDir(), p, false); d.broadcast('plugins:devChanged', { pluginIds: [grant.pluginId, p.pluginId].filter((x): x is string => !!x) }) }
    revokeExternalLaunch(d.homeDir(), p.id)
    await d.trashItem(p.root)
    return { ok: true }
  }))

  // ── Coding Studio 的 git 版本(只给有 git 的用户;没有 → 面板显示安装建议)──
  d.ipcMain.handle('codeStudio:gitStatus', guard(async (root: unknown): Promise<GitPanelStatus> => {
    const real = await dirArg(root)
    const status = await gitHistoryStatus(real, git())
    return { ...status, writable: status.available && managed(real) && (status.state === 'none' || status.state === 'owned') }
  }))
  d.ipcMain.handle('codeStudio:gitVersions', guard(async (root: unknown) => listGitVersions(await dirArg(root), git())))
  // 提交标题写下就不可变、且直接显示在 History 面板 → 兜底名 / 备份名 / 「恢复到」前缀由渲染层按当前语言传入
  // (gitHistory 里逐个按标题口径清洗;缺省回落英文)。
  d.ipcMain.handle('codeStudio:gitCommit', guard(async (root: unknown, input: { name?: unknown; auto?: unknown; untitled?: unknown }) => {
    const real = await dirArg(root)
    if (!managed(real)) throw new Error('read-only repository')
    return commitGitVersion(real, {
      name: typeof input?.name === 'string' ? input.name : '', auto: input?.auto === true,
      labels: { untitled: label(input?.untitled) },
    }, git())
  }))
  d.ipcMain.handle('codeStudio:gitRestore', guard(async (root: unknown, id: unknown, labels?: { backup?: unknown; restorePrefix?: unknown }) => {
    const real = await dirArg(root)
    if (!managed(real)) throw new Error('read-only repository')
    if (typeof id !== 'string') throw new Error('invalid version id')
    return restoreGitVersion(real, id, git(), { backup: label(labels?.backup), restorePrefix: label(labels?.restorePrefix) })
  }))
}
