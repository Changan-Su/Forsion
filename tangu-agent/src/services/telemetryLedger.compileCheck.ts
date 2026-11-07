/**
 * 账本类型的编译期自检(契约 §12「未知字段编译不过」):这个文件进 tsc(*.test.ts 不进),
 * 下面每个 @ts-expect-error 都必须真的是错误 —— 哪天类型放宽了,`npm run typecheck` 先红。函数从不调用。
 */
import { ledger } from './telemetryLedger.js';

export function ledgerCompileCheck(): void {
  ledger.inc('daily_muse', 'cyclesDone');
  ledger.inc('daily_memory', 'addPerson', { dim: 'custom' });
  ledger.set('daily_muse', 'gEnabled', 1);
  ledger.inc('daily_muse_card', 'gone', { dim: 'rule-observed' }); // gone 是计数,不是快照
  // @ts-expect-error 拼错的字段名
  ledger.inc('daily_muse', 'cyclesDonee');
  // @ts-expect-error 拼错的事件名
  ledger.inc('daily_muses', 'cyclesDone');
  // @ts-expect-error 别的事件的字段
  ledger.inc('daily_muse', 'addPerson');
  // @ts-expect-error 快照字段不能 inc
  ledger.inc('daily_muse', 'gEnabled');
  // @ts-expect-error daily_muse_card 必须带 cardKind
  ledger.inc('daily_muse_card', 'created');
  // @ts-expect-error 维度只认枚举(自建 Agent 的 slug 进不来)
  ledger.inc('daily_memory', 'addPerson', { dim: 'my-agent' });
  // @ts-expect-error 没维度的事件不许带维度
  ledger.inc('daily_judge', 'rounds', { dim: 'xyra' });
}
