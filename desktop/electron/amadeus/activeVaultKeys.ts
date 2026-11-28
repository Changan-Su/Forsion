/** 在线库的宿主通道(智库同步第 3 步 H3;桌面专属,web / mobile 没有)。preload 和主进程共用这一份。 */
export const ACTIVE_VAULT_IPC = {
  get: 'amadeus:active-vault:get',
  set: 'amadeus:active-vault:set',
  changed: 'amadeus:active-vault:changed', // main → 全部窗口:{ ref }
  openOnline: 'amadeus:open-online', // main → 主窗:{ ref, requestId }
  openOnlineResult: 'amadeus:open-online:result', // 主窗 → main:{ requestId, ok:false, code? },只报失败
  onlineCapable: 'amadeus:online-capable', // 主窗 → main:装好转发壳以后发一次
  onlineOpened: 'amadeus:online-opened', // 主窗 → main(invoke):{ ref | null },转发壳实际换好的库;宿主据此判「在线」,不看盘
  migrate: 'amadeus:active-vault:migrate', // 主窗 → main(invoke):老镜像配置按需迁成 activeVault,回 ref | null
} as const
