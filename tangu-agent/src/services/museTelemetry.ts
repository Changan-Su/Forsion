/**
 * Muse 的遥测计数小帮手(账本见 telemetryLedger.ts):周期产出归属、第一次见面答案拆成枚举计数。
 * 单独一个文件:museDm / museCards / 工具都要用,而它们不能 import muse.ts(成环)。
 */
import { currentRunId } from '../seams/runContext.js';
import { ledger } from './telemetryLedger.js';

/** 正在跑的 Muse 周期 run → 这个周期产出了几样(卡 / 私信 / 待办 / 开场建议)。进程重启即丢,同 pendingJournal。 */
const cycleOutput = new Map<string, number>();

export function museCycleStarted(runId: string): void {
  cycleOutput.set(runId, 0);
}
/** 周期收尾:返回它产出了几样(不认识的 run → undefined),并忘掉它。 */
export function museCycleFinished(runId: string): number | undefined {
  const n = cycleOutput.get(runId);
  cycleOutput.delete(runId);
  return n;
}

type ProducedField = 'producedCards' | 'producedDms' | 'producedTodos' | 'producedStarters';
/** 产出点调用:只有当前 run 是 Muse 周期时才算这个周期的产出(用户手聊 Muse、引擎自己发的卡不算)。 */
export function noteMuseProduced(field: ProducedField, n = 1): void {
  try {
    const runId = currentRunId();
    if (!runId || !cycleOutput.has(runId) || !(n > 0)) return;
    cycleOutput.set(runId, cycleOutput.get(runId)! + n);
    ledger.inc('daily_muse', field, { n });
  } catch { /* 计数不挡业务 */ }
}

const WHEN = { anytime: 'introWhenAnytime', daytime: 'introWhenDaytime', open: 'introWhenOpen' } as const;
const PACE = { 'as-needed': 'introPaceAsNeeded', daily: 'introPaceDaily', free: 'introPaceFree' } as const;
const FOCUS = { schedule: 'introFocusSchedule', study: 'introFocusStudy', projects: 'introFocusProjects', inbox: 'introFocusInbox' } as const;

/** 第一次见面答了:答案只认选项枚举(已经过 introAnswers 清洗),自己写的那条只记「写了」。 */
export function noteMuseIntroAnswered(a: { when?: string; pace?: string; focus?: string[] }, customFocus = false): void {
  ledger.inc('daily_muse', 'introAnswered');
  const when = WHEN[a.when as keyof typeof WHEN];
  if (when) ledger.inc('daily_muse', when);
  const pace = PACE[a.pace as keyof typeof PACE];
  if (pace) ledger.inc('daily_muse', pace);
  for (const f of new Set(a.focus || [])) {
    const field = FOCUS[f as keyof typeof FOCUS];
    if (field) ledger.inc('daily_muse', field);
  }
  if (customFocus) ledger.inc('daily_muse', 'introFocusCustom');
}

/** @internal 测试用 */
export function museCycleOutputForTest(runId: string): number | undefined { return cycleOutput.get(runId); }
