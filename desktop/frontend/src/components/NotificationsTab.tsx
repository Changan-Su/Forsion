/**
 * 设置里的两个独立面板(SettingsModal 两个 tab):
 *  - NotificationsTab(通知):总开关 + 测试 + 内置事件开关 + 每插件通知开关(ctx.notify 来源,事件 plugin:<id>)
 *  - StatusBarTab(状态栏):总开关 + 项目开关(隐藏)/拖拽排序(AgentsTab 同款 file-row;顺序存 prefs.order)
 * 状态栏行 = 内置元数据 ∪ 当前已注册项(插件项动态出现;禁用插件即消失,偏好键保留无妨)。
 */
import { useMemo, useState } from 'react'
import { Bell, GripVertical, ListChecks, MonitorUp, PanelBottom, Plug } from 'lucide-react'
import { useStatusStore } from '@lcl/engine'
import { useI18n } from '../i18n'
import { NOTIFY_EVENTS, eventDefaultOn, notifyApp, useNotifications } from '../stores/notificationStore'
import { BUILTIN_STATUS_ITEMS } from '../statusbar/items'
import { useSbPrefs } from '../statusbar/prefs'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { SettingsPanel, SettingsRow, SettingsSwitch } from './SettingsPrimitives'

const switchRow = (checked: boolean, onChange: (on: boolean) => void, name: string, desc?: string, disabled?: boolean) => (
  <SettingsRow
    key={name}
    label={name}
    description={desc}
    className={disabled ? 'is-disabled' : ''}
    control={<SettingsSwitch checked={checked} onChange={onChange} label={name} disabled={disabled} />}
  />
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
    <>
      <SettingsPanel
        icon={<Bell size={16} />}
        title={t('ntf.delivery')}
        description={t('ntf.enableHint')}
        actions={<button className="btn ghost sm" onClick={() => notifyApp({ text: t('ntf.testBody'), level: 'info', force: true })}>{t('ntf.sendTest')}</button>}
      >
        <div className="settings-control-list">
          {switchRow(prefs.enabled, setEnabled, t('ntf.enable'))}
          {switchRow(prefs.osEnabled, setOsEnabled, t('ntf.osEnable'), t('ntf.osEnableHint'), !prefs.enabled)}
        </div>
      </SettingsPanel>

      <SettingsPanel icon={<ListChecks size={16} />} title={t('ntf.events')} description={t('ntf.eventsHint')}>
        <div className="settings-control-list">
        {NOTIFY_EVENTS.map((ev) =>
            switchRow(prefs.events[ev.id] ?? ev.defaultOn, (on) => setEventOn(ev.id, on), t(ev.labelKey), undefined, !prefs.enabled),
        )}
        </div>
      </SettingsPanel>

      {activePlugins.length > 0 && (
        <SettingsPanel icon={<Plug size={16} />} title={t('ntf.pluginEvents')} description={t('ntf.pluginEventsHint')}>
          <div className="settings-control-list">
            {activePlugins.map((p) =>
              switchRow(
                prefs.events[`plugin:${p.id}`] ?? eventDefaultOn(`plugin:${p.id}`),
                (on) => setEventOn(`plugin:${p.id}`, on),
                p.name,
                undefined,
                !prefs.enabled,
              ),
            )}
          </div>
        </SettingsPanel>
      )}
    </>
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
    <>
      <SettingsPanel icon={<PanelBottom size={16} />} title={t('sb.display')} description={t('sb.enableHint')}>
        <div className="settings-control-list">
          {switchRow(sbEnabled, setSbEnabled, t('sb.enable'))}
        </div>
      </SettingsPanel>
      <SettingsPanel icon={<MonitorUp size={16} />} title={t('sb.items')} description={t('sb.itemsHint')}>
        <div className={`settings-drag-list${sbEnabled ? '' : ' is-disabled'}`}>
        {rows.map((r) => (
          <div
            key={r.id}
            className="settings-drag-row"
            draggable
            onDragStart={() => setDragId(r.id)}
            onDragEnd={() => setDragId(null)}
            onDragOver={(e) => e.preventDefault()}
            onDrop={() => {
              if (dragId && dragId !== r.id) reorder(dragId, r.id)
              setDragId(null)
            }}
            style={{ opacity: dragId === r.id ? 0.45 : 1 }}
          >
            <GripVertical size={13} style={{ color: 'var(--text-faint)', flexShrink: 0 }} />
            <input
              type="checkbox"
              checked={!sbHidden.includes(r.id)}
              onChange={(e) => setSbHidden(r.id, !e.target.checked)}
              style={{ accentColor: 'var(--accent-ink)' }}
            />
            <span className="settings-drag-name">{r.label}</span>
            <span className="settings-badge">
              {r.side === 'left' ? t('sb.side.left') : t('sb.side.right')}
            </span>
          </div>
        ))}
        </div>
      </SettingsPanel>
    </>
  )
}
