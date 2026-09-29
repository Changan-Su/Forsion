/**
 * 设备凭据存储提示(P1-K5 S4)。三种状态,一切正常(level=os 且无锁定)不渲染:
 *   - restart  这次运行拿不到系统加密(macOS 钥匙串被拒绝 / 没解锁、Windows DPAPI 失败,或 Linux 这次没起钥匙串而盘上有加密条目)。
 *              Chromium 一个进程只试一次钥匙串,进程内「重试」救不回 → 只给「重启 Forsion」(Linux 另给「重新登记本机」)。
 *   - locked   存着却解不开(钥匙串被重置 / 条目坏了):「重试」+「重新登记本机」(配对锁定时;确认框由主进程弹)。
 *   - plaintext Linux 没有可用的系统钥匙串,配对 / token 兼容回落明文(= 旧行为),远程会话不可开。
 * 数据来自 window.tangu.secretStorage*(主进程 secrets:* IPC,只收本机可信发送方);移动端 / web 没有这座桥 → 不渲染。
 * 挂载点:Unit 切换器脚部「允许其他设备连接本机」开关之下(INTEGRATION §2.2 脚部顺序:父开关 → 本提示 → 远程会话子开关);
 * 设置页「外部连接」面板(slot="externalToken":只在 token 锁定 / 系统加密不可用时出现,Linux 明文降级不在那里重复提示)。
 */
import React, { useEffect, useState } from 'react'
import { ShieldAlert } from 'lucide-react'
import { registerMessages, useI18n } from '../i18n'
import type { SecretSlot, SecretStorageStatus } from '../../../shared/secretStorage'
import '../styles/unitSwitcher.css'

registerMessages({
  'unit.secrets.plaintextTitle': { zh: '系统钥匙串不可用，本机设备凭据以明文保存', en: "System keyring unavailable. This device's credentials are stored in plain text" },
  'unit.secrets.plaintextHint': { zh: '安装并解锁 GNOME Keyring 或 KWallet 后重启 Forsion 即可加密保存。此状态下无法开启远程会话。', en: "Install and unlock GNOME Keyring or KWallet, then restart Forsion to encrypt them. Remote sessions can't be turned on in this state." },
  'unit.secrets.unavailableTitle': { zh: '系统加密暂时不可用', en: "System encryption isn't available right now" },
  'unit.secrets.lockedTitle': { zh: '无法读取本机设备凭据', en: "Can't read this device's credentials" },
  'unit.secrets.lockedTitleToken': { zh: '无法读取保存的令牌', en: "Can't read the saved token" },
  'unit.secrets.restartHintKeychain': { zh: '系统钥匙串拒绝了访问，Forsion 要重启后才能再次请求。重启后在系统弹窗里选“始终允许”。', en: 'The system keychain denied access, and Forsion can only ask again after it restarts. After restarting, choose "Always Allow" in the system prompt.' },
  'unit.secrets.restartHintLinux': { zh: 'Forsion 这次启动时系统钥匙串不可用。解锁 GNOME Keyring 或 KWallet 后重启 Forsion。', en: "The system keyring wasn't available when Forsion started. Unlock GNOME Keyring or KWallet, then restart Forsion." },
  'unit.secrets.restartHint': { zh: 'Forsion 这次启动时系统加密不可用。重启 Forsion 后再试。', en: "System encryption wasn't available when Forsion started. Restart Forsion and try again." },
  'unit.secrets.lockedHint': { zh: '保存的凭据无法解密，系统钥匙串可能已被重置。可以重试；仍然不行就重新登记本机。', en: "The saved credentials can't be decrypted. The system keychain may have been reset. Try again, or re-register this device if that doesn't work." },
  'unit.secrets.lockedHintToken': { zh: '保存的令牌无法解密，系统钥匙串可能已被重置。可以重试，或重新填写令牌后保存。', en: "The saved token can't be decrypted. The system keychain may have been reset. Try again, or enter the token again and save." },
  'unit.secrets.retry': { zh: '重试', en: 'Retry' },
  'unit.secrets.restart': { zh: '重启 Forsion', en: 'Restart Forsion' },
  'unit.secrets.reset': { zh: '重新登记本机', en: 'Re-register this device' },
})

type Kind = 'restart' | 'locked' | 'plaintext'

/** 纯判定(无副作用,单测直测):该不该出现、出现成哪一种、给哪些按钮。 */
export function secretNoticeView(st: SecretStorageStatus, slot?: SecretSlot): { kind: Kind; lockedHere: boolean; canReset: boolean } | null {
  const lockedHere = slot ? st.locked.includes(slot) : st.locked.length > 0
  if (slot) {
    if (!lockedHere && st.level !== 'unavailable') return null // 外部连接面板:Linux 明文降级不在这里重复提示
  } else if (st.level === 'os' && !lockedHere) return null
  const kind: Kind = st.restartRequired ? 'restart' : lockedHere ? 'locked' : 'plaintext'
  // 重新登记只在配对锁定时;这次运行加密不可用(unavailable)时新配对存不下,主进程也会拒绝
  const canReset = slot !== 'externalToken' && st.locked.includes('unitPairing') && st.level !== 'unavailable'
  return { kind, lockedHere, canReset }
}

export function SecretStorageNotice({ onChange, slot, className }: { onChange?: (s: SecretStorageStatus) => void; slot?: SecretSlot; className?: string } = {}): React.ReactElement | null {
  const { t } = useI18n()
  const [st, setSt] = useState<SecretStorageStatus | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let live = true
    void window.tangu?.secretStorageStatus?.().then((s) => { if (live) setSt(s) }).catch(() => {})
    return () => { live = false }
  }, [])

  if (!st) return null
  const view = secretNoticeView(st, slot)
  if (!view) return null
  const { kind, lockedHere, canReset } = view
  const token = slot === 'externalToken'

  const act = (fn: (() => Promise<SecretStorageStatus>) | undefined): void => {
    if (busy || !fn) return
    setBusy(true)
    void fn().then((s) => { setSt(s); onChange?.(s) }).catch(() => {}).finally(() => setBusy(false))
  }
  const retry = window.tangu?.secretStorageRetry
  const reset = window.tangu?.secretStorageResetUnitPairing
  const relaunch = window.tangu?.secretStorageRelaunch

  const title = kind === 'plaintext'
    ? t('unit.secrets.plaintextTitle')
    : lockedHere ? (token ? t('unit.secrets.lockedTitleToken') : t('unit.secrets.lockedTitle')) : t('unit.secrets.unavailableTitle')
  const hint = kind === 'restart'
    ? (st.backend === 'keychain' ? t('unit.secrets.restartHintKeychain') : st.level === 'plaintext' ? t('unit.secrets.restartHintLinux') : t('unit.secrets.restartHint'))
    : kind === 'locked' ? (token ? t('unit.secrets.lockedHintToken') : t('unit.secrets.lockedHint')) : t('unit.secrets.plaintextHint')

  return (
    <div className={className ? `secnotice ${className}` : 'secnotice'} role="status" data-secrets={kind}>
      <span className="secnotice-ic" aria-hidden><ShieldAlert size={13} /></span>
      <div className="secnotice-body">
        <div className="secnotice-title">{title}</div>
        <div className="secnotice-hint">{hint}</div>
        {kind !== 'plaintext' && (
          <div className="secnotice-actions">
            {kind === 'restart'
              ? relaunch && <button className="btn sm" disabled={busy} onClick={() => act(() => relaunch())}>{t('unit.secrets.restart')}</button>
              : retry && <button className="btn sm" disabled={busy} onClick={() => act(() => retry())}>{t('unit.secrets.retry')}</button>}
            {reset && canReset && (
              // 确认框在主进程弹(原生、挂本窗口):渲染层这里不再 window.confirm
              <button className="btn ghost sm" disabled={busy} onClick={() => act(() => reset())}>{t('unit.secrets.reset')}</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
