/**
 * Local | Cloud vault 切换(历史上的胶囊滑块)。
 * 2026-08-23:桌面端胶囊本体迁入 Ribbon 的 Unit 切换器(components/UnitSwitcher.tsx 的
 * 本地/云端两行,同一 switchVaultSide 语义)——本组件在桌面只剩「云端侧未登录」的登录引导条;
 * mobile 分支(amadeusVaultMode 桥)保持原胶囊形态不变。样式在 views/chat2/sidebar2.css。
 */
import React, { useEffect, useState } from 'react'
import { usePageStore } from '../amadeus/store/pageStore'
import { useI18n } from '../i18n'
import type { AmadeusSyncStatus } from '../types'

export function VaultSideSwitch(): React.ReactElement | null {
  const { t } = useI18n()
  const side = usePageStore((s) => s.vaultSide)
  const initSide = usePageStore((s) => s.initVaultSide)
  const [busy, setBusy] = useState(false)
  const [sync, setSync] = useState<AmadeusSyncStatus | null>(null)

  useEffect(() => {
    const api = window.amadeusSync
    if (!api) return
    void initSide()
    void api.get().then(setSync).catch(() => {})
    return api.onStatus(setSync)
  }, [initSide])

  // 移动端(无同步引擎;本地/云端 = 两个独立 bridge,运行时换桥):window.amadeusVaultMode 解闸。
  // 登录已由 mobileShim 前置(未登录不挂载),无需 needLogin 分支。
  // ⚠️ 选中态读 `side`(pageStore)而**不是** mobileMode.side —— 后者是普通对象属性,变了不会触发重渲染。
  // 切换不再整页 reload,组件活着,必须靠订阅才动。
  const mobileMode = (window as unknown as {
    amadeusVaultMode?: { side: 'local' | 'cloud'; switch(next: 'local' | 'cloud'): void | Promise<void> }
  }).amadeusVaultMode
  if (!window.amadeusSync && mobileMode) {
    const pickMobile = (next: 'local' | 'cloud'): void => {
      if (busy || next === side) return
      setBusy(true)
      void Promise.resolve(mobileMode.switch(next)).finally(() => setBusy(false))
    }
    return (
      <div className="t2s-vaultseg" role="tablist" aria-label="vault side" data-busy={busy || undefined}>
        <div className="t2s-vaultseg-thumb" data-side={side} />
        <button role="tab" aria-selected={side === 'local'} className={side === 'local' ? 'on' : ''} onClick={() => pickMobile('local')}>
          {t('notes.cloud.local')}
        </button>
        <button role="tab" aria-selected={side === 'cloud'} className={side === 'cloud' ? 'on' : ''} onClick={() => pickMobile('cloud')}>
          {t('notes.cloud.cloud')}
        </button>
      </div>
    )
  }
  if (!window.amadeusSync) return null

  const needLogin = side === 'cloud' && sync?.state === 'auth-required'
  const loginHint = needLogin && (
    <div className="t2s-vaultseg-hint">
      {t('notes.cloud.loginHint')}
      {window.tangu?.forsionLogin && (
        <button className="t2s-vaultseg-login" onClick={() => void window.tangu?.forsionLogin?.()}>
          {t('notes.cloud.loginBtn')}
        </button>
      )}
    </div>
  )

  // 全量桌面:胶囊已迁入 Ribbon 的 Unit 切换器(components/UnitSwitcher.tsx,2026-08-23),
  // 此处只保留云端侧登录引导。⚠️ FORSION_PRODUCT=amadeus 单品无 agent 后端 → preload 删了
  // unitsList → 切换器不上架,这里必须保留原胶囊,否则库切换整个消失(Codex P1)。
  if (window.tangu?.unitsList) return loginHint || null

  const pick = (next: 'local' | 'cloud'): void => {
    if (busy || next === side) return
    setBusy(true)
    void usePageStore.getState().switchVaultSide(next).finally(() => setBusy(false))
  }
  return (
    <>
      <div className="t2s-vaultseg" role="tablist" aria-label="vault side" data-busy={busy || undefined}>
        <div className="t2s-vaultseg-thumb" data-side={side} />
        <button role="tab" aria-selected={side === 'local'} className={side === 'local' ? 'on' : ''} onClick={() => pick('local')}>
          {t('notes.cloud.local')}
        </button>
        <button role="tab" aria-selected={side === 'cloud'} className={side === 'cloud' ? 'on' : ''} onClick={() => pick('cloud')}>
          {t('notes.cloud.cloud')}
        </button>
      </div>
      {loginHint}
    </>
  )
}
