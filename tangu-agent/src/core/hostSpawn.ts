/**
 * 子进程闸:多账号模式(core/accountScope.ts)下引擎不替任何账号起子进程 —— 第一版没有「按系统用户跑命令」,
 * 起出来的进程会以引擎自己的身份读写整台机器,账号之间的隔离就没了。所有 child_process 调用点之前都过这一道。
 * 单人模式什么都不做。命令开到什么程度、命令之间怎么隔开不在这一段,这里只是缺省拒绝。
 * 唯一的例外不走这里:services/pluginScripts.ts 只跑插件包目录里自带的脚本(不经 shell、环境清空、一次一个)。这道闸没有放行开关。
 */
import { isMultiAccount } from './accountScope.js';

export class HostSpawnDeniedError extends Error {
  constructor(what: string) {
    super(`multi-account mode: starting a host process is not available (${what})`);
    this.name = 'HostSpawnDeniedError';
  }
}

/** 多账号模式下抛 HostSpawnDeniedError;单人模式原样返回。 */
export function assertHostSpawnAllowed(what: string): void {
  if (isMultiAccount()) throw new HostSpawnDeniedError(what);
}

/** 给只 resolve 不 reject 的 Promise 执行器用:多账号模式下返回拒绝原因(调用方按自己的失败值 resolve),单人模式 null。 */
export function hostSpawnDenied(what: string): string | null {
  try { assertHostSpawnAllowed(what); return null; } catch (e) { return (e as Error).message; }
}
