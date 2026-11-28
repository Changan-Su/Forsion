/**
 * 在线库代发通道的推送(智库同步第 3 步 E3):Forsion Extend 主进程半身开了 `cloudvault:events:open` 的订阅以后,
 * 用 `e.sender.send('cloudvault:event', …)` 推给那个窗口。宿主 preload 只转发(window.tangu.onCloudVaultEvent),不解析、不过滤;
 * 形状以 Extend `src/core/cloudVault.ts` 为准,这里只是渲染层看到的类型。
 * - 事件:type 目前有 hello / change / presence / presence-roster / vault-moved / vault-deleted;
 * - 状态:每次(重)连都推 reset(可能连着两次,要扛重复);收到 vault-deleted 推完就关流、再推 closed。
 */
export type CloudVaultPush =
  | { subscriptionId: string; event: { type: string; data: unknown } }
  | { subscriptionId: string; state: 'open' | 'reset' | 'closed' }
