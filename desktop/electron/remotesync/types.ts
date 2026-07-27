/**
 * remotesync 公共类型。
 * RemoteFs 接口形状改编自 remotely-save `src/fsAll.ts` + `src/baseTypes.ts` 的 Entity
 * (Apache-2.0,见本目录 LICENSE / NOTICE.md);已按本层引擎精简:文件驱动、无目录实体、
 * 无 rename/分块等未采用能力。
 */

export interface RemoteEntity {
  /** posix 相对路径(不含前导 `/`;目录不出现在清单里)。 */
  key: string
  size: number
  /** 远端可见修改时间(ms);拿不到时 0。 */
  mtimeMs: number
  /** 变更身份:etag 优先,否则 `${mtimeMs}:${size}`。同 key 身份变 = 内容可能变了。 */
  id: string
}

export interface RemoteFs {
  readonly kind: string
  /** 全量列出远端文件(不含目录)。列不完整必须 throw,绝不静默截断(缺失会被引擎当删除)。 */
  walk(signal?: AbortSignal): Promise<RemoteEntity[]>
  readFile(key: string, signal?: AbortSignal): Promise<Buffer>
  /** 覆盖写;返回写后的远端实体(其 id 进基线)。父目录由实现自行保证。
   *  signal 中止后实现必须尽力取消传输 —— 被判超时的写若仍在后台完成,会盖掉后来的新版本。
   *  expectedId = 引擎所知的远端当前身份(条件写,支持 CAS 的后端应校验):
   *  null = 引擎认为远端不存在(create);string = 必须还是这个身份;undefined/忽略 = 无条件写(哑后端)。
   *  CAS 不符 → throw,引擎记 errors 保基线,下轮走 conflict/join 收敛。 */
  writeFile(key: string, data: Buffer, mtimeMs: number, signal?: AbortSignal, expectedId?: string | null): Promise<RemoteEntity>
  rm(key: string, signal?: AbortSignal, expectedId?: string | null): Promise<void>
  /** 连通性自检(设置页「测试连接」)。 */
  check(): Promise<{ ok: boolean; error?: string }>
}

/** 基线条目 = 上次收敛点(三方对账的第三方)。 */
export interface PrevEntry {
  /** 上次收敛时本地内容 sha256(hex)。 */
  h: string
  /** 上次收敛时远端身份(RemoteEntity.id)。 */
  r: string
  /** 本地 stat 缓存:size+mtime 都没变 → 跳过重哈希直接采 h。 */
  sz: number
  mt: number
}

export interface PrevState {
  version: 1
  /** 后端指纹(kind+地址+bucket/目录);不符 = 用户换了同步目标,基线作废按首次合流走。 */
  fingerprint: string
  entries: Record<string, PrevEntry>
}

export type PlanKind = 'push' | 'pull' | 'pushDelete' | 'deleteLocal' | 'join' | 'conflict'

export interface PlanItem {
  key: string
  kind: PlanKind
}

export interface SyncReport {
  ok: boolean
  startedAt: number
  finishedAt: number
  pushed: number
  pulled: number
  deletedLocal: number
  deletedRemote: number
  /** 出了冲突副本的文件数(双侧都改且内容不同)。 */
  conflicts: number
  /** 超过大小上限被跳过的 key。 */
  skippedLarge: string[]
  /** 删除闸挂起的删除数(>0 = 本轮删除全部未执行,等用户确认后重跑)。 */
  pendingDeletions: number
  errors: string[]
  /** dryRun 时返回完整计划,不执行任何写。 */
  plan?: PlanItem[]
}

export interface SyncOptions {
  localRoot: string
  remote: RemoteFs
  /** 基线 JSON 文件绝对路径(存宿主 userData,绝不放库内)。 */
  statePath: string
  /** 与 PrevState.fingerprint 对账的当前后端指纹。 */
  fingerprint: string
  /** 用户忽略规则(glob,一行一条;默认规则始终生效)。 */
  ignoreGlobs?: string[]
  /** 单文件上限(字节);超过跳过并记 skippedLarge。0 = 不限。默认 100MB。 */
  maxFileSize?: number
  /** 删除闸确认:true = 本轮放行被挂起的批量删除。 */
  allowMassDelete?: boolean
  /** 同步方式:both=双向(默认);push=仅上传(增量备份:不拉取、绝不动本地、不传播删除,
   *  冲突以本地为准推送);pull=仅下载(增量还原:不推送、不传播删除,冲突仍出本地副本)。 */
  direction?: 'both' | 'push' | 'pull'
  /** 传输并发(1-16,默认 4)。 */
  concurrency?: number
  /** 本地删除实现(宿主注入回收站);缺省 fs.rm。 */
  deleteLocalFile?: (absPath: string) => Promise<void>
  onProgress?: (done: number, total: number, current?: string) => void
  dryRun?: boolean
}
