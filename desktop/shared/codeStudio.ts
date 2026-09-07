/** Coding Studio 主进程 / renderer 公用契约，无 Electron 依赖。 */
export interface CodeStudioProjectChange {
  /** 规范化后的真实项目根。 */
  root: string
  /** 相对项目根、正斜杠路径；null = 整体重扫。 */
  path: string | null
  /** 监听已停止/无法继续；renderer 应显示错误而非伪装成正常刷新。 */
  error?: string
}

export interface CodeStudioSnapshotSummary {
  id: string
  name: string
  createdAt: number
  /** 本快照覆盖的文本源码/配置数量，不包括媒体、依赖、构建物和敏感文件。 */
  files: number
}

export interface CodeStudioRestoreSummary {
  restored: string[]
  deleted: string[]
  /** 安全备份之后被外部修改、或路径不再安全的文件；保持现场，不覆盖。 */
  conflicts: string[]
  backupId: string
}
