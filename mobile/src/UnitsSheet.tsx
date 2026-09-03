/**
 * 互联设备(Forsion Unit)移动端入口:底部弹层列账号名下设备,点开 = **app 内的 WebView**
 * 打开对方设备页(2026-09-03 由系统浏览器改;理由见 mobileShim.openUnitPage)。**一台设备按通路拆成多行**(直连 / 中转各一行,同桌面 UnitSwitcher 口径):
 * 直连 = 设备自报的 lanUrl(T1 配对流在浏览器里走、无需账号);中转 = server 引导页(同源
 * localStorage 读 forsion_token 换 cookie 进隧道,未登录页内会提示)。
 * ⚠️ 早先是一行 + 「有 lanUrl 就走直连」,于是**报了地址的设备根本够不着中转** —— 移动端没有
 * 探针可证那个地址还通(下面「刻意不做」第一条),地址一过期这台设备就彻底打不开。
 *
 * 与桌面 UnitSwitcher 的关系:数据面同形(unitsList → {status,json}),i18n 键复用(该模块随
 * bootstrapEngine 已在 mobile 包里求值,unit.* 键已注册)。刻意不做(v1,2026-08-25):
 * - LAN 探针自动择路:WebView 跨源 fetch 被 CORS 拦,无主进程可代 —— 报了 lanUrl 就信它;
 * - 改名/图标/移除、paired 管理、本机作 host:移动端不作被连方(用户拍板)。
 */
import React, { useEffect, useState } from 'react'
import { create } from 'zustand'
import { ArrowRight, Laptop, Monitor, MonitorSmartphone, Smartphone, X } from 'lucide-react'
import { addRibbonIcon } from '@lcl/engine'
import { registerMessages, useI18n } from '@/i18n'
import { useApp } from '@/stores/appStore'
import type { UnitInfo } from '@/types'

/** 引导页基址 = mobileShim cfg.cloudUrl(已含 /api,≠桌面 cloudUrl 语义)。本组件只活在
 *  mobileShim 环境(unitsList 门控),不能 import capacitorAuth —— 会把 @capacitor/* 拖进
 *  web 构建图,撞 capacitor-stub-gate(build-unit-web 实翻)。
 *  `#token=`:App 登录态递交面 —— 系统浏览器没登录过 Forsion 网页版,同源 localStorage 读不到
 *  token(用户实报「明明登录了却提示没登录」)。fragment 不出网络/不进 server 日志(≠ query),
 *  引导页用完即 replaceState 剥掉、不落 localStorage,进隧道仍靠 HttpOnly cookie。 */
const guideUrl = (unitId: string): string => {
  const base = `${String(useApp.getState().desktopConfig?.cloudUrl || '').replace(/\/+$/, '')}/units/${unitId}/open`
  const token = useApp.getState().cfg.token
  return token ? `${base}#token=${encodeURIComponent(token)}` : base
}

registerMessages({
  'unit.mobileNone': { zh: '名下还没有可连的设备:在电脑上登录同一 Forsion 账号,并开启「允许其他设备连接本机」', en: 'No devices yet — sign in with this Forsion account on a computer and enable "Allow other devices to connect".' },
  'unit.mobileTunnel': { zh: '经云端中转打开(自动使用本机登录态)', en: 'Opens via cloud relay (uses this device’s login automatically)' },
})

export const useUnitsSheet = create<{ open: boolean; setOpen: (v: boolean) => void }>((set) => ({
  open: false,
  setOpen: (v) => set({ open: v }),
}))

/** 左抽屉底部常驻入口(设置钮左侧,mobileFoot;曾住「⋯」菜单被用户报太隐蔽 2026-08-30)。
 *  数据桥在才上架:App=mobileShim.unitsList;设备页(unitShim)/Tangu Web(webShim)无此桥 → 自然隐藏。 */
export function installUnitsEntry(): void {
  if (!window.tangu?.unitsList) return
  addRibbonIcon({
    id: 'rb-units-mobile',
    side: 'bottom',
    mobileFoot: true,
    icon: MonitorSmartphone,
    tooltip: () => useApp.getState().tr('unit.switcher'),
    onClick: () => useUnitsSheet.getState().setOpen(true),
  })
}

/** 设备页一律开在**本 app 内的 WebView**(mobileShim.openUnitPage):被弹去系统浏览器观感上就是
 *  离开了 App,与桌面「整个主区切过去」不是一回事(用户 2026-09-03 实报)。三级回落:
 *  app 内 WebView → 系统浏览器 → 新标签页,任一档缺席或失败都不至于「点了没反应」。
 *
 *  ⚠️ 必须逐级 **await**,不能写成 `a?.(url) ?? b?.(url) ?? c()`:`??` 判的是**同步返回值**,而这些
 *  桥返回的是 Promise —— 永远非空,后面两档等于死代码;桥一旦 reject 还会变成未处理拒绝,表现正好
 *  就是「点了没反应」(Codex 评审 medium)。 */
const openUrl = (url: string): void => {
  void (async () => {
    for (const open of [window.tangu?.openUnitPage, window.tangu?.openExternal]) {
      if (!open) continue
      try { await open(url); return } catch { /* 这一档不成,落下一档 */ }
    }
    window.open(url, '_blank', 'noopener')
  })()
}
/** 设备页直连地址必须带尾斜杠(页面用相对 base,同桌面口径)。⚠️只用于 lanUrl/手输地址 ——
 *  引导页 /open 加了尾斜杠反而把页内相对路径(../session、./proxy/)整个解歪。 */
const withSlash = (u: string): string => (u.endsWith('/') ? u : `${u}/`)

/** 通路徽标(直连/中转):同一台设备拆成两行,靠它一眼分开。 */
const viaTag: React.CSSProperties = { flex: 'none', fontStyle: 'normal', fontSize: 11, fontWeight: 500, lineHeight: '16px', padding: '0 6px', borderRadius: 999, background: 'rgba(128,128,128,.16)', opacity: 0.85 }

const rowIcon = (u: UnitInfo): React.ReactNode => {
  if (u.icon) return <span style={{ fontSize: 18 }} aria-hidden>{u.icon}</span>
  if (u.platform === 'android' || u.platform === 'ios') return <Smartphone size={18} />
  if (u.platform === 'win32' || u.platform === 'linux') return <Monitor size={18} />
  return <Laptop size={18} />
}

export function MobileUnitsSheet(): React.ReactElement | null {
  const { t } = useI18n()
  const open = useUnitsSheet((s) => s.open)
  const setOpen = useUnitsSheet((s) => s.setOpen)
  /** null=未登录(401);undefined=加载中。 */
  const [units, setUnits] = useState<UnitInfo[] | null | undefined>(undefined)
  const [addr, setAddr] = useState('')

  useEffect(() => {
    if (!open) return
    setUnits(undefined)
    void window.tangu?.unitsList?.()
      .then((r) => setUnits(r?.status === 200 ? ((r.json as { units?: UnitInfo[] } | null)?.units ?? []) : r?.status === 401 ? null : []))
      .catch(() => setUnits([]))
  }, [open])

  // Android 系统返回:弹层开着时接管并关闭(同 SingleColumnHost 两个 sheet 的语义,事件可取消),
  // 否则全局返回把底下视图切走/最小化 App 而弹层还悬着(Codex 四轮 P2)。
  useEffect(() => {
    if (!open) return
    const onBack = (e: Event): void => { e.preventDefault(); setOpen(false) }
    window.addEventListener('forsion:mobile-back', onBack)
    return () => window.removeEventListener('forsion:mobile-back', onBack)
  }, [open, setOpen])

  if (!open) return null

  const openByAddress = (): void => {
    const raw = addr.trim()
    if (!raw) return
    openUrl(withSlash(/^https?:\/\//i.test(raw) ? raw : `http://${raw}`))
  }

  const row: React.CSSProperties = { display: 'flex', alignItems: 'center', gap: 12, width: '100%', padding: '12px 16px', background: 'none', border: 'none', textAlign: 'left', color: 'inherit', font: 'inherit' }

  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 60, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', background: 'rgba(0,0,0,.32)' }} onClick={() => setOpen(false)}>
      <div
        style={{ background: 'var(--bg)', color: 'var(--text, inherit)', borderRadius: '16px 16px 0 0', maxHeight: '72vh', display: 'flex', flexDirection: 'column', paddingBottom: 'env(safe-area-inset-bottom)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ display: 'flex', alignItems: 'center', padding: '14px 16px 6px' }}>
          <strong style={{ flex: 1, fontSize: 15 }}>{t('unit.switcher')}</strong>
          <button aria-label="close" style={{ background: 'none', border: 'none', color: 'inherit', padding: 4 }} onClick={() => setOpen(false)}><X size={18} /></button>
        </div>
        <div style={{ overflowY: 'auto', flex: 1 }}>
          {units === undefined && <div style={{ padding: '18px 16px', opacity: 0.6, fontSize: 13 }}>…</div>}
          {units === null && <div style={{ padding: '18px 16px', opacity: 0.6, fontSize: 13 }}>{t('unit.notLoggedIn')}</div>}
          {units && units.length === 0 && <div style={{ padding: '18px 16px', opacity: 0.6, fontSize: 13, lineHeight: 1.7 }}>{t('unit.mobileNone')}</div>}
          {(units || []).flatMap((u) => {
            const lanUrl = u.lanUrl
            const vias: Array<'lan' | 'tunnel'> = lanUrl ? ['lan', 'tunnel'] : ['tunnel']
            return vias.map((via) => {
              const dim = via === 'tunnel' && !u.online // 中转要 server 通道在;直连与登录态无关
              return (
                <button
                  key={`${u.id}:${via}`}
                  style={{ ...row, opacity: dim ? 0.55 : 1 }}
                  onClick={() => openUrl(via === 'lan' ? withSlash(lanUrl!) : guideUrl(u.id))}
                >
                  {rowIcon(u)}
                  <span style={{ flex: 1, minWidth: 0 }}>
                    <span style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14 }}>
                      <span style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{u.name}</span>
                      <em style={viaTag}>{t(via === 'lan' ? 'unit.viaLan' : 'unit.viaTunnel')}</em>
                      {dim && <em style={{ fontStyle: 'normal', fontSize: 11, opacity: 0.7 }}>{t('unit.offline')}</em>}
                    </span>
                    <span style={{ display: 'block', fontSize: 12, opacity: 0.55, marginTop: 2 }}>
                      {t(via === 'lan' ? 'unit.deviceLanDesc' : 'unit.mobileTunnel')}
                    </span>
                  </span>
                  <ArrowRight size={15} style={{ opacity: 0.4 }} />
                </button>
              )
            })
          })}
          {/* 手输地址直连(T1):对方切换器脚部可见,如 http://192.168.1.5:8791 */}
          <div style={{ padding: '10px 16px 16px', borderTop: '1px solid rgba(128,128,128,.18)', marginTop: 6 }}>
            <div style={{ fontSize: 12, opacity: 0.55, marginBottom: 8 }}>{t('unit.byAddressDesc')}</div>
            <div style={{ display: 'flex', gap: 8 }}>
              <input
                value={addr}
                onChange={(e) => setAddr(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') openByAddress() }}
                placeholder="http://<ip>:<port>"
                inputMode="url"
                style={{ flex: 1, minWidth: 0, padding: '9px 12px', borderRadius: 10, border: '1px solid rgba(128,128,128,.3)', background: 'transparent', color: 'inherit', font: 'inherit', fontSize: 13 }}
              />
              <button
                style={{ padding: '9px 14px', borderRadius: 10, border: '1px solid rgba(128,128,128,.3)', background: 'none', color: 'inherit', fontSize: 13 }}
                onClick={openByAddress}
              >{t('unit.byAddress')}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
