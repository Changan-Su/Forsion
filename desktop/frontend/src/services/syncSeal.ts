/**
 * 先封住、暂不同步的那几类(2026-11-27 智库同步统一方案第 0 步:同步先从智库做起)。
 * 封法:入口锁住、不再跑;用户存下的选择一个字不改;云端已有的那份不删;放开时改成 false,界面和动作原样回来。
 * 界面上锁住的写「暂不同步」(i18n `sync.sealed`),不写「已关闭」:不是用户关的,以后会回来。
 * 「我的资料」与默认日历(human/,经引擎 POST /agent/sync)照常同步;库里 Plugins/<插件> 的工作文件夹是智库内容,不在封的范围。
 */

/** Agents(及记忆)。开关本身是引擎契约 contracts/agentSyncSeal.ts(引擎在动作层封:Agent 文件夹不推不拉、总闸 PUT 回 409、
 *  保存 Agent 不收 cloudSync),这里转出给宿主界面用:Agent 的同步开关锁住,不发会改存值的请求。Tangu 界面直接引契约。 */
export { AGENT_SYNC_SEALED } from '../../../../tangu-agent/src/contracts/agentSyncSeal'

/** 插件数据(ctx.loadData / saveData 那份随账号同步的 JSON,amadeus/plugins/pluginDataSync.ts)。 */
export const PLUGIN_DATA_SYNC_SEALED = true
