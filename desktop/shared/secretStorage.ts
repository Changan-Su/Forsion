/**
 * 设备凭据存储的状态形状(P1-K5)—— 主进程 electron/secretStore.ts 产出,渲染层 SecretStorageNotice / 远程会话开关消费。
 * 纯类型,两侧共用一份。
 */

/** 槽:本机设备配对(unitHostId + unitHostSecret)、external 模式连外部 tangu-server 的 token、P2 预留的调用方凭据。 */
export type SecretSlot = 'unitPairing' | 'externalToken' | 'unitCallerSecret'

/** 'os' = 静态存放的秘密绑定到 OS 登录会话(Keychain / DPAPI / libsecret / kwallet);'plaintext' = 没有可用的系统钥匙串。 */
export type SecretLevel = 'os' | 'plaintext'

export interface SecretStorageStatus {
  level: SecretLevel
  /** keychain | dpapi | gnome_libsecret | kwallet | kwallet5 | kwallet6 | basic_text | unknown | none */
  backend: string
  /** 存着但读不出来的槽(系统钥匙串拒绝访问 / 被重置 / 迁移校验没通过)。locked ≠ absent:不删、不覆盖、不自动重新登记。 */
  locked: SecretSlot[]
  /** 最近一次问题的原因码(os-crypto-unavailable / decrypt-failed / encrypt-failed / store-unreadable / migrate-verify-failed …)。 */
  lastError: string | null
}
