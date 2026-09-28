/**
 * 设备凭据存储的状态形状(P1-K5)—— 主进程 electron/secretStore.ts 产出,渲染层 SecretStorageNotice / 远程会话开关消费。
 * 纯类型,两侧共用一份。
 */

/** 槽:本机设备配对(unitHostId + unitHostSecret)、external 模式连外部 tangu-server 的 token、P2 预留的调用方凭据。 */
export type SecretSlot = 'unitPairing' | 'externalToken' | 'unitCallerSecret'

/**
 * 'os' = 静态存放的秘密绑定到 OS 登录会话(Keychain / DPAPI / libsecret / kwallet);
 * 'plaintext' = Linux 上没有可用的系统钥匙串(basic_text / unknown):配对与 external token 兼容回落明文(= 今天的行为);
 * 'unavailable' = macOS / Windows 上系统加密这一次运行里用不了(钥匙串被拒绝 / 未解锁 / DPAPI 失败):**任何秘密都不落盘**,
 *   也不回落明文。Chromium 的 OSCrypt 在一个进程里只试一次钥匙串(无论成败),所以这个状态进程内不可恢复,只能重启。
 */
export type SecretLevel = 'os' | 'plaintext' | 'unavailable'

export interface SecretStorageStatus {
  level: SecretLevel
  /** keychain | dpapi | gnome_libsecret | kwallet | kwallet5 | kwallet6 | basic_text | unknown | none */
  backend: string
  /** 存着但读不出来的槽(系统钥匙串拒绝访问 / 被重置 / 迁移校验没通过)。locked ≠ absent:不删、不覆盖、不自动重新登记。 */
  locked: SecretSlot[]
  /**
   * 进程内的「重试」救不回来,只有重启 Forsion 才可能恢复:level=unavailable,或 level=plaintext 而盘上有 enc=os 的条目
   * (Linux 这次没起钥匙串)。提示据此给「重启 Forsion」而不是「重试」;为真时主进程也拒绝「重新登记本机」(level=unavailable)。
   */
  restartRequired: boolean
  /** 最近一次问题的原因码(os-crypto-unavailable / decrypt-failed / encrypt-failed / store-unreadable / migrate-verify-failed …)。 */
  lastError: string | null
}
