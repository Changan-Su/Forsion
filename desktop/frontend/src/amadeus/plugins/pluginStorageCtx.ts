/**
 * ctx.storage 的渲染层半(插件数据文件夹,2026-11-26)。桥(桌面主进程 / 手机宿主)做真正的读写与路径钳制;
 * 这里只管:绑插件 id 与当前库、整理入参(字节视图)、url 同步拼地址、插件停用后拒绝、importFromVault 算出本插件的来源文件夹。
 * 方案:仓根 docs/ToBeImproved/插件数据目录方案_2026-11-26。仪器:pluginStorageCtx.test.ts。
 */
import { normalizeStoragePath, storageLayerPrefix, type PluginStorageRequest } from '@amadeus-shared/pluginStorage'
import type { PluginStorage, PluginStorageImportOptions } from './types'

export interface PluginStorageDeps {
  pluginId: string
  alive(): boolean
  call(req: PluginStorageRequest): Promise<unknown>
  /** 同步拼地址;宿主给不出 → null。 */
  url?(pluginId: string, rootRel: string): string | null
  /** 当前打开的库根;没有 → null。 */
  vaultRoot(): string | null
  /** 本插件在库里可以当「复制进来」来源的文件夹(工作文件夹、Plugins/<id>、Plugins/<旧显示名>)。 */
  importRoots(): string[]
  /** 引擎和宿主在同一台机器的同一个文件系统上(同 ctx.app.hostPath 那道门)。缺省 = 不是 → hostPath 回 null。 */
  hostExec?(): boolean
}

const gone = (): Error => new Error('plugin-disposed')

/** 交给桥的字节:字符串原样;任何 TypedArray / DataView 按字节视图取;子视图只拷自己那一段(过 IPC 会结构化克隆整块底层 buffer)。 */
function payload(data: unknown): string | Uint8Array {
  if (typeof data === 'string') return data
  const view = ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
    : data instanceof ArrayBuffer ? new Uint8Array(data) : null
  if (!view) throw new TypeError('ctx.storage expects a string, Uint8Array or ArrayBuffer')
  return view.byteLength === view.buffer.byteLength ? view : view.slice()
}

export function createPluginStorage(deps: PluginStorageDeps): PluginStorage {
  const layer = (vault: string | null): PluginStorage => {
    const call = <T>(r: Record<string, unknown>): Promise<T> => {
      if (!deps.alive()) return Promise.reject(gone())
      return deps.call({ id: deps.pluginId, ...(vault ? { vault } : {}), ...r } as PluginStorageRequest) as Promise<T>
    }
    const bytes = (v: unknown): Uint8Array | null => (v == null ? null : v instanceof Uint8Array ? v : new Uint8Array(v as ArrayBuffer))
    const api: PluginStorage = {
      readText: (path) => call<string | null>({ op: 'readText', path }),
      readBytes: (path) => call<unknown>({ op: 'readBytes', path }).then(bytes),
      write: (path, data) => { try { return call<void>({ op: 'write', path, data: payload(data) }) } catch (e) { return Promise.reject(e) } },
      append: (path, data) => { try { return call<void>({ op: 'append', path, data: payload(data) }) } catch (e) { return Promise.reject(e) } },
      list: (folder) => call({ op: 'list', path: folder ?? '' }),
      stat: (path) => call({ op: 'stat', path }),
      remove: (path) => call<void>({ op: 'remove', path }),
      move: (from, to) => call<void>({ op: 'move', path: from, to }),
      usage: () => call({ op: 'usage' }),
      url: (path) => {
        // 同步:路径不合法当场抛(和读写同一条规则),宿主给不出地址 / 插件已停用 → null
        if (!deps.alive()) return null
        const rel = normalizeStoragePath(path, { appLayer: !vault })
        const prefix = storageLayerPrefix(vault)
        return deps.url?.(deps.pluginId, prefix ? `${prefix}/${rel}` : rel) ?? null
      },
      hostPath: (path) => {
        // 路径不合法 → reject(先于门槛判,哪个宿主上都一样拒);停用 / 引擎不在本机 → null;宿主只算路径,不建文件夹。
        // 回来时再核一次门槛:等 IPC 期间插件停用或切到外部引擎,不交出路径。
        const raw = path === undefined ? '' : path
        try { normalizeStoragePath(raw, { allowRoot: true, appLayer: !vault }) } catch (e) { return Promise.reject(e) }
        const ok = (): boolean => deps.alive() && !!deps.hostExec?.()
        if (!ok()) return Promise.resolve(null)
        return call<string | null>({ op: 'hostPath', path: raw }).then((p) => (ok() && typeof p === 'string' && p ? p : null))
      },
      vault: () => {
        if (!deps.alive()) return null
        if (vault) return api
        const root = deps.vaultRoot()
        return root ? layer(root) : null
      },
      importFromVault: (opts: PluginStorageImportOptions) => {
        // 库那一层用它绑定的那个库(宿主核对仍是当前库);跟应用那一层用当前库
        const root = vault ?? deps.vaultRoot()
        if (!root) return Promise.reject(new Error('No vault is open'))
        if (!deps.alive()) return Promise.reject(gone())
        return deps.call({
          id: deps.pluginId, op: 'import', vault: root, from: String(opts?.from ?? ''), to: String(opts?.to ?? ''),
          migration: String(opts?.id ?? ''), allowed: deps.importRoots(), into: vault ? 'vault' : 'app',
        }) as ReturnType<PluginStorage['importFromVault']>
      },
    }
    return api
  }
  return layer(null)
}
