/**
 * 设置里的两个独立面板(SettingsModal 两个 tab):
 *  - NotificationsTab(通知):总开关 + 测试 + 内置事件开关 + 每插件通知开关(ctx.notify 来源,事件 plugin:<id>)
 *  - StatusBarTab(状态栏):总开关 + 项目开关(隐藏)/拖拽排序(AgentsTab 同款 file-row;顺序存 prefs.order)
 * 状态栏行 = 内置元数据 ∪ 当前已注册项(插件项动态出现;禁用插件即消失,偏好键保留无妨)。
 */
import { useMemo, useState } from 'react'
import { GripVertical } from 'lucide-react'
import { useStatusStore } from '@lcl/engine'
import { useI18n } from '../i18n'
import { NOTIFY_EVENTS, eventDefaultOn, notifyApp, useNotifications } from '../stores/notificationStore'
import { BUILTIN_STATUS_ITEMS } from '../statusbar/items'
import { useSbPrefs } from '../statusbar/prefs'
import { usePluginStore } from '@amadeus/plugins/pluginStore'

/** 复选行(name 已本地化,兼作 key)。 */
const checkRow = (checked: boolean, onChange: (on: boolean) => void, name: string, desc?: string) => (
  <label className="check-row" key={name}>
    <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    <span>
      <span className="check-name">{name}</span>
      {desc && <><br /><span className="check-desc">{desc}</span></>}
    </span>
  </label>
)

export function NotificationsTab() {
  const { t } = useI18n()
  const prefs = useNotifications((s) => s.prefs)
  const setEnabled = useNotifications((s) => s.setEnabled)
  const setOsEnabled = useNotifications((s) => s.setOsEnabled)
  const setEventOn = useNotifications((s) => s.setEventOn)
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const activePlugins = plugins.filter((p) => activeIds.includes(p.id))

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        {checkRow(prefs.enabled, setEnabled, t('ntf.enable'))}
        <div style={{ flex: 1 }} />
        <button className="btn ghost sm" onClick={() => notifyApp({ text: t('ntf.testBody'), level: 'info', force: true })}>
          {t('ntf.sendTest')}
        </button>
      </div>
      <div className="hint">{t('ntf.enableHint')}</div>
      <div style={{ opacity: prefs.enabled ? 1 : 0.5 }}>
        {checkRow(prefs.osEnabled, setOsEnabled, t('ntf.osEnable'), t('ntf.osEnableHint'))}
      </div>

      <div className="settings-sec settings-sec--gap">{t('ntf.events')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: prefs.enabled ? 1 : 0.5 }}>
        {NOTIFY_EVENTS.map((ev) =>
          checkRow(prefs.events[ev.id] ?? ev.defaultOn, (on) => setEventOn(ev.id, on), t(ev.labelKey)),
        )}
      </div>

      {activePlugins.length > 0 && (
        <>
          <div className="settings-sec settings-sec--gap">{t('ntf.pluginEvents')}</div>
          <div className="hint">{t('ntf.pluginEventsHint')}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 2, opacity: prefs.enabled ? 1 : 0.5 }}>
            {activePlugins.map((p) =>
              checkRow(
                prefs.events[`plugin:${p.id}`] ?? eventDefaultOn(`plugin:${p.id}`),
                (on) => setEventOn(`plugin:${p.id}`, on),
                p.name,
              ),
            )}
          </div>
        </>
      )}
    </div>
  )
}

interface SbRow {
  id: string
  label: string
  side: 'left' | 'right'
}

export function StatusBarTab() {
  const { t } = useI18n()
  const sbEnabled = useSbPrefs((s) => s.enabled)
  const sbHidden = useSbPrefs((s) => s.hidden)
  const sbOrder = useSbPrefs((s) => s.order)
  const setSbEnabled = useSbPrefs((s) => s.setEnabled)
  const setSbHidden = useSbPrefs((s) => s.setHidden)
  const setSbOrder = useSbPrefs((s) => s.setOrder)
  const registered = useStatusStore((s) => s.items)
  const plugins = usePluginStore((s) => s.plugins)
  const [dragId, setDragId] = useState<string | null>(null)

  // 行 = 内置元数据 ∪ 已注册(插件项);按当前生效顺序显示(order 里的靠前,其余保持注册序)。
  const rows = useMemo<SbRow[]>(() => {
    const metaById = new Map(BUILTIN_STATUS_ITEMS.map((m) => [m.id, m]))
    const seen = new Set<string>()
    const base: SbRow[] = []
    for (const m of BUILTIN_STATUS_ITEMS) {
      seen.add(m.id)
      base.push({ id: m.id, label: t(m.labelKey), side: m.side })
    }
    for (const it of registered) {
      if (seen.has(it.id)) continue
      seen.add(it.id)
      // 插件项 id = plugin:<pluginId>:<itemId> → 显示「插件名 · 项 id」
      const m = /^plugin:([^:]+):(.+)$/.exec(it.id)
      const pname = m ? plugins.find((p) => p.id === m[1])?.name || m[1] : it.id
      base.push({ id: it.id, label: m ? `${pname} · ${m[2]}` : it.id, side: metaById.get(it.id)?.side ?? it.side ?? 'right' })
    }
    if (!sbOrder.length) return base
    const pos = new Map(sbOrder.map((id, i) => [id, i]))
    return [...base].sort((a, b) => (pos.get(a.id) ?? sbOrder.length) - (pos.get(b.id) ?? sbOrder.length))
  }, [registered, plugins, sbOrder, t])

  const reorder = (from: string, to: string): void => {
    if (from === to) return
    const ids = rows.map((r) => r.id).filter((id) => id !== from)
    const ti = ids.indexOf(to)
    if (ti < 0) return
    ids.splice(ti, 0, from)
    setSbOrder(ids)
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      {checkRow(sbEnabled, setSbEnabled, t('sb.enable'), t('sb.enableHint'))}
      <div className="settings-sec settings-sec--gap">{t('sb.items')}</div>
      <div className="hint">{t('sb.itemsHint')}</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 4, opacity: sbEnabled ? 1 : 0.5 }}>
        {rows.map((r) => (
          <div
            key={r.id}
            className="file-row"
            draggable
            onDragStart={() => setDragId(r.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragId && dragId !== r.id) reorder(dragId, r.id)
              setDragId(null)
            }}
            style={{ cursor: 'grab', opacity: dragId === r.id ? 0.45 : 1 }}
          >
            <GripVertical size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
            <input
              type="checkbox"
              checked={!sbHidden.includes(r.id)}
              onChange={(e) => setSbHidden(r.id, !e.target.checked)}
              style={{ accentColor: 'var(--accent-ink)' }}
            />
            <span className="file-name" style={{ flex: 1 }}>{r.label}</span>
            <span style={{ fontSize: 10.5, color: 'var(--text-faint)', border: 'var(--border-width) solid var(--border)', borderRadius: 4, padding: '0 4px' }}>
              {r.side === 'left' ? t('sb.side.left') : t('sb.side.right')}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
