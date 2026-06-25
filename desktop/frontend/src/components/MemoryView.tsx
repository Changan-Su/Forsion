/**
 * 记忆(主区面板):本设备记录的「关于用户的记忆」全文 + 历史日志列表;点日志查看详情。
 */
import React, { useEffect, useState } from 'react'
import { Brain, RefreshCw, FileText, X } from 'lucide-react'
import { getMemory, getHistorianActivity } from '../services/backendService'
import type { HistorianActivityItem, TanguDesktopConfig } from '../types'
import { useI18n } from '../i18n'

export const MemoryView: React.FC<{ cfg: TanguDesktopConfig }> = ({ cfg }) => {
  const { t } = useI18n()
  const [memory, setMemory] = useState<string | null>(null)
  const [logs, setLogs] = useState<HistorianActivityItem[] | null>(null)
  const [detail, setDetail] = useState<HistorianActivityItem | null>(null)

  const load = (): void => {
    void getMemory(cfg).then((r) => setMemory(r.content || '')).catch(() => setMemory(''))
    void getHistorianActivity(cfg, 80).then(setLogs).catch(() => setLogs([]))
  }
  useEffect(() => {
    load()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="memv">
      <div className="memv-inner">
        <div className="memv-head">
          <Brain size={16} /> <span className="memv-title">{t('memory.title')}</span>
          <span style={{ flex: 1 }} />
          <button className="icon-btn" title={t('common.refresh')} onClick={load}><RefreshCw size={13} /></button>
        </div>

        <div className="memv-label">{t('memory.memory')}</div>
        <div className="memv-memory">
          {memory === null ? <div className="hint">{t('common.loading')}</div>
            : memory.trim() ? memory
              : <div className="hint">{t('memory.empty')}</div>}
        </div>

        <div className="memv-label">{t('memory.logs')}</div>
        {logs && logs.length === 0 && <div className="hint">{t('memory.noLogs')}</div>}
        <div className="memv-logs">
          {(logs || []).map((it) => (
            <button key={it.id} className="memv-log" onClick={() => setDetail(it)}>
              <FileText size={13} className="memv-log-icon" />
              <span className="memv-log-detail">{it.detail}</span>
              <span className="memv-log-time">{String(it.created_at).replace('T', ' ').slice(5, 16)}</span>
            </button>
          ))}
        </div>
      </div>

      {detail && (
        <div className="memv-modal" onClick={() => setDetail(null)}>
          <div className="memv-modal-box" onClick={(e) => e.stopPropagation()}>
            <div className="memv-modal-head">
              <span>{String(detail.created_at).replace('T', ' ').slice(0, 16)}</span>
              <button className="icon-btn" onClick={() => setDetail(null)}><X size={15} /></button>
            </div>
            <div className="memv-modal-body">{detail.detail}</div>
          </div>
        </div>
      )}
    </div>
  )
}
