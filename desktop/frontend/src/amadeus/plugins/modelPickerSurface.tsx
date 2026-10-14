import { useEffect, useState } from 'react'
import { ModelPill } from '../../components/ModelPill'
import { groupPickerModels, useModelPickerPreferences } from '../../modelPickerPreferences'
import { useTargetCatalogs } from '../../services/engine/catalog'
import { modelCatalog } from '../../tanguProbe'
import { mountHostReact } from './blockSurface'
import { HostLocaleProvider, registerMessages, useI18n } from '../../i18n'
import type { PluginModelCatalog, PluginModelPickerHandle, PluginModelPickerOptions } from '../../../../shared/pluginModelPicker'

registerMessages({
  'pluginmodel.localLabel': { zh: 'SenseVoice · 本机', en: 'SenseVoice · On-device' },
  'pluginmodel.localUnavailable': { zh: '请先在设置 → 语音中下载本机模型。', en: 'Download the on-device model in Settings → Voice first.' },
  'pluginmodel.unavailable': { zh: '模型目录暂不可用，请稍后重试。', en: 'The model catalog is unavailable. Try again later.' },
})

function Picker({ options, revision, alive }: { options: PluginModelPickerOptions; revision: number; alive(): boolean }) {
  const { t } = useI18n()
  const prefs = useModelPickerPreferences()
  const home = useTargetCatalogs(s => s.byKey.home?.models)
  const [catalog, setCatalog] = useState<PluginModelCatalog>({ models: [], defaultModelId: '' })
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    void modelCatalog(options.kind).then(c => { if (!cancelled && alive()) { setCatalog(c); setError('') } }, () => { if (!cancelled && alive()) setError(t('pluginmodel.unavailable')) })
    return () => { cancelled = true }
  }, [home, options.kind, revision, t])
  const cloud = catalog.models.filter(m => m.source !== 'local').map(m => ({ ...m, source: m.source as 'forsion' | 'direct' }))
  const groups = [{ key: 'follow', label: '', options: [{ id: '', name: options.followLabel }] },
    ...catalog.models.filter(m => m.source === 'local').map(m => ({ key: `local:${m.id}`, label: '', options: [{ id: m.id, name: t('pluginmodel.localLabel') + (m.available ? '' : ' · ' + t('pluginmodel.localUnavailable')) }] })),
    ...groupPickerModels(cloud, prefs).map(g => ({ key: g.key, label: g.provider, source: g.source, options: g.models })),
  ]
  return <span className="plugin-model-picker" aria-label={options.label}>
    <ModelPill groups={groups} modelId={options.value} thinkingLevel="off" menuPortal icon={null}
      title={options.label} emptyLabel={options.value || options.followLabel} scopeKey={options.scopeKey} disabled={options.disabled}
      onSelect={value => {
        if (!alive()) return
        const model = catalog.models.find(m => m.id === value)
        if (value && !model?.available) { setError(t(model?.source === 'local' ? 'pluginmodel.localUnavailable' : 'pluginmodel.unavailable')); return }
        setError(''); options.onChange(value)
      }} />
    {error && <span role="alert" className="hint">{error}</span>}
  </span>
}

export function mountPluginModelPicker(el: HTMLElement, initial: PluginModelPickerOptions): PluginModelPickerHandle {
  const options = { ...initial }
  let alive = true, revision = 0
  const tree = () => <HostLocaleProvider><Picker options={options} revision={revision++} alive={() => alive} /></HostLocaleProvider>
  const mounted = mountHostReact(el, tree(), () => { alive = false })
  return { update(patch) { if (alive) { Object.assign(options, patch); mounted.render(tree()) } }, dispose: mounted.dispose }
}
