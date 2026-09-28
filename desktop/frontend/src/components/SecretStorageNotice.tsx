/**
 * 设备凭据存储提示(P1-K5 S4):本机设备凭据(配对 / external token)只能明文保存(没有可用的系统钥匙串),
 * 或存着却读不出来(钥匙串拒绝访问 / 被重置)时出现;一切正常(level=os 且无锁定)不渲染。
 * 锁定时给「重试」(用户点的那一刻才弹系统钥匙串)与「重新登记本机」(新设备 ID,需确认)。
 * 数据来自 window.tangu.secretStorage*(主进程 secrets:* IPC,只收本机可信发送方);移动端 / web 没有这座桥 → 不渲染。
 * 挂在 Unit 切换器脚部「允许其他设备连接本机」开关之下(INTEGRATION §2.2 脚部顺序:父开关 → 本提示 → 远程会话子开关),
 * 远程会话设置页也可以复用(无必填 props)。
 */
import React, { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import type { SecretStorageStatus } from '../../../shared/secretStorage'
import '../styles/unitSwitcher.css'

registerMessages({
  'unit.secrets.plaintextTitle': { zh: '系统钥匙串不可用，本机设备凭据以明文保存', en: "System keyring unavailable. This device's credentials are stored in plain text" },
  'unit.secrets.plaintextHint': { zh: '安装并解锁 GNOME Keyring 或 KWallet 后重启 Forsion 即可加密保存。此状态下无法开启远程会话。', en: "Install and unlock GNOME Keyring or KWallet, then restart Forsion to encrypt them. Remote sessions can't be turned on in this state." },
  'unit.secrets.lockedTitle': { zh: '无法读取本机设备凭据', en: "Can't read this device's credentials" },
  'unit.secrets.lockedHint': { zh: '系统钥匙串拒绝了访问或已被重置。重试时请在系统弹窗里点“始终允许”。', en: 'The system keychain denied access or was reset. When you retry, choose "Always Allow" in the system prompt.' },
  'unit.secrets.retry': { zh: '重试', en: 'Retry' },
  'unit.secrets.reset': { zh: '重新登记本机', en: 'Re-register this device' },
  'unit.secrets.resetConfirm': { zh: '将为本机生成新的设备 ID，其他设备需要重新确认对本机的信任。继续？', en: 'This gives the device a new ID. Your other devices will need to trust it again. Continue?' },
})

export function SecretStorageNotice({ onChange }: { onChange?: (s: SecretStorageStatus) => void } = {}): React.ReactElement | null {
  const { t } = useI18n()
  const [st, setSt] = useState<SecretStorageStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.tangu?.secretStorageStatus?.().then((s) => { if (live) setSt(s) }).catch(() => {})
    return () => { live = false }
  }, [])

  if (!st) return null
  const locked = st.locked.length > 0
  if (st.level === 'os' && !locked) return null

  const act = (fn: (() => Promise<SecretStorageStatus>) | undefined): void => {
    if (busy || !fn) return
    setBusy(true)
    void fn().then((s) => { setSt(s); onChange?.(s) }).catch(() => {}).finally(() => setBusy(false))
  }
  const retry = window.tangu?.secretStorageRetry
  const reset = window.tangu?.secretStorageResetUnitPairing

  return (
    <div className="secnotice" role="status" data-secrets={locked ? 'locked' : 'plaintext'}>
      <span className="secnotice-ic" aria-hidden><ShieldAlert size={13} /></span>
      <div className="secnotice-body">
        <div className="secnotice-title">{locked ? t('unit.secrets.lockedTitle') : t('unit.secrets.plaintextTitle')}</div>
        <div className="secnotice-hint">{locked ? t('unit.secrets.lockedHint') : t('unit.secrets.plaintextHint')}</div>
        {locked && (
          <div className="secnotice-actions">
            {retry && <button className="btn sm" disabled={busy} onClick={() => act(() => retry())}>{t('unit.secrets.retry')}</button>}
            {reset && st.locked.includes('unitPairing') && (
              <button className="btn ghost sm" disabled={busy} onClick={() => { if (window.confirm(t('unit.secrets.resetConfirm'))) act(() => reset()) }}>
                {t('unit.secrets.reset')}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
