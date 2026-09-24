/**
 * Muse 调度运行态(muse-state.json):上次周期时刻 + Muse 自己定的休眠(set_next_wake,2026-09-24)。
 *
 * 住**引擎自有状态域** ~/.tangu/(与 special-agents.json 同级),刻意**不**放 agents/muse/:那是 Muse 自己的可写根
 * (fsPolicy.writableRoots),调度控制态放在模型能写的地方,Muse 或一次提示注入把它写成远未来 = 把自己永久停掉
 * (Codex 评审 #2)。run_bash 那条路由 hostSandboxProtection 的 deny 名单挡(文件名在那里)。
 * 休眠只经 set_next_wake 工具写入,且读回时再校验一次(≤24h、setAt 不在未来):工具是唯一写口,文件被改坏也停不死 Muse。
 *
 * 两个写者(startCycle 写 lastCycleAt、工具写 sleep)→ 按字段合并、串行化写。
 * 放在独立叶子模块:工具要写它,而 muse.ts 经 agentLoop → registry 反向依赖工具,直接 import muse.ts 成环。
 * ponytail: 整文件读写、坏文件当没跑过,不上原子写 —— 单进程单写者,丢了最多多跑一个周期。
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { tanguHome } from '../core/tanguHome.js';

/** 单次休眠上限:再长就是「Muse 把自己关了」,那该由用户在设置里关。 */
export const MUSE_SLEEP_MAX_MS = 24 * 3600_000;

export interface MuseSleep {
  /** 心跳恢复的时刻(epoch ms) */
  until: number;
  /** 何时定的(判「之后用户有没有动过」的起点) */
  setAt: number;
  /** Muse 给的理由(一句话,MuseView 与 Journal 显示) */
  reason: string;
  /** 睡下那一分钟里已有几行用户活动(活动日志是分钟精度:同一分钟里「之后」多出来的行靠这个基线认出来)。
   *  缺省 = 未知(读活动文件失败 / 旧格式):同一分钟的行一律不算,别当 0 —— 当 0 会把睡下前那一分钟的动作认成「回来了」。 */
  minuteLines?: number;
}

interface MuseStateShape {
  lastCycleAt?: number;
  sleep?: MuseSleep | null;
}

export function museStateFile(): string {
  return path.join(tanguHome(), 'muse-state.json');
}

async function readRaw(): Promise<MuseStateShape> {
  try {
    const raw = JSON.parse(await fs.readFile(museStateFile(), 'utf8'));
    return raw && typeof raw === 'object' ? raw : {};
  } catch { return {}; }
}

export async function readLastCycleAt(): Promise<number> {
  const v = Number((await readRaw()).lastCycleAt);
  // 晚于当前时刻的值只可能来自篡改或时钟回拨 → 当没跑过。宁可多跑一个周期,也不让一个坏值把 Muse 停死。
  return Number.isFinite(v) && v > 0 && v <= Date.now() ? v : 0;
}

/** 合法的休眠:setAt 不在未来、until 晚于 setAt 且不超过 24h;否则(篡改 / 时钟回拨 / 坏文件)当没睡。纯函数,单测钉。 */
export function validSleep(s: unknown, now = Date.now()): MuseSleep | null {
  const o = s as Partial<MuseSleep> | null | undefined;
  const until = Number(o?.until);
  const setAt = Number(o?.setAt);
  if (!Number.isFinite(until) || !Number.isFinite(setAt)) return null;
  if (setAt <= 0 || setAt > now || until <= setAt || until - setAt > MUSE_SLEEP_MAX_MS) return null;
  const minuteLines = Number(o?.minuteLines);
  return {
    until, setAt, reason: String(o?.reason || '').slice(0, 200),
    ...(Number.isInteger(minuteLines) && minuteLines >= 0 ? { minuteLines } : {}),
  };
}

let writeChain: Promise<void> = Promise.resolve();
/** 按字段合并写回(串行化;失败抛给调用方,由它决定记日志还是报错)。 */
export function patchMuseState(patch: MuseStateShape): Promise<void> {
  const next = writeChain.then(async () => {
    const cur = await readRaw();
    await fs.mkdir(path.dirname(museStateFile()), { recursive: true });
    await fs.writeFile(museStateFile(), JSON.stringify({ ...cur, ...patch }), 'utf8');
  });
  writeChain = next.catch(() => {});
  return next;
}

/** 进程内镜像(所有写者都在本进程):undefined = 还没从盘上读过。 */
let sleepMem: MuseSleep | null | undefined;

/** 当前生效的休眠(过期即视为醒着)。 */
export async function getMuseSleep(now = Date.now()): Promise<MuseSleep | null> {
  if (sleepMem === undefined) sleepMem = validSleep((await readRaw()).sleep, now);
  if (sleepMem && now >= sleepMem.until) sleepMem = null;
  return sleepMem;
}

export async function setMuseSleep(s: MuseSleep | null): Promise<void> {
  sleepMem = s;
  await patchMuseState({ sleep: s });
}

/** 测试用:丢掉进程内镜像,下次按盘上重读。 */
export function resetMuseStateCacheForTest(): void {
  sleepMem = undefined;
}
