/**
 * 设置 → Forsion 插件:列表(卡片可点击)+ 详情页(manifest 信息/启停/依赖应用一键安装/插件命令/README)。
 * 依赖应用安全模型:manifest 只声明 requiresApp id,安装命令文本在宿主 KNOWN_APPS 白名单表,
 * 执行复用 env:run 通道(opaque installId+流式输出);连接探测由 renderer 直连(CSP 放行 localhost)。
 * 数据源是 vendored 的 usePluginStore(与 Amadeus Space 同一单例);样式照 PluginsTab 的 hint/btn 约定。
 */
import React, { useEffect, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { installAmadeusPlugins } from '../amadeusPlugins'
import { usePluginOnboarding, needsOnboarding, promptIfPending } from '../stores/pluginOnboardingStore'
import { useI18n } from '../i18n'
import { Markdown } from './Markdown'
import { KNOWN_APPS } from '../../../shared/knownApps'
import type { AmadeusPlugin, SettingContribution } from '@amadeus/plugins/types'

const badge: React.CSSProperties = {
  fontSize: 10.5, color: 'var(--text-faint)', border: 'var(--border-width) solid var(--border)',
  borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap',
}
const card: React.CSSProperties = {
  border: 'var(--border-width) solid var(--border)', borderRadius: 'var(--radius-lg, 10px)', padding: 12,
}

/** 插件声明的设置项(registerSetting)表单行:值存 localStorage `plugin.<id>.<key>`(全存字符串,
 *  number=String(n)/boolean='true'|'false'),插件在使用处自行读取——轮询型插件下一轮生效。
 *  导出给首启引导就绪卡复用(PluginOnboardingModal)。 */
export const SettingRow: React.FC<{ pluginId: string; def: SettingContribution }> = ({ pluginId, def }) => {
  const lsKey = `plugin.${pluginId}.${def.key}`
  const [val, setVal] = useState<string>(() => {
    const raw = localStorage.getItem(lsKey)
    return raw === null ? String(def.default) : raw
  })
  const write = (next: string): void => {
    setVal(next)
    try {
      if (next === String(def.default)) localStorage.removeItem(lsKey) // 回到默认=清键,插件端 || default 兜底
      else localStorage.setItem(lsKey, next)
    } catch { /* 配额满等,忽略 */ }
  }
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5 }}>{def.label}</div>
        {def.description && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{def.description}</div>}
      </div>
      {def.type === 'boolean' ? (
        <input type="checkbox" checked={val === 'true'} onChange={(e) => write(e.target.checked ? 'true' : 'false')} />
      ) : def.type === 'number' ? (
        <input
          type="number" value={val} min={def.min} max={def.max}
          style={{ width: 90 }}
          onChange={(e) => write(e.target.value)}
        />
      ) : (
        <input type="text" value={val} style={{ width: 180 }} onChange={(e) => write(e.target.value)} />
      )}
    </div>
  )
}

const blockedLabel = (t: (k: string, v?: Record<string, string>) => string, p: AmadeusPlugin): string =>
  p.blocked === 'api'
    ? t('settings.amadeusPlugins.blockedApi', { v: String(p.apiVersion ?? '?') })
    : t('settings.amadeusPlugins.blockedMinApp', { v: p.minAppVersion || '?' })

/** 依赖应用区:探测 → 已连接/未检测到;一键安装(宿主白名单命令,envRun 执行) → 装完自动复测。 */
const CompanionApp: React.FC<{ appId: string }> = ({ appId }) => {
  const { t } = useI18n()
  const app = KNOWN_APPS[appId]
  const [state, setState] = useState<'probing' | 'ok' | 'missing' | 'installing' | 'failed'>('probing')
  const [info, setInfo] = useState('') // ok=版本;installing=输出尾行

  const rawProbe = async (): Promise<boolean> => {
    try {
      const r = await fetch(app.probeUrl, { signal: AbortSignal.timeout(3000) })
      const j = (await r.json().catch(() => null)) as { version?: string } | null
      setInfo(String(j?.version || ''))
      return true
    } catch {
      return false
    }
  }
  const probe = async (): Promise<void> => {
    setState('probing')
    setState((await rawProbe()) ? 'ok' : 'missing')
  }
  useEffect(() => { void probe() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const install = async (): Promise<void> => {
    const tangu = window.tangu
    const req = await tangu?.requestKnownAppInstall?.(appId).catch(() => null)
    if (!req || !tangu?.envRun) { window.open(app.homepage); return } // 无一键命令/无桥形态 → 官网
    setState('installing'); setInfo('')
    const off = tangu.onEnvOutput?.((ev) => {
      if (ev.installId === req.installId) setInfo(ev.line.trim().slice(-160))
    })
    try {
      const r = await tangu.envRun(req.installId)
      if (r.exitCode === 0) {
        // 装完应用刚拉起,轮询几次给它启动时间
        for (let i = 0; i < 4; i++) {
          if (await rawProbe()) { setState('ok'); return }
          await new Promise((res) => setTimeout(res, 2000))
        }
      }
      setState('failed')
    } finally {
      off?.()
    }
  }

  const dot =
    state === 'ok' ? 'var(--ok, #3aa675)' : state === 'missing' || state === 'failed' ? 'var(--warn, #b8860b)' : 'var(--text-faint)'
  const statusText =
    state === 'ok' ? t('settings.amadeusPlugins.depConnected', { v: info || '—' })
    : state === 'installing' ? t('settings.amadeusPlugins.depInstalling')
    : state === 'failed' ? t('settings.amadeusPlugins.depFail')
    : state === 'probing' ? '…'
    : t('settings.amadeusPlugins.depMissing')

  return (
    <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <span style={{ width: 8, height: 8, borderRadius: 4, background: dot, flexShrink: 0 }} />
        <b style={{ fontSize: 12.5 }}>{app.name}</b>
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)' }}>{statusText}</span>
      </div>
      {state === 'installing' && info && (
        <div style={{ fontSize: 11, fontFamily: 'var(--font-mono, monospace)', color: 'var(--text-faint)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{info}</div>
      )}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" disabled={state === 'probing' || state === 'installing'} onClick={() => void probe()}>
          {t('settings.amadeusPlugins.depCheck')}
        </button>
        {state !== 'ok' && (
          <button className="btn sm" disabled={state === 'installing' || state === 'probing'} onClick={() => void install()}>
            {t('settings.amadeusPlugins.depInstall')}
          </button>
        )}
        <button className="btn ghost sm" onClick={() => window.open(app.homepage)}>{t('settings.amadeusPlugins.depHomepage')}</button>
      </div>
    </div>
  )
}

const PluginDetail: React.FC<{ plugin: AmadeusPlugin; onBack: () => void }> = ({ plugin: p, onBack }) => {
  const { t } = useI18n()
  const activeIds = usePluginStore((s) => s.activeIds)
  const toggle = usePluginStore((s) => s.toggle)
  const commands = usePluginStore((s) => s.commands).filter((o) => o.pluginId === p.id)
  const settings = usePluginStore((s) => s.settings).filter((o) => o.pluginId === p.id)
  usePluginOnboarding((s) => s.version) // 完成引导后徽标即时消失
  const on = activeIds.includes(p.id)
  const dep = p.requiresApp && KNOWN_APPS[p.requiresApp] ? p.requiresApp : null
  const toggleHere = (): void => {
    const wasOff = !on
    toggle(p.id)
    if (wasOff) promptIfPending(p.id) // 手动启用成功且引导未完成 → 弹就绪卡
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div>
        <button className="btn ghost sm" onClick={onBack} style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
          <ArrowLeft size={13} /> {t('settings.amadeusPlugins.back')}
        </button>
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <b style={{ fontSize: 15 }}>{p.name}</b>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>v{p.version}</span>
            <span style={badge}>{p.builtin ? t('settings.amadeusPlugins.builtin') : t('settings.amadeusPlugins.external')}</span>
            {p.blocked && (
              <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{blockedLabel(t, p)}</span>
            )}
            {needsOnboarding(p) && (
              <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{t('plugin.onboarding.badge')}</span>
            )}
          </div>
          {p.description && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>{p.description}</div>}
        </div>
        {p.onboarding && !p.blocked && (
          <button className="btn ghost sm" onClick={() => usePluginOnboarding.getState().open(p.id)}>{t('plugin.onboarding.run')}</button>
        )}
        <input type="checkbox" checked={on} disabled={!!p.blocked} onChange={toggleHere} style={{ cursor: p.blocked ? 'not-allowed' : 'pointer' }} />
      </div>
      {dep && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.dep')}</div>
          <CompanionApp appId={dep} />
        </>
      )}
      {commands.length > 0 && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.commands')}</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {commands.map((o) => (
              <button key={o.item.id} className="btn ghost sm" onClick={() => { try { o.item.run() } catch (e) { console.error(`[plugin] command "${o.item.id}" failed`, e) } }}>
                {o.item.title}
              </button>
            ))}
          </div>
        </>
      )}
      {settings.length > 0 && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.settings')}</div>
          <div style={{ ...card, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {settings.map((o) => <SettingRow key={o.item.key} pluginId={p.id} def={o.item} />)}
          </div>
        </>
      )}
      {p.readme && (
        <div style={{ borderTop: 'var(--border-width) solid var(--border)', paddingTop: 12 }}>
          <Markdown content={p.readme} />
        </div>
      )}
    </div>
  )
}

export const AmadeusPluginsTab: React.FC = () => {
  const { t } = useI18n()
  const plugins = usePluginStore((s) => s.plugins)
  const activeIds = usePluginStore((s) => s.activeIds)
  const toggle = usePluginStore((s) => s.toggle)
  const openFolder = usePluginStore((s) => s.openPluginsFolder)
  const reload = usePluginStore((s) => s.reloadExternal)
  const scaffold = usePluginStore((s) => s.scaffoldSample)
  usePluginOnboarding((s) => s.version) // 「待引导」徽标随完成态即时消失
  const [detail, setDetail] = useState<string | null>(null)

  // 设置页可能先于 Amadeus Space 打开 → 兜底装载(幂等,installed 闸在 amadeusPlugins 内)。
  useEffect(() => { installAmadeusPlugins() }, [])

  const detailPlugin = detail ? plugins.find((p) => p.id === detail) : undefined
  if (detailPlugin) return <PluginDetail plugin={detailPlugin} onBack={() => setDetail(null)} />

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="hint">{t('settings.amadeusPlugins.hint')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={() => openFolder()}>{t('settings.amadeusPlugins.openFolder')}</button>
        <button className="btn ghost sm" onClick={() => void reload()}>{t('settings.amadeusPlugins.reload')}</button>
        <button className="btn ghost sm" onClick={() => void scaffold()}>{t('settings.amadeusPlugins.scaffold')}</button>
      </div>
      {plugins.length === 0 && <div className="hint">{t('settings.amadeusPlugins.empty')}</div>}
      {plugins.map((p) => {
        const on = activeIds.includes(p.id)
        return (
          <div
            key={p.id}
            onClick={() => setDetail(p.id)}
            style={{ ...card, opacity: p.blocked ? 0.6 : 1, cursor: 'pointer' }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                  <b style={{ fontSize: 13 }}>{p.name}</b>
                  <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>v{p.version}</span>
                  <span style={badge}>{p.builtin ? t('settings.amadeusPlugins.builtin') : t('settings.amadeusPlugins.external')}</span>
                  {p.blocked && (
                    <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{blockedLabel(t, p)}</span>
                  )}
                  {needsOnboarding(p) && (
                    <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{t('plugin.onboarding.badge')}</span>
                  )}
                </div>
                {p.description && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{p.description}</div>}
              </div>
              <input
                type="checkbox"
                checked={on}
                disabled={!!p.blocked}
                onClick={(e) => e.stopPropagation()}
                onChange={() => { const wasOff = !on; toggle(p.id); if (wasOff) promptIfPending(p.id) }}
                style={{ cursor: p.blocked ? 'not-allowed' : 'pointer' }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}
