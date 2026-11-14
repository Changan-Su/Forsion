/**
 * 设备的 Unit 窗(主进程 createDetachedWindow({ unit }),?window=detached&unit=<设备 id>):一扇窗只看一台设备。
 * 只画设备页那套整窗的框(UnitFrame / UnitRemoteSurface):标题条胶囊「名字 · 我的设备」(没有「回到这台电脑」,关窗就是回来)、
 * 左下角宿主头像(点开的账号面板不带 Unit 段:unitPanelAvailable 只认主窗)、webview。不挂 Shell,不写任何布局。
 *
 * 链接 forsion://unit/<id> 谁都能发(任何网页都能唤起):**名册确认是当前账号名下的设备之前不挂 webview**。
 * 名册、配置都在这扇窗里自己取;通路用同一个 pickUnitRoute,P2P 打洞只在主窗跑 —— 这里 p2p: false,记住 P2P 的按中转走、不出声。
 *
 * 宿主自己画的几种状态(铺在标题条以下):
 *   signedOut  没登录                       →「先在 Forsion 里登录」+「打开 Forsion」
 *   missing    名册里没有这台(换号 / 被移除)→「这台设备不在当前账号名下」+「打开 Forsion」
 *   unknown    名册 / 配置读失败             →「暂时连不上 Forsion 云端」+「重试」(不知道 ≠ 不存在)
 *   noBridge   这台 Forsion 没有名册桥       →「这台电脑上的 Forsion 没有设备功能」+「打开 Forsion」
 *   offline    云端不在线、直连也探不通       →「不在线」+「重试」
 * 加载失败 / 页面崩溃复用 UnitRemoteSurface 的失败态(「重试」「关闭窗口」)。
 * 换号 / 登出 / 窗口回到前台发现设备没了 → 立刻卸掉旧页面(不是藏起来),迟到的回包作废(epoch)。
 */
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useApp } from './stores/appStore'
import { useI18n, registerMessages } from './i18n'
import { unitWindowId } from './windowKind'
import { AccountCard } from './components/AccountCard'
import { UnitFrame, UnitRemoteSurface, leaveUnitRemote, runUnitRoute, useUnitRemote } from './components/UnitSwitcher'
import { pickUnitRoute, readRememberedVia, unitWindowRosterState } from './components/unitPanelModel'
import { useUnitRoster } from './components/unitRoster'
import { onAccountWillChange } from './services/accountTransition'
import type { UnitInfo } from './types'

registerMessages({
  'unit.window.loading': { zh: '正在连接…', en: 'Connecting…' },
  'unit.window.signedOut': { zh: '先在 Forsion 里登录', en: 'Sign in to Forsion first' },
  'unit.window.missing': { zh: '这台设备不在当前账号名下', en: "This device isn't on your current account" },
  'unit.window.unknown': { zh: '暂时连不上 Forsion 云端', en: "Can't reach Forsion cloud right now" },
  'unit.window.noBridge': { zh: '这台电脑上的 Forsion 没有设备功能', en: "Forsion on this computer doesn't have device features" },
  'unit.window.offline': { zh: '不在线', en: 'Offline' },
  'unit.window.openForsion': { zh: '打开 Forsion', en: 'Open Forsion' },
  'unit.window.retry': { zh: '重试', en: 'Retry' },
})

export type UnitWindowState = 'loading' | 'signedOut' | 'missing' | 'unknown' | 'noBridge' | 'offline' | 'ready'

/** 窗口回到前台时最多这么久复查一次名册(设备被移除 / 换了号要尽快卸页面,但别每次切窗都打一次云端)。 */
const RECHECK_MS = 30_000

export function UnitWindowRoot(): React.ReactElement {
  const { t } = useI18n()
  const id = unitWindowId()!
  const [state, setState] = useState<UnitWindowState>('loading')
  const [unit, setUnit] = useState<Pick<UnitInfo, 'name' | 'icon' | 'platform'> | null>(null)
  /** 每次重新判定 +1:迟到的回包只在自己仍是最后一次时落。 */
  const epoch = useRef(0)
  const lastCheck = useRef(0)
  /** 换账号握手开始的时刻(0 = 没在换):这期间不复查名册;切换完成的广播一到就清零重验。 */
  const switchingSince = useRef(0)

  useEffect(() => { useApp.getState().setTr((k, vars) => t(k, vars as Record<string, string | number> | undefined)) }, [t])

  /** 卸掉远程页面(不是藏起来):换号 / 设备没了时旧账号的页面不许留着。 */
  const drop = useCallback((): void => {
    leaveUnitRemote()
    useUnitRemote.setState({ target: null, active: false })
  }, [])

  const resolve = useCallback(async (opts: { quiet?: boolean } = {}): Promise<void> => {
    const my = ++epoch.current
    lastCheck.current = Date.now()
    if (!opts.quiet) { drop(); setState('loading') }
    const tg = window.tangu
    const settle = (s: UnitWindowState): void => {
      if (my !== epoch.current) return
      // 前台复查读不到名册 / 配置 = 不知道:正开着的页面照旧,只有「没登录」「不在名下」这种确定的结论才卸
      if (opts.quiet && (s === 'unknown' || s === 'noBridge' || s === 'offline')) return
      if (s !== 'ready') drop()
      setState(s)
    }
    // 中转地址要 cloudUrl:先取配置(这扇窗没跑 app.boot);取不到 = 不知道。
    try {
      const cfg = await tg?.getConfig?.()
      if (my !== epoch.current) return
      if (!cfg) return settle('unknown')
      useApp.setState({ desktopConfig: cfg })
    } catch { return settle('unknown') }
    let list: Parameters<typeof unitWindowRosterState>[0]
    try { list = tg?.unitsList ? await tg.unitsList() : undefined } catch { return settle('unknown') }
    if (my !== epoch.current) return
    const r = unitWindowRosterState(list, id)
    if (r.state !== 'found') return settle(r.state)
    const u = r.unit
    setUnit({ name: u.name, icon: u.icon, platform: u.platform })
    document.title = u.name
    useUnitRoster.setState({ units: r.units })
    // 已经开着这台的页面(回到前台的复查):名册里还在就不动它。
    const cur = useUnitRemote.getState().target
    if (opts.quiet && cur?.unitId === id) { setState('ready'); return }
    let lanOk = false
    if (u.lanUrl && tg?.unitsProbeLan) lanOk = !!(await tg.unitsProbeLan(u.lanUrl).catch(() => null))
    if (my !== epoch.current) return
    const pick = pickUnitRoute(u, { lanOk, p2p: false, remembered: readRememberedVia(id) })
    if (!pick) return settle('offline')
    runUnitRoute({ kind: 'unit', id: u.id, name: u.name, icon: u.icon, platform: u.platform, via: pick.via, lanUrl: u.lanUrl })
    setState('ready')
  }, [id, drop])

  useEffect(() => {
    void resolve()
    // 握手阶段(新凭据写下去之前)就卸掉旧页面、作废在途的名册回包;只接现成的 onAccountWillChange,不另订一条握手事件
    const offWill = onAccountWillChange(() => {
      switchingSince.current = Date.now()
      epoch.current++
      drop()
      setState('loading')
    })
    const offAuth = window.tangu?.onAuthChanged?.(() => { switchingSince.current = 0; void resolve() })
    // 回到前台复查名册(被移除 / 换号):只在「已打开」时安静地查,别把正在用的页面闪一下
    const onFocus = (): void => {
      // 正在换号:等切换完成的广播(握手卡住超过一分钟才放行,免得一直停在「正在连接」)
      if (switchingSince.current && Date.now() - switchingSince.current < 60_000) return
      if (Date.now() - lastCheck.current < RECHECK_MS) return
      void resolve({ quiet: useUnitRemote.getState().target?.unitId === id })
    }
    window.addEventListener('focus', onFocus)
    return () => { offWill(); offAuth?.(); window.removeEventListener('focus', onFocus); epoch.current++ }
  }, [resolve, id])

  const openForsion = (): void => { window.tangu?.unitsShowMain?.() }
  const frameTarget = { key: `${id}:`, name: unit?.name ?? '', icon: unit?.icon, platform: unit?.platform }

  return (
    <div className="shell-host unitwin" data-unit-window={state}>
      {/* 宿主头像的数据来源(accountChip 由 AccountCard 发布);卡本身不显示,面板锚在框左下角那枚头像上 */}
      <div className="unitwin-account" aria-hidden="true">
        <AccountCard compact onToast={useApp.getState().toast} />
      </div>
      {state === 'ready'
        ? <UnitRemoteSurface />
        : (
          <UnitFrame target={frameTarget}>
            {state === 'loading'
              ? <div className="unitfr-fail" role="status"><div className="unitfr-fail-title unitwin-dim">{t('unit.window.loading')}</div></div>
              : (
                <div className="unitfr-fail" role="alert" data-unit-window-state={state}>
                  <div className="unitfr-fail-title">{t(`unit.window.${state}`)}</div>
                  <div className="unitfr-fail-actions">
                    {state === 'unknown' || state === 'offline'
                      ? <button type="button" className="btn primary" onClick={() => void resolve()}>{t('unit.window.retry')}</button>
                      : <button type="button" className="btn primary" onClick={openForsion}>{t('unit.window.openForsion')}</button>}
                  </div>
                </div>
              )}
          </UnitFrame>
        )}
    </div>
  )
}
