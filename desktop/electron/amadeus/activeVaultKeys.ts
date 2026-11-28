/** 在线库的宿主通道(智库同步第 3 步 H3;桌面专属,web / mobile 没有)。preload 和主进程共用这一份。 */
export const ACTIVE_VAULT_IPC = {
  get: 'amadeus:active-vault:get',
  set: 'amadeus:active-vault:set',
  changed: 'amadeus:active-vault:changed', // main → 全部窗口:{ ref }
  openOnline: 'amadeus:open-online', // main → 主窗:{ ref, requestId }
  openOnlineResult: 'amadeus:open-online:result', // 主窗 → main:{ requestId, ok:false, code? },只报失败
  onlineCapable: 'amadeus:online-capable', // 主窗 → main:装好转发壳以后发一次
} as const
