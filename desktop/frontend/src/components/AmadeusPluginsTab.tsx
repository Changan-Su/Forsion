/**
 * 设置 → Forsion 插件:列表(卡片可点击)+ 详情页(manifest 信息/启停/依赖应用一键安装/插件命令/README)。
 * 依赖应用安全模型:manifest 只声明 requiresApp id,安装命令文本在宿主 KNOWN_APPS 白名单表,
 * 执行复用 env:run 通道(opaque installId+流式输出);连接探测由 renderer 直连(CSP 放行 localhost)。
 * 数据源是 vendored 的 usePluginStore(与 Amadeus Space 同一单例);样式照 PluginsTab 的 hint/btn 约定。
 */
import React, { useEffect, useRef, useState } from 'react'
import { ArrowLeft } from 'lucide-react'
import { usePluginStore } from '@amadeus/plugins/pluginStore'
import { amadeus } from '@amadeus/api'
import { installAmadeusPlugins } from '../amadeusPlugins'
import { usePluginOnboarding, needsOnboarding, promptIfPending } from '../stores/pluginOnboardingStore'
import { useI18n } from '../i18n'
import { pluginDisplayName, pluginDisplayDescription, resolvePluginDetail } from '../amadeus/plugins/display'
import { Markdown } from './Markdown'
import { KNOWN_APPS } from '../../../shared/knownApps'
import { setPluginEnabled, type PluginInfo } from '../services/backendService'
import { loadUserSpaces } from '../userSpaces'
import { BuiltinPluginsSection } from '../builtins'
import { useApp } from '../stores/appStore'
import type { TanguDesktopConfig } from '../types'
import type { AmadeusPlugin, SettingContribution, SettingsViewContribution } from '@amadeus/plugins/types'

/** 同一插件的级联串行链:快速连点按序执行,防两批 PUT 乱序落成「父关子开」(codex P1-4)。 */
const cascadeChain = new Map<string, Promise<void>>()

/** 启停后的捆绑包级联:内嵌 Space 显隐同步 + 内嵌引擎插件随父插件同开同关(经引擎 HTTP)。
 *  纪律(codex P1-4/P1-5):以父插件**实际**启用结果为准(setup 抛错=未启用,不按点击意图猜);
 *  用户目录手装的同 id(loader 优先级更高的覆盖版)与首方内置不归捆绑包管,跳过;失败 toast,不静默。 */
function cascadeAfterToggle(
  p: AmadeusPlugin,
  cfg?: TanguDesktopConfig | null,
  onEngineReload?: () => void,
  enginePlugins?: PluginInfo[] | null,
): Promise<void> {
  const run = async (): Promise<void> => {
    void loadUserSpaces() // 无 bundle 时幂等无害
    const ids = p.bundle?.enginePlugins ?? []
    if (!ids.length || !cfg) return
    const on = usePluginStore.getState().isActive(p.id)
    let userOwned = new Set<string>()
    try {
      userOwned = new Set(((await window.tangu?.pluginsUserInstalled?.()) ?? []).map((x) => x.id))
    } catch { /* 桥缺位按空集 */ }
    let failed = 0
    for (const id of ids) {
      if (userOwned.has(id)) continue // 用户手装同 id 胜出,不归本捆绑包管
      if (enginePlugins?.find((e) => e.id === id)?.source === 'builtin') continue // 首方内置同 id,绝不去动
      try {
        await setPluginEnabled(cfg, id, on)
      } catch {
        failed += 1
      }
    }
    if (failed) useApp.getState().toast(useApp.getState().tr('settings.amadeusPlugins.cascadeFail', { n: String(failed) }), true)
    onEngineReload?.()
  }
  const prev = cascadeChain.get(p.id) ?? Promise.resolve()
  const next = prev.then(run, run)
  cascadeChain.set(p.id, next)
  return next
}

/** 捆绑内容徽章(计数;空捆绑不渲染)。 */
const BundleChips: React.FC<{ p: AmadeusPlugin }> = ({ p }) => {
  const { t } = useI18n()
  if (!p.bundle) return null
  const parts: Array<[string, number]> = [
    ['settings.amadeusPlugins.bundleEngine', p.bundle.enginePlugins.length],
    ['settings.amadeusPlugins.bundleAgents', p.bundle.agents.length],
    ['settings.amadeusPlugins.bundleSkills', p.bundle.skills.length],
    ['settings.amadeusPlugins.bundleSpaces', p.bundle.spaces.length],
  ]
  return (
    <>
      {parts.filter(([, n]) => n > 0).map(([k, n]) => (
        <span key={k} style={{ ...badge, color: 'var(--accent, var(--text-faint))', borderColor: 'var(--accent, var(--border))' }}>
          {t(k, { n: String(n) })}
        </span>
      ))}
    </>
  )
}

const badge: React.CSSProperties = {
  fontSize: 10.5, color: 'var(--text-faint)', border: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))',
  borderRadius: 4, padding: '0 4px', whiteSpace: 'nowrap',
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

/** 插件自绘设置面板(registerSettingsView)的挂载点。宿主只负责给一个干净的容器、
 *  在正确的时机 mount/dispose,里面画什么完全归插件。
 *
 *  ⚠️两条纪律,踩过同类坑:
 *  ①**一容器一次挂载**:mount 只跑在 el+def 变化时。把 def 放进 deps 而不是整个 owner 对象 ——
 *    zustand 每次 set 都产出新的 { pluginId, item } 包装对象,拿它当 deps 会每次 store 变动就
 *    重挂一次面板(用户正在输入的内容当场清零)。
 *  ②**dispose 必须接异常**:第三方 dispose 抛错不能把 React 的 cleanup 链带崩,否则下一个面板
 *    挂不上去。 */
const PluginSettingsView: React.FC<{ pluginId: string; def: SettingsViewContribution }> = ({ pluginId, def }) => {
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    let dispose: (() => void) | void
    try {
      dispose = def.mount(el)
    } catch (e) {
      console.error(`[amadeus] 插件 ${pluginId} 的设置面板 mount 抛错`, e)
      el.textContent = ''
      return
    }
    return () => {
      try {
        if (typeof dispose === 'function') dispose()
      } catch (e) {
        console.error(`[amadeus] 插件 ${pluginId} 的设置面板 dispose 抛错`, e)
      }
      el.textContent = '' // 插件没清干净也不给下一次挂载留残渣
    }
  }, [pluginId, def])
  return (
    <>
      {def.title && <div className="hint">{def.title}</div>}
      <div className="plugin-card" ref={ref} />
    </>
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
    <div className="plugin-card" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
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

const PluginDetail: React.FC<{
  plugin: AmadeusPlugin
  onBack: () => void
  cfg?: TanguDesktopConfig | null
  onEngineReload?: () => void
  enginePlugins?: PluginInfo[] | null
}> = ({ plugin: p, onBack, cfg, onEngineReload, enginePlugins }) => {
  const { t, locale } = useI18n()
  const activeIds = usePluginStore((s) => s.activeIds)
  const toggle = usePluginStore((s) => s.toggle)
  const commands = usePluginStore((s) => s.commands).filter((o) => o.pluginId === p.id)
  const settings = usePluginStore((s) => s.settings).filter((o) => o.pluginId === p.id)
  const settingsViews = usePluginStore((s) => s.settingsViews).filter((o) => o.pluginId === p.id)
  usePluginOnboarding((s) => s.version) // 完成引导后徽标即时消失
  const on = activeIds.includes(p.id)
  const dep = p.requiresApp && KNOWN_APPS[p.requiresApp] ? p.requiresApp : null
  const toggleHere = (): void => {
    const wasOff = !on
    toggle(p.id)
    if (wasOff) promptIfPending(p.id) // 手动启用成功且引导未完成 → 弹就绪卡
    void cascadeAfterToggle(p, cfg, onEngineReload, enginePlugins)
  }
  const uninstall = async (): Promise<void> => {
    if (!window.confirm(t('settings.amadeusPlugins.uninstallConfirm', { name: pluginDisplayName(p, locale) }))) return
    const ids = p.bundle?.enginePlugins ?? []
    // 先级联关停内嵌引擎插件(尽力):目录一删设置落点就没了,先关能让工具即刻对模型不可见
    if (cfg) for (const id of ids) await setPluginEnabled(cfg, id, false).catch(() => {})
    try {
      await amadeus.uninstallPlugin?.(p.id)
    } catch (e: any) {
      useApp.getState().toast(e?.message || String(e), true)
      return
    }
    onBack()
    await usePluginStore.getState().reloadExternal()
    void loadUserSpaces() // 撤下其内嵌 Space
    if (ids.length) {
      // 引擎侧已装载的内嵌插件(工具/路由)无法运行期反注册 → 重启并核实;
      // 失败要说清「文件已删但引擎待重启」而非谎报成功(codex P1-8)。
      const st = await window.tangu?.backendRestart?.().catch(() => null)
      onEngineReload?.()
      if (!st || st.state === 'crashed') {
        useApp.getState().toast(t('settings.amadeusPlugins.uninstalledRestartPending', { name: pluginDisplayName(p, locale) }), true)
        return
      }
    }
    useApp.getState().toast(t('settings.amadeusPlugins.uninstalled', { name: pluginDisplayName(p, locale) }))
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
            <b style={{ fontSize: 15 }}>{pluginDisplayName(p, locale)}</b>
            <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>v{p.version}</span>
            <span style={badge}>{p.builtin ? t('settings.amadeusPlugins.builtin') : t('settings.amadeusPlugins.external')}</span>
            {p.blocked && (
              <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{blockedLabel(t, p)}</span>
            )}
            {needsOnboarding(p) && (
              <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{t('plugin.onboarding.badge')}</span>
            )}
            <BundleChips p={p} />
          </div>
          {pluginDisplayDescription(p, locale) && <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 3 }}>{pluginDisplayDescription(p, locale)}</div>}
        </div>
        {p.onboarding && !p.blocked && (
          <button className="btn ghost sm" onClick={() => usePluginOnboarding.getState().open(p.id)}>{t('plugin.onboarding.run')}</button>
        )}
        {!p.builtin && !!amadeus?.uninstallPlugin && (
          <button className="btn ghost sm" style={{ color: 'var(--danger, #c0392b)' }} onClick={() => void uninstall()}>
            {t('settings.amadeusPlugins.uninstall')}
          </button>
        )}
        <input type="checkbox" checked={on} disabled={!!p.blocked} onChange={toggleHere} style={{ cursor: p.blocked ? 'not-allowed' : 'pointer' }} />
      </div>
      {p.bundle && (
        <>
          <div className="hint">{t('settings.amadeusPlugins.bundleTitle')}</div>
          <div className="plugin-card" style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12 }}>
            {p.bundle.enginePlugins.length > 0 && <div>{t('settings.amadeusPlugins.bundleEngineList', { list: p.bundle.enginePlugins.join(', ') })}</div>}
            {p.bundle.agents.length > 0 && <div>{t('settings.amadeusPlugins.bundleAgentsList', { list: p.bundle.agents.join(', ') })}</div>}
            {p.bundle.skills.length > 0 && <div>{t('settings.amadeusPlugins.bundleSkillsList', { list: p.bundle.skills.join(', ') })}</div>}
            {p.bundle.spaces.length > 0 && <div>{t('settings.amadeusPlugins.bundleSpacesList', { list: p.bundle.spaces.join(', ') })}</div>}
            <div style={{ color: 'var(--text-faint)', fontSize: 11 }}>{t('settings.amadeusPlugins.bundleHint')}</div>
          </div>
        </>
      )}
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
          <div className="plugin-card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {settings.map((o) => <SettingRow key={o.item.key} pluginId={p.id} def={o.item} />)}
          </div>
        </>
      )}
      {/* 自绘设置面板:排在声明式旋钮之后 —— 旋钮是宿主统一样式的小项,复杂面往下放才不打断阅读节奏。
          只在插件启用时挂:停用的插件其 setup 没跑过,面板里的按钮点了也没有后端。 */}
      {on && settingsViews.map((o) => <PluginSettingsView key={o.item.id} pluginId={p.id} def={o.item} />)}
      {/* README / 更新日志:必须套 .md-body —— 裸 <Markdown> 吃的是浏览器默认样式(h1 2em、1em 段距),
          和设置页其余部分的行距对不上,观感就是「排版很乱」。同一个类也管着关于页的更新日志。 */}
      {p.readme && (
        <div className="md-body" style={{ borderTop: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))', paddingTop: 12 }}>
          <Markdown content={p.readme} />
        </div>
      )}
      {p.changelog && (
        <details style={{ borderTop: 'var(--border-width) solid var(--overlay-medium, rgba(127,127,127,.12))', paddingTop: 12 }}>
          <summary style={{ cursor: 'pointer', fontWeight: 600, fontSize: 12.5, userSelect: 'none' }}>{t('settings.amadeusPlugins.changelog')}</summary>
          <div className="md-body" style={{ paddingTop: 8 }}><Markdown content={p.changelog} /></div>
        </details>
      )}
    </div>
  )
}

export const AmadeusPluginsTab: React.FC<{
  /** 引擎连接配置:捆绑包启停级联内嵌引擎插件用(缺省 = 不级联,仅本地启停)。 */
  cfg?: TanguDesktopConfig | null
  /** 级联改动引擎插件启用态后刷新引擎插件清单(SettingsModal 的 reloadPlugins)。 */
  onEngineReload?: () => void
  /** 引擎插件清单(SettingsModal 下传):级联时识别首方内置同 id,绝不去动它们。 */
  enginePlugins?: PluginInfo[] | null
  /** 受控详情面:左栏 `fplugin:<id>` 一级项直接落到该插件的设置页,不经卡片列表。
   *  id 与返回去处**必须成对**给 —— 拆成两个可选 prop 会出现「给了 id 没给 onBack、返回点不动」
   *  的半瘫状态(codex 评审 2026-08-21)。 */
  controlledDetail?: { id: string; onBack: () => void }
}> = ({ cfg, onEngineReload, enginePlugins, controlledDetail }) => {
  const { t, locale } = useI18n()
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

  // 受控 id 解析得到才赢;插件被卸载/禁用后落回卡片列表,且**列表点得动**(见 resolvePluginDetail)。
  const { plugin: detailPlugin, controlled } = resolvePluginDetail(plugins, controlledDetail?.id, detail)
  if (detailPlugin) {
    const back = controlled && controlledDetail ? controlledDetail.onBack : () => setDetail(null)
    return <PluginDetail plugin={detailPlugin} onBack={back} cfg={cfg} onEngineReload={onEngineReload} enginePlugins={enginePlugins} />
  }

  // 内置 vs 外置分两区:Callout 标注/字数统计 是 builtin,过去和外置插件混在同一串里,
  // 而浏览器/终端(宿主原生)又单挂在最上面 —— 同样是「内置」却分三处,用户实报看不出章法。
  const builtins = plugins.filter((p) => p.builtin)
  const externals = plugins.filter((p) => !p.builtin)

  /** 一张插件卡:内置区与外置区同款(区标题已说明归属,卡上不再重复挂「内置/外置」小标签)。 */
  const renderCard = (p: AmadeusPlugin): React.ReactNode => {
    const on = activeIds.includes(p.id)
    return (
      <div
        key={p.id}
        className={`plugin-card plugin-card--link${p.blocked ? ' plugin-card--blocked' : ''}`}
        onClick={() => setDetail(p.id)}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <b style={{ fontSize: 13 }}>{pluginDisplayName(p, locale)}</b>
              <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>v{p.version}</span>
              {p.blocked && (
                <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{blockedLabel(t, p)}</span>
              )}
              {needsOnboarding(p) && (
                <span style={{ ...badge, color: 'var(--warn, #b8860b)', borderColor: 'var(--warn, #b8860b)' }}>{t('plugin.onboarding.badge')}</span>
              )}
              <BundleChips p={p} />
            </div>
            {pluginDisplayDescription(p, locale) && <div style={{ fontSize: 11.5, color: 'var(--text-faint)', marginTop: 2 }}>{pluginDisplayDescription(p, locale)}</div>}
          </div>
          <input
            type="checkbox"
            checked={on}
            disabled={!!p.blocked}
            onClick={(e) => e.stopPropagation()}
            onChange={() => { const wasOff = !on; toggle(p.id); if (wasOff) promptIfPending(p.id); void cascadeAfterToggle(p, cfg, onEngineReload, enginePlugins) }}
            style={{ cursor: p.blocked ? 'not-allowed' : 'pointer' }}
          />
        </div>
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="settings-sec">{t('settings.amadeusPlugins.builtinTitle')}</div>
      <div className="hint">{t('settings.amadeusPlugins.builtinHint')}</div>
      {/* 宿主原生能力(浏览器/终端)与编辑器内置插件排同一列 —— 来源不同,对用户是一回事。 */}
      <BuiltinPluginsSection />
      {builtins.map(renderCard)}

      <div className="settings-sec settings-sec--gap">{t('settings.amadeusPlugins.externalTitle')}</div>
      <div className="hint">{t('settings.amadeusPlugins.hint')}</div>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <button className="btn ghost sm" onClick={() => openFolder()}>{t('settings.amadeusPlugins.openFolder')}</button>
        <button className="btn ghost sm" onClick={() => void reload().then(() => loadUserSpaces())}>{t('settings.amadeusPlugins.reload')}</button>
        <button className="btn ghost sm" onClick={() => void scaffold()}>{t('settings.amadeusPlugins.scaffold')}</button>
      </div>
      {externals.length === 0 && <div className="hint">{t('settings.amadeusPlugins.empty')}</div>}
      {externals.map(renderCard)}
    </div>
  )
}
