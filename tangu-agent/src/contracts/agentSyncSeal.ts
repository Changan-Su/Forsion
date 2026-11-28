/**
 * Agents(及记忆)同步先封住(2026-11-27 智库同步统一方案第 0 步:同步先从智库做起)。引擎、桌面宿主、Tangu 界面共用这一个开关:
 * 引擎在动作层封(services/cloudSyncAccount.ts 重新导出它:Agent 文件夹不推不拉、总闸 PUT 回 409、保存 Agent 不收 cloudSync),
 * 界面把 Agent 的同步开关锁住、写「暂不同步」。存着的选择照实读、一个字不改;human/(我的资料与默认日历)照常同步。
 * 放开时改成 false,引擎和界面一起原样恢复。
 */
export const AGENT_SYNC_SEALED = true;
