/**
 * 会话级远程污点(P1 · M1A;K9 G7「Muse 周期提示词里的远程会话原话」)。
 *
 * 远端(手机 / 设备页 / 局域网)驱动过的会话,原话会经「最近会话标题」「日志摘要」「活动尾部」「自动召回片段」这些**自动**上下文源
 * 流进本机不带污点的 run —— 尤其是 Muse(无人值守、审批档可能比远程上限宽):这是提示注入的洗白通道。与 P0「远程轮不写长期记忆」
 * (localHistorian.historianRoundRemote)同一条规矩:远端内容不自动进本机无污点的上下文。
 *
 * 判据(一个 SQL 谓词,两方言):会话 agent_config.remoteOrigin 在场(远端建 / 分支 / 改过项目路径),**或**会话里有任一 run 的
 * input.remote(远端起的)或 input.remoteTainted(本机起、中途被远端 steer / 答审批 / 答询问染上的 —— 那张表只在进程内,
 * 这里在首次染色时落进 run 行,重启后照样认得)。agent_runs 只随会话删除而删,判据长期有效。
 * ⚠️ 刻意不给被染色的本机会话盖 remoteOrigin:那个标记还管设备页 /unit/host* 的读范围(P0 D1),盖上会让手机接着聊的本机项目会话
 *    读不了自己的项目文件。
 * ⚠️ 这不是授权依据(引擎唯一认的污点仍是 run.input.remote / effectiveRemote);只决定「远端内容能不能自动流进别处」。
 */
import { getDbType, query } from '../core/db.js';
import { effectiveRemote, onRunTainted, type RemoteInfo } from './remoteOrigin.js';

/** 「会话 alias 没有远程污点」的 SQL 谓词(无参数)。坏 JSON 的 agent_config 按有污点算(fail-closed:藏起来比放进去安全)。 */
export function notRemoteTaintedSql(alias = 's'): string {
  const cfg = `${alias}.agent_config`;
  if (getDbType() === 'sqlite') {
    return `NOT ((${cfg} IS NOT NULL AND (json_valid(${cfg}) = 0 OR json_type(${cfg}, '$.remoteOrigin') IS NOT NULL))`
      + ` OR EXISTS (SELECT 1 FROM agent_runs rt WHERE rt.session_id = ${alias}.id AND rt.input IS NOT NULL AND json_valid(rt.input)`
      + ` AND (json_type(rt.input, '$.remote') IS NOT NULL OR json_type(rt.input, '$.remoteTainted') IS NOT NULL)))`;
  }
  // PG:jsonb 的 `?` 运算符会被 query() 当占位符换成 $n,改用 -> IS NOT NULL
  return `NOT ((jsonb_typeof(${cfg}) = 'object' AND (${cfg} -> 'remoteOrigin') IS NOT NULL)`
    + ` OR EXISTS (SELECT 1 FROM agent_runs rt WHERE rt.session_id = ${alias}.id AND jsonb_typeof(rt.input) = 'object'`
    + ` AND ((rt.input -> 'remote') IS NOT NULL OR (rt.input -> 'remoteTainted') IS NOT NULL)))`;
}

/**
 * search_sessions / read_session 要不要藏远端驱动过的会话。本 run 自己带远程污点 → 不藏(远端内容回到远端 run 不是洗白);
 * 无人值守(Muse / 自动化)与通道 run → 藏(没人看着,Muse 的档还可能比远程上限宽);本机交互 run → 不藏:那是用户在场时模型显式去翻
 * 历史,结果是工具结果(数据),与读网页同一类风险 —— 列为残余,不在这里拦。自动召回(不经任何人点头)另在 agentLoop 对一切无污点 run 藏。
 */
export function remoteRecallHide(ctx: { remote?: RemoteInfo; runId?: string; runOrigin?: string; muse?: boolean }): boolean {
  if (effectiveRemote(ctx)) return false;
  return ctx.muse === true || ctx.runOrigin === 'unattended' || ctx.runOrigin === 'channel';
}

/** 这个会话有没有远程污点(查询失败按有污点算)。 */
export async function sessionRemoteTainted(sessionId: string): Promise<boolean> {
  try {
    const rows = await query<any[]>(`SELECT 1 AS ok FROM chat_sessions s WHERE s.id = ? AND ${notRemoteTaintedSql('s')} LIMIT 1`, [sessionId]);
    return rows.length === 0;
  } catch { return true; }
}

/** 首次染色时把污点落进 run 行(input.remoteTainted = {via?, callerUnit?, at});只作记录,remoteOf 不读它。尽力而为,绝不抛。 */
export async function persistRunTaint(runId: string): Promise<void> {
  const info = effectiveRemote({ runId });
  if (!info) return;
  const mark = JSON.stringify({ ...(info.via ? { via: info.via } : {}), ...(info.callerUnit ? { callerUnit: info.callerUnit } : {}), at: new Date().toISOString() });
  try {
    if (getDbType() === 'sqlite') {
      await query(`UPDATE agent_runs SET input = json_set(CASE WHEN input IS NOT NULL AND json_valid(input) THEN input ELSE '{}' END, '$.remoteTainted', json(?)) WHERE id = ?`, [mark, runId]);
    } else {
      await query(`UPDATE agent_runs SET input = jsonb_set(CASE WHEN jsonb_typeof(input) = 'object' THEN input ELSE '{}'::jsonb END, '{remoteTainted}', CAST(? AS jsonb)) WHERE id = ?`, [mark, runId]);
    }
  } catch (e: any) {
    console.warn(`[agent-core] run=${runId} 远程污点落库失败: ${e?.message || e}`);
  }
}

// 模块单例订阅(与 remoteActivity 同法;依赖单向:本模块 → remoteOrigin,反向不 import)。agentLoop import 本模块,引擎起就挂上。
onRunTainted((runId) => { void persistRunTaint(runId); });
