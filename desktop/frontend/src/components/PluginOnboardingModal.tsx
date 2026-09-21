/**
 * 插件首启引导「就绪卡」:manifest.onboarding(声明式,主进程已消毒)→ 一张卡完成
 * ①了解要做什么(intro/steps)②必要设置就地填(复用 SettingRow,同一 localStorage 键)
 * ③配套内容一键装(recommends,走市场 IPC 按 installSlug 匹配,装完副作用对齐 MarketModal)。
 * 2026-09-21 起只给带 requires 的插件弹(见 pluginOnboardingStore 文件头):顶上是实测过的前置条件
 * (对勾/未完成/暂时无法检查三态),没有「完成设置」这个自证按钮了 —— 全部满足卡片自己就说「全部就绪」,
 * 徽标也随实测消失。「稍后」/遮罩关闭 → 一次性 Inbox 提醒。
 * 弹层载体 .am-app.tangu-lovable(.dialog-* 取色桥,所有弹窗同款,见 askString Host 注释)。
 */
import React, { useEffect, useState } from 'react'
import { Check, CircleAlert, CircleHelp, Loader2 } from 'lucide-react'
import { DesktopPermissions } from './DesktopPermissions'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { usePluginOnboarding, nudgeOnboardingOnce, requirementsOf, isGate, type RequirementResult } from '../stores/pluginOnboardingStore'
import { useI18n } from '../i18n'
import { localizedOnboarding, pluginDisplayName, AUTO_WORK_FOLDER_KEY } from '../amadeus/plugins/display'
import { useApp } from '../stores/appStore'
import { SettingRow } from './AmadeusPluginsTab'
import { listMarket, installMarket, listInstalled } from '../services/marketService'
import { loadUserSpaces } from '../userSpaces'
import { useTheme } from '../stores/themeStore'
import { installAmadeusPlugins } from '../amadeusPlugins'
import { requirementKey, type PluginOnboardingRecommend, type PluginRequirement } from '@amadeus-shared/ipc'
import type { AmadeusPlugin } from '@amadeus/plugins/types'
import type { MarketCard } from '../types'

/** 一条配套推荐:市场按 installSlug 解析 → 安装/已装/未上架三态;装完副作用与 MarketModal 同款。 */
const RecommendRow: React.FC<{ rec: PluginOnboardingRecommend; preInstalled: boolean }> = ({ rec, preInstalled }) => {
  const { t } = useI18n()
  const [card, setCard] = useState<MarketCard | null>(null)
  const [state, setState] = useState<'loading' | 'ready' | 'missing' | 'installing' | 'done'>(preInstalled ? 'done' : 'loading')
  // 失败原因就地显示:这张卡住在设置 / 市场浮窗里,全局 toast 在那儿不渲染(按钮只会默默变回「安装」)。
  const [err, setErr] = useState('')

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
    setErr('')
    try {
      const res = await installMarket(card.id)
      // 真类型以主进程实测为准(后端 category 可能把 Forsion 插件误标成引擎 'plugin');据此走对应装后流程。
      const effType = res?.type || rec.type
      // onPluginInstalled 自己吞异常:装后重扫失败只会走 notify 的 error 分支 —— 那时不能标「已安装」,留着按钮可重试(重装幂等)。
      let postFailed = false
      if (effType === 'space') await loadUserSpaces() // 热注册,ribbon 实时出现
      else if (effType === 'theme') await useTheme.getState().reloadThemes()
      else if (effType === 'plugin') await useApp.getState().onPluginInstalled((text, error) => { if (error) { postFailed = true; setErr(text) } else useApp.getState().toast(text) })
      else if (effType === 'amadeus-plugin' && window.amadeus) {
        installAmadeusPlugins()
        await usePluginStore.getState().reloadExternal()
        await loadUserSpaces() // 捆绑包内嵌 Space → 热注册(此前只有 market 路径补了这步,引导卡装的会漏)
      }
      setState(postFailed ? 'ready' : 'done')
    } catch (e: any) {
      setErr(t('market.installFail', { e: e?.message || String(e) }))
      setState('ready')
    }
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 12.5 }}>{card?.name || rec.name || rec.slug}</div>
        {rec.reason && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{rec.reason}</div>}
        {err && <div role="alert" style={{ fontSize: 11, color: 'var(--danger)', overflowWrap: 'anywhere' }}>{err}</div>}
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

/** 一条前置条件的状态角标:对勾只给实测通过的;「判断不了」是灰的,绝不画成绿色。 */
const ReqState: React.FC<{ result?: RequirementResult; checking?: boolean }> = ({ result, checking }) => {
  const { t } = useI18n()
  if (checking && !result) return <span className="plugin-req-state" data-state="checking"><Loader2 size={12} className="spin" aria-hidden="true" />{t('plugin.onboarding.checking')}</span>
  const state = result?.state ?? 'unknown'
  return (
    <span className="plugin-req-state" data-state={state} style={{
      display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 11.5, whiteSpace: 'nowrap',
      color: state === 'ok' ? 'var(--ok, #3aa675)' : state === 'unmet' ? 'var(--warn, #b8860b)' : 'var(--text-faint)',
    }}>
      {state === 'ok' ? <Check size={12} aria-hidden="true" /> : state === 'unmet' ? <CircleAlert size={12} aria-hidden="true" /> : <CircleHelp size={12} aria-hidden="true" />}
      {t(`plugin.onboarding.req.${state}`)}
    </span>
  )
}

const Card: React.FC<{ plugin: AmadeusPlugin }> = ({ plugin: p }) => {
  const { t, locale } = useI18n()
  const mode = useTheme((s) => s.mode)
  // 语言解析单点:英文缺失逐字段回退中文(display.ts)
  const spec = localizedOnboarding(p.onboarding, locale)!
  const reqs = requirementsOf(p)
  const results = usePluginOnboarding((s) => s.results[p.id]) ?? {}
  const checking = usePluginOnboarding((s) => !!s.checking[p.id])
  const allSettings = usePluginStore((s) => s.settings).filter((o) => o.pluginId === p.id)
  const readiness = usePluginStore((s) => s.readiness).filter((o) => o.pluginId === p.id)
  const evaluate = (withChecks: boolean): void => { void usePluginOnboarding.getState().evaluate(p.id, { checks: withChecks }) }
  // 打开即实测一遍(连 check):卡片上的每个对勾都是此刻测出来的,不是上次打开时的。
  useEffect(() => { evaluate(true) }, [p.id]) // eslint-disable-line react-hooks/exhaustive-deps

  const settingReqs = reqs.filter((r): r is Extract<PluginRequirement, { kind: 'setting' }> => r.kind === 'setting')
  const checkReqs = reqs.filter((r): r is Extract<PluginRequirement, { kind: 'check' }> => r.kind === 'check')
  const permissionIds = reqs.flatMap((r) => (r.kind === 'permission' ? [r.id] : []))
  // 「必要设置」区只放 manifest 点名、又不在前置条件里的那些(前置条件里的设置项已就地渲染在对应那一行)。
  const inReqs = new Set(settingReqs.map((r) => r.key))
  // ⚠ settings:true = 「把我自己的设置都嵌进来」,不含宿主自动给每个插件加的那行工作文件夹 ——
  //   插件多半根本不读它,把它标成「必要设置」是误导。真要它就在数组形态里点名写 workFolder。
  const extraSettings = (
    spec.settings === true ? allSettings.filter((o) => o.item.key !== AUTO_WORK_FOLDER_KEY)
      : Array.isArray(spec.settings) ? allSettings.filter((o) => (spec.settings as string[]).includes(o.item.key))
        : []
  ).filter((o) => !inReqs.has(o.item.key))
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

  const states = reqs.map((r) => results[requirementKey(r)]?.state)
  const unmetCount = states.filter((x) => x === 'unmet').length
  const unknownCount = states.filter((x) => x !== 'ok' && x !== 'unmet').length
  const allOk = !checking && reqs.length > 0 && states.every((x) => x === 'ok')

  const skip = (): void => {
    nudgeOnboardingOnce(p)
    usePluginOnboarding.getState().close()
  }
  const close = (): void => usePluginOnboarding.getState().close()

  return (
    <div className="dialog-overlay" onMouseDown={skip}>
      <div className="dialog plugin-onboarding-card" style={{ width: 'min(520px, 92vw)' }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dialog-title">{t('plugin.onboarding.title', { name: pluginDisplayName(p, locale) })}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxHeight: '64vh', overflowY: 'auto', padding: '2px 0' }}>
          {spec.intro && <div style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{spec.intro}</div>}
          <div className="plugin-onboarding-requires">
            <div className="hint" style={{ marginBottom: 6 }}>{t('plugin.onboarding.requiresTitle')}</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              {settingReqs.map((r) => {
                const def = allSettings.find((o) => o.item.key === r.key)?.item
                // SettingRow 自带标签与说明,这里只在它右侧挂状态角标 —— 再写一遍标签就成了「Name / Name」。
                return (
                  <div key={requirementKey(r)} data-requirement={requirementKey(r)} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      {def ? <SettingRow pluginId={p.id} def={def} /> : (
                        <>
                          <div style={{ fontSize: 12.5 }}>{r.key}</div>
                          <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('plugin.onboarding.req.inactive')}</div>
                        </>
                      )}
                    </div>
                    <ReqState result={results[requirementKey(r)]} />
                  </div>
                )
              })}
              {checkReqs.map((r) => {
                const reg = readiness.find((o) => o.item.id === r.id)?.item
                const label = reg ? (typeof reg.label === 'function' ? reg.label() : reg.label) : r.id
                const res = results[requirementKey(r)]
                const detail = res?.detail === 'timeout' ? t('plugin.onboarding.req.timeout') : res?.detail
                return (
                  <div key={requirementKey(r)} data-requirement={requirementKey(r)} style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div style={{ fontSize: 12.5 }}>{label}</div>
                      {detail && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{detail}</div>}
                      {!reg && <div style={{ fontSize: 11, color: 'var(--text-faint)' }}>{t('plugin.onboarding.req.inactive')}</div>}
                    </div>
                    <ReqState result={res} checking={checking} />
                  </div>
                )
              })}
              {/* 授权类直接嵌宿主的授权面板:它自带 helper 安装 / 请求互斥 / 系统引导窗收尾 / 3 秒轮询,
                  自己重写一套只会更糟。它的每次快照回灌 store,对勾跟着走。 */}
              {permissionIds.length > 0 && (
                <DesktopPermissions mode={mode} only={permissionIds}
                  onSnapshot={(snap) => { void usePluginOnboarding.getState().evaluate(p.id, { permissions: snap }) }} />
              )}
            </div>
          </div>
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
          {extraSettings.length > 0 && (
            <div>
              <div className="hint" style={{ marginBottom: 6 }}>{t('plugin.onboarding.settingsTitle')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {extraSettings.map((o) => <SettingRow key={o.item.key} pluginId={p.id} def={o.item} />)}
              </div>
            </div>
          )}
          {!!spec.recommends?.length && installed && (
            <div>
              <div className="hint" style={{ marginBottom: 6 }}>{t('plugin.onboarding.recommendsTitle')}</div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                {spec.recommends.map((r) => (
                  <RecommendRow key={`${r.type}:${r.slug}`} rec={r} preInstalled={
                    (r.type === 'plugin' || r.type === 'amadeus-plugin')
                      ? !!(installed['plugin']?.has(r.slug) || installed['amadeus-plugin']?.has(r.slug)) // 插件家族跨两目录查(后端可能误标)
                      : !!installed[r.type]?.has(r.slug)
                  } />
                ))}
              </div>
            </div>
          )}
          <div className="plugin-onboarding-summary" data-ready={allOk ? '1' : '0'} style={{ fontSize: 11.5, color: allOk ? 'var(--ok, #3aa675)' : 'var(--text-faint)' }}>
            {allOk ? t('plugin.onboarding.allReady')
              : unmetCount === 0 && !checking ? t('plugin.onboarding.someUnknown', { n: unknownCount })
                : t('plugin.onboarding.laterHint')}
          </div>
        </div>
        <div className="dialog-actions">
          {unmetCount > 0 ? (
            <>
              <button className="dialog-btn" onClick={skip}>{t('plugin.onboarding.later')}</button>
              <button className="dialog-btn" data-primary disabled={checking} onClick={() => evaluate(true)}>
                {checking ? t('plugin.onboarding.checking') : t('plugin.onboarding.recheck')}
              </button>
            </>
          ) : (
            <>
              {!allOk && <button className="dialog-btn" disabled={checking} onClick={() => evaluate(true)}>{t('plugin.onboarding.recheck')}</button>}
              <button className="dialog-btn" data-primary onClick={close}>{t('plugin.onboarding.done')}</button>
            </>
          )}
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
  if (!plugin || !isGate(plugin)) return null // 没有前置条件的 onboarding 是使用说明,不弹
  return (
    <div className="am-app tangu-lovable" style={{ display: 'contents' }}>
      <Card plugin={plugin} />
    </div>
  )
}
