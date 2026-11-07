/**
 * human/ 对称体系的写入计数(帮助改进 v2 契约 §7 daily_human)。单独一个文件、只依赖账本:humanStore 要调它,
 * 不能经 memoryTelemetry 绕回 humanPortrait(那边的类在模块求值时就要 humanStore 的 HumanError)。
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { humanDir } from '../core/tanguHome.js';
import { ledger } from './telemetryLedger.js';
import { normalizeMemoryFact } from './memoryRepository.js';
import type { HumanChangeSource, HumanScope } from '../agents/humanStore.js';

const WEEK = 7 * 86_400_000;
const isItem = (l: string): boolean => /^\s*(?:[-*+]|\d+[.)])\s+\S/.test(l);
function readText(file: string): string | null {
  try { return existsSync(file) ? readFileSync(file, 'utf8') : null; } catch { return null; }
}

type HumanTarget = 'Shared' | 'Agent' | 'Project' | 'Portrait' | 'AgentMd' | 'Memory';
const HUMAN_FILE_TARGET: Record<string, HumanTarget> = { 'HUMAN.md': 'Shared', 'AGENT.md': 'AgentMd', 'SOUL.md': 'Portrait', 'MEMORY.md': 'Memory' };
/** 来源 → 计数键;认不得的来源(以后新加的种类)不计。 */
const HUMAN_SRC: Record<string, 'srcRemember' | 'srcDream' | 'srcMove' | 'srcPromote' | 'srcUser'> = { remember: 'srcRemember', dream: 'srcDream', move: 'srcMove', promote: 'srcPromote', user: 'srcUser' };

/** writeHuman 落成一笔:谁写的 × 写进哪一份、从哪条路来;人在 7 天内撤回 Agent 写的那一笔单记。 */
export function noteHumanWrite(scope: HumanScope, actor: 'agent' | 'user', source: HumanChangeSource | undefined, undid?: { actor: string; at: string }): void {
  try {
    const target: HumanTarget | undefined = scope.kind === 'agent' ? 'Agent' : scope.kind === 'project' ? 'Project' : Object.hasOwn(HUMAN_FILE_TARGET, scope.file) ? HUMAN_FILE_TARGET[scope.file] : undefined;
    if (target) ledger.inc('daily_human', `${actor === 'agent' ? 'wAgent' : 'wUser'}${target}` as 'wAgentShared');
    const src = source && Object.hasOwn(HUMAN_SRC, source.kind) ? HUMAN_SRC[source.kind] : undefined;
    if (src) ledger.inc('daily_human', src);
    if (undid && actor === 'user' && undid.actor === 'agent' && Date.now() - Date.parse(undid.at) <= WEEK) ledger.inc('daily_human', 'userUndoAgentWrite7d');
  } catch { /* 同上 */ }
}

/**
 * 冷启动:Agent 建好后头 7 天里往画像(scope=person)写的,以及其中画像 / 共识里本来就有的(重学了一遍)。
 * 在写的那一刻记(那天的格子);「满 7 天的 Agent 有几个」由每日快照记。
 */
export function noteColdstartPersonWrite(createdAt: string | undefined, fact: string, duplicate: boolean): void {
  try {
    const born = Date.parse(String(createdAt || ''));
    if (!Number.isFinite(born) || Date.now() - born > WEEK || Date.now() < born) return;
    ledger.inc('daily_human', 'coldstartPersonWrites');
    if (duplicate || inSharedConsensus(fact)) ledger.inc('daily_human', 'coldstartRelearned');
  } catch { /* 同上 */ }
}
function inSharedConsensus(fact: string): boolean {
  const norm = normalizeMemoryFact(fact);
  const raw = readText(join(humanDir(), 'HUMAN.md'));
  return !!raw && raw.split('\n').some((l) => isItem(l) && normalizeMemoryFact(l) === norm);
}
