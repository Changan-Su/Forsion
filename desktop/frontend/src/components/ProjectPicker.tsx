/**
 * 新建会话的项目选择(Codex 式):最近项目 / 浏览目录(系统对话框可新建)/ 无项目(云沙箱)。
 * 仅本机托管(managed)模式弹出;选择项目 → 会话落 project_path/name + host 模式 cwd 预填。
 */
import React from 'react'
import { Folder, FolderOpen, Cloud, X } from 'lucide-react'
import { AnimatedModalBackdrop, AnimatedModalContent, AnimatePresence } from './AnimatedUI'

export interface ProjectChoice {
  path: string | null // null = 无项目(云沙箱)
  name: string | null
}

export const ProjectPicker: React.FC<{
  open: boolean
  /** 最近项目(distinct project_path,新→旧)。 */
  recents: Array<{ path: string; name: string }>
  onChoose: (c: ProjectChoice) => void
  onClose: () => void
}> = (p) => {
  const browse = async (): Promise<void> => {
    const dir = await window.tangu?.pickDirectory?.()
    if (!dir) return
    p.onChoose({ path: dir, name: dir.split('/').filter(Boolean).pop() || dir })
  }

  return (
    <AnimatePresence>
      {p.open && (
        <AnimatedModalBackdrop onClose={p.onClose}>
          <AnimatedModalContent>
            <div className="modal modal-sm">
              <div className="modal-head">
                新建会话 — 选择项目
                <span className="grow" />
                <button className="icon-btn" onClick={p.onClose}>
                  <X size={16} />
                </button>
              </div>
              <div className="modal-body">
                {p.recents.length > 0 && (
                  <div className="field">
                    <label>最近项目</label>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                      {p.recents.map((r) => (
                        <button key={r.path} className="file-row" onClick={() => p.onChoose({ path: r.path, name: r.name })}>
                          <span className="file-name" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                            <Folder size={13} /> {r.name}
                          </span>
                          <span className="file-size" style={{ maxWidth: 200, overflow: 'hidden', textOverflow: 'ellipsis' }}>{r.path}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                  <button className="btn primary sm" onClick={() => void browse()}>
                    <FolderOpen size={13} /> 浏览目录(可新建)
                  </button>
                  <button className="btn ghost sm" onClick={() => p.onChoose({ path: null, name: null })}>
                    <Cloud size={13} /> 无项目(云沙箱)
                  </button>
                </div>
                <div className="hint" style={{ marginTop: 8 }}>
                  项目会话在本机该目录下执行(host 模式,自动编辑审批档);侧栏按项目分组。
                </div>
              </div>
            </div>
          </AnimatedModalContent>
        </AnimatedModalBackdrop>
      )}
    </AnimatePresence>
  )
}
