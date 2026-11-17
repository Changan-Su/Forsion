/**
 * 重开对话时带出失败的那几轮。
 *
 * 一轮失败了而没有正文时,回答行不落库,失败原因只记在 agent_runs.error 上(两个循环都是这样;不落成 model 行:
 * 那会被续接规则当成「最新的回答」、被截断重发当成有内容的旧版本、被回放 / 复盘当成模型说过的话)。
 * 在线时界面靠 error 事件画出失败那一行,重开对话后就只能从这里补回来。
 *
 * - 只带本页里**用户那一句还在**的那几轮:重试 / 改了再发会把那一句连同它后面的删掉(agent_runs 不随之清理),
 *   删掉的那一轮不复活。按本页的用户 id 直接在库里筛,不先截最近 N 个 run(失败多了会把本页的挤掉)。
 * - 跑动中被插过话(steer)的那一轮不带:插话让一轮拆成几条回答,run 上只记着第一条的 id,在线时失败落在最后一段上,
 *   这里分不出是哪一段,宁可不画也不挂错。认法:这一句之后、下一个 run 自己的那一句之前,夹着不属于任何 run 的用户行。
 * - 有半截回答落了库的,客户端在那一行上补失败状态;没有的,客户端按 assistant_message_id 补一行,时间戳排在那一句后面
 *   (created_at 只到秒、又是提交时刻,排队的 run 会排到自己那一句前面)。
 */
import { query, getDbType } from '../core/db.js';
import type { FailedRunRecord } from '../contracts/clientTypes.js';

type Row = { id: unknown; role: unknown; timestamp: unknown };

export async function failedRunsFor(sessionId: string, rows: Row[]): Promise<FailedRunRecord[]> {
  const users = rows.filter((r) => r.role === 'user').map((r) => String(r.id));
  if (!users.length) return [];
  try {
    const uidExpr = getDbType() === 'sqlite' ? `json_extract(input, '$.userMessageId')` : `input->>'userMessageId'`;
    const runs = await query<any[]>(
      `SELECT status, assistant_message_id, error, ${uidExpr} AS uid FROM agent_runs
        WHERE session_id = ? AND ${uidExpr} IN (${users.map(() => '?').join(',')})`,
      [sessionId, ...users],
    );
    const owned = new Set(runs.map((r) => String(r.uid)));
    const failed = new Map<string, any>();
    for (const r of runs) if (r.status === 'failed' && r.assistant_message_id) failed.set(String(r.uid), r);
    const out: FailedRunRecord[] = [];
    rows.forEach((row, i) => {
      if (row.role !== 'user') return;
      const run = failed.get(String(row.id));
      if (!run) return;
      for (let j = i + 1; j < rows.length; j++) {
        if (rows[j].role !== 'user') continue;
        if (owned.has(String(rows[j].id))) break;
        return; // 夹着插话:见文件头
      }
      out.push({ assistant_message_id: String(run.assistant_message_id), user_message_id: String(row.id), error: String(run.error || ''), timestamp: (Number(row.timestamp) || 0) + 1 });
    });
    return out;
  } catch (e: any) {
    // 补不回来不影响消息本身:照旧给消息,只是这一次不画失败行
    console.warn('[agent-core] failed runs lookup failed:', e?.message || e);
    return [];
  }
}
