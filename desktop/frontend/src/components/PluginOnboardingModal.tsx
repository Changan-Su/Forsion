/**
 * 插件首启引导「就绪卡」:manifest.onboarding(声明式,主进程已消毒)→ 一张卡完成
 * ①了解要做什么(intro/steps)②必要设置就地填(复用 SettingRow,同一 localStorage 键)
 * ③配套内容一键装(recommends,走市场 IPC 按 installSlug 匹配,装完副作用对齐 MarketModal)。
 * 「完成设置」落 __setupDone;「稍后」/遮罩关闭 → 一次性 Inbox 提醒 + 设置页保留「待引导」徽标。
 * 弹层载体 .am-app.tangu-lovable(.dialog-* 取色桥,所有弹窗同款,见 askString Host 注释)。
 */
import React, { useEffect, useState } from 'react'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { usePluginOnboarding, nudgeOnboardingOnce } from '../stores/pluginOnboardingStore'
import { useI18n } from '../i18n'
import { useApp } from '../stores/appStore'
import { SettingRow } from './AmadeusPluginsTab'
import { listMarket, installMarket, listInstalled } from '../services/marketService'
import { loadUserSpaces } from '../userSpaces'
import { useTheme } from '../stores/themeStore'
import { installAmadeusPlugins } from '../amadeusPlugins'
import type { PluginOnboardingRecommend } from '@amadeus-shared/ipc'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import type { MarketCard } from '../types'

/** 一条配套推荐:市场按 installSlug 解析 → 安装/已装/未上架三态;装完副作用与 MarketModal 同款。 */
const RecommendRow: React.FC<{ rec: PluginOnboardingRecommend; preInstalled: boolean }> = ({ rec, preInstalled }) => {
  const { t } = useI18n()
  const [card, setCard] = useState<MarketCard | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'installing' | 'done'>(preInstalled ? 'done' : 'loading')

  useEffect(() => {
    if (preInstalled) return
    let alive = true
    listMarket(rec.type)
      .then((cards) => {
        if (!alive) return
        const hit = cards.find((c) => c.installSlug === rec.slug)
        if (hit) { setCard(hit); setState('ready') } else setState('missing')
      })
      .catch(() => { if (alive) setState('missing') })
    return () => { alive = false }
  }, [rec, preInstalled])

  const install = async (): Promise<void> => {
    if (!card) return
    setState('installing')
    try {
      await installMarket(card.id)
      if (rec.type === 'space') await loadUserSpaces() // 热注册,ribbon 实时出现
      else if (rec.type === 'theme') await useTheme.getState().reloadThemes()
      else if (rec.type === 'plugin') await useApp.getState().onPluginInstalled()
      else if (rec.type === 'amadeus-plugin' && window.amadeus) {
        installAmadeusPlugins()
        await usePluginStore.getState().reloadExternal()
      }
      setState('done')
    } catch (e: any) {
      useApp.getState().toast(e?.message || String(e), true)
      setState('ready')
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5 }}>{card?.name || rec.name || rec.slug}</div>
        {rec.reason && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{rec.reason}</div>}
      </div>
      {state === 'done' ? (
        <span style={{ fontSize: 11.5, color: 'var(--ok, #3aa675)', whiteSpace: 'nowrap' }}>{t('plugin.onboarding.installed')}</span>
      ) : state === 'missing' ? (
        <span style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>{t('plugin.onboarding.notFound')}</span>
      ) : (
        <button className="btn sm" disabled={state !== 'ready'} onClick={() => void install()}>
          {state === 'installing' ? t('plugin.onboarding.installing') : t('plugin.onboarding.install')}
        </button>
      )}
    </div>
  )
}

const Card: React.FC<{ plugin: AmadeusPlugin }> = ({ plugin: p }) => {
  const { t } = useI18n()
  const spec = p.onboarding!
  const allSettings = usePluginStore((s) => s.settings).filter((o) => o.pluginId === p.id)
  const settings =
    spec.settings === true ? allSettings
    : Array.isArray(spec.settings) ? allSettings.filter((o) => (spec.settings as string[]).includes(o.item.key))
    : []
  // 已装清单一次性预检:已在本机的推荐项直接显示「已装」,不再打市场列表。
  const [installed, setInstalled] = useState<Record<string, Set<string>> | null>(null)
  useEffect(() => {
    if (!spec.recommends?.length) { setInstalled({}); return }
    listInstalled()
      .then((m) => {
        const idx: Record<string, Set<string>> = {}
        for (const [type, items] of Object.entries(m)) idx[type] = new Set(items.map((x) => x.slug))
        setInstalled(idx)
      })
      .catch(() => setInstalled({}))
  }, [spec])

  const skip = (): void => {
    nudgeOnboardingOnce(p)
    usePluginOnboarding.getState().close()
  }
  const done = (): void => usePluginOnboarding.getState().markDone(p.id)

  return (
    <div className="dialog-overlay" onMouseDown={skip}>
      <div className="dialog" style={{ width: 'min(480px, 92vw)' }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{t('plugin.onboarding.title', { name: p.name })}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '60vh', overflowY: 'auto', padding: '2px 0' }}>
          {spec.intro && <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{spec.intro}</div>}
          {!!spec.steps?.length && (
            <div>
              <div className="hint" style={{ marginBottom: 6 }}>{t('plugin.onboarding.stepsTitle')}</div>
              <ol style={{ margin: 0, paddingLeft: 18, display: 'flex', flexDirection: 'column', gap: 6 }}>
                {spec.steps.map((s, i) => (
                  <li key={i} style={{ fontSize: 12.5 }}>
                    {s.title}
                    {s.description && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{s.description}</div>}
                  </li>
                ))}
              </ol>
            </div>
          )}
          {settings.length > 0 && (
            <div>
              <div className="hint" style={{ marginBottom: 6 }}>{t('plugin.onboarding.settingsTitle')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {settings.map((o) => <SettingRow key={o.item.key} pluginId={p.id} def={o.item} />)}
              </div>
            </div>
          )}
          {!!spec.recommends?.length && installed && (
            <div>
              <div className="hint" style={{ marginBottom: 6 }}>{t('plugin.onboarding.recommendsTitle')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {spec.recommends.map((r) => (
                  <RecommendRow key={`${r.type}:${r.slug}`} rec={r} preInstalled={!!installed[r.type]?.has(r.slug)} />
                ))}
              </div>
            </div>
          )}
          <div style={{ fontSize: 10.5, color: 'var(--text-faint)' }}>{t('plugin.onboarding.laterHint')}</div>
        </div>
        <div className="dialog-actions">
          <button className="dialog-btn" onClick={skip}>{t('plugin.onboarding.later')}</button>
          <button className="dialog-btn" data-primary onClick={done}>{t('plugin.onboarding.done')}</button>
        </div>
      </div>
    </div>
  )
}

/** 挂载一次(Root):有待展示的就绪卡才渲染。 */
export function PluginOnboardingHost() {
  const pluginId = usePluginOnboarding((s) => s.pluginId)
  const plugins = usePluginStore((s) => s.plugins)
  const plugin = pluginId ? plugins.find((p) => p.id === pluginId) : undefined
  if (!plugin?.onboarding) return null
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <Card plugin={plugin} />
    </div>
  )
}
