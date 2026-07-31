/**
 * Local | Cloud 胶囊滑块:极简 segmented control,两等宽选项,滑块弹性平移 + 文字颜色过渡。
 * 常驻 Amadeus 工作区各子 view 开头;切换 = 全局切活动 vault(树/编辑器/聚合全跟随)。
 * 仅桌面(window.amadeusSync);web/mobile 渲染为 null。未登录时 Cloud 侧可切,给登录引导。
 * 样式在 views/chat2/sidebar2.css 的 .t2s-vaultseg 块。
 */
import React, { useEffect, useState } from 'react'
import { usePageStore } from '../amadeus/store/pageStore'
import { useI18n } from '../i18n'
import type { AmadeusSyncStatus } from '../types'

export function VaultSideSwitch(): React.ReactElement | null {
  const { t } = useI18n()
  const side = usePageStore((s) => s.vaultSide)
  const switchSide = usePageStore((s) => s.switchVaultSide)
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

  const pick = (next: 'local' | 'cloud'): void => {
    if (busy || next === side) return
    setBusy(true)
    void switchSide(next).finally(() => setBusy(false))
  }

  const needLogin = side === 'cloud' && sync?.state === 'auth-required'

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
      {needLogin && (
        <div className="t2s-vaultseg-hint">
          {t('notes.cloud.loginHint')}
          {window.tangu?.forsionLogin && (
            <button className="t2s-vaultseg-login" onClick={() => void window.tangu?.forsionLogin?.()}>
              {t('notes.cloud.loginBtn')}
            </button>
          )}
        </div>
      )}
    </>
  )
}
