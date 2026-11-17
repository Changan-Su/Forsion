/**
 * Harness 卡上插件给的行(ctx.registerEngineHarness,2026-11-15,DSH 融合插件第 1 档):「运行时」「更新通道」「DSH 插件」
 * 这类行由跑这个引擎的插件给数据,宿主照 Agent 配置页的样子画。插件没装 / 停用 → 一行不画。
 */
import { useEffect, useState } from 'react'
import { useI18n } from '../i18n'
// 登记表在宿主(插件经 ctx 登记);Tangu 界面只经 tanguSeam 这条缝读,不直引宿主的插件模块(check:tanguboundary)
import { collectHarnessRows, pluginText, useEngineHarnessVersion, type HostEngineHarness } from '../amadeus/plugins/tanguSeam'
import type { PluginHarnessRow } from '../amadeus/plugins/types'
import { SelectField } from '../components/SelectField'

const call = (owner: string, fn: () => void): void => {
  try { fn() } catch (e) { console.error(`[amadeus] plugin "${owner}" harness callback threw`, e) }
}

export function EngineHarnessRows({ engineId, agentSlug }: { engineId: string; agentSlug: string }) {
  const { locale } = useI18n()
  const version = useEngineHarnessVersion()
  const [rows, setRows] = useState<Array<{ owner: HostEngineHarness['owner']; row: PluginHarnessRow }>>([])
  useEffect(() => {
    let live = true
    void collectHarnessRows(engineId, { agentSlug }).then((r) => { if (live) setRows(r) })
    return () => { live = false }
  }, [engineId, agentSlug, version])
  void locale // 切语言时重画(行里的文案是插件给的 PluginText,画的那一刻求值)
  if (!rows.length) return null
  return <>{rows.map(({ owner, row }) => {
    const label = pluginText(row.label)
    const actions = (row.actions ?? []).slice(0, 3)
    const hint = row.hint != null ? pluginText(row.hint) : ''
    if (row.select) {
      const sel = row.select
      return <div key={`${owner}:${row.id}`} className="engine-harness-row" data-plugin-row={row.id}>
        <SelectField field={`plugin-${row.id}`} label={label} value={sel.value} disabled={sel.disabled}
          options={sel.options.map((o) => ({ value: o.value, label: pluginText(o.label) }))}
          onChange={(v) => call(owner, () => sel.onChange(v))} />
        {hint && <small className="agent-profile-muted">{hint}</small>}
      </div>
    }
    return <div key={`${owner}:${row.id}`} className="agent-field engine-harness-row" data-plugin-row={row.id}>
      <span>{label}</span>
      <span className="agent-field-inline">
        {row.text != null && <span className="engine-harness-value" data-tone={row.tone || undefined}>{pluginText(row.text)}</span>}
        {actions.map((a) => <button key={a.id} type="button" data-act={`plugin-${a.id}`} disabled={a.disabled}
          className={a.primary ? 'btn primary engine-harness-btn' : 'engine-harness-link'}
          onClick={() => call(owner, () => a.run())}>{pluginText(a.label)}</button>)}
      </span>
      {hint && <small>{hint}</small>}
    </div>
  })}</>
}
