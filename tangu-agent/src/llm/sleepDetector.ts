/**
 * 系统睡眠检测(drift timer):合盖 / 睡眠期间定时器不走,醒来后两次心跳之间的墙钟间隙远大于心跳周期。
 * 间隙超过 SLEEP_GAP_MS 就记一段睡眠区间 [上一拍, 这一拍]。
 *
 * 用处(llm/retry.ts、llm/netWait.ts):
 *  - 重试预算只算醒着的时间:睡眠区间从「请求 + 普通退避」里扣掉(睡前已花的照算,不清零);
 *  - 等网 30 分钟只算醒着等的;
 *  - 睡前发出、醒来才报错的本地传输中断按断网处理(探网、网通就重发,整 run 至多 2 次免费)。
 * 睡眠只由这里的心跳判定,不由等待循环某一轮耗时长短判定(探网慢不等于睡着了)。
 *
 * 事件循环被同步重活卡住 >15s 也会被当成一段睡眠:代价只是预算宽一点、多一次免费重试,不值得为它再加一路信号。
 * 引擎启动时由 startBackgroundTasks 开(index.ts);单测不开,用 createDriftDetector / __recordSleepForTests。
 */
export const SLEEP_TICK_MS = 1_000;
export const SLEEP_GAP_MS = 15_000;
const MAX_INTERVALS = 64;

export interface SleepInterval { start: number; end: number }

export interface DriftDetector {
  /** 心跳:离上一次心跳超过 gapMs 就记一段睡眠。 */
  tick(at?: number): void;
  /** 最近一次醒来的时刻;0 = 没睡过。 */
  lastWakeAt(): number;
  /** 记下的睡眠区间(最近 64 段,按时间先后)。 */
  intervals(): readonly SleepInterval[];
}

export function createDriftDetector(opts: { gapMs?: number; now?: () => number } = {}): DriftDetector {
  const gapMs = opts.gapMs ?? SLEEP_GAP_MS;
  const now = opts.now ?? Date.now;
  let lastTick = now();
  const list: SleepInterval[] = [];
  return {
    tick(at = now()) {
      if (at - lastTick > gapMs) {
        list.push({ start: lastTick, end: at });
        if (list.length > MAX_INTERVALS) list.shift();
      }
      lastTick = at;
    },
    lastWakeAt: () => (list.length ? list[list.length - 1].end : 0),
    intervals: () => list,
  };
}

let detector: DriftDetector | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let testIntervals: SleepInterval[] = [];

/** 幂等;unref 不拖住进程退出。 */
export function startSleepDetector(): void {
  if (timer) return;
  detector = createDriftDetector();
  timer = setInterval(() => detector?.tick(), SLEEP_TICK_MS);
  timer.unref?.();
}

export function stopSleepDetector(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

/** 全部已知睡眠区间(检测器的 + 测试注入的)。读时顺手补一拍:醒来后心跳回调可能排在退避定时器后面。 */
export function sleepIntervals(): SleepInterval[] {
  if (timer && detector) detector.tick();
  return [...(detector?.intervals() ?? []), ...testIntervals];
}

/** 最近一次醒来的时刻(0 = 没睡过 / 检测器没开)。 */
export function lastWakeAt(): number {
  return sleepIntervals().reduce((m, s) => Math.max(m, s.end), 0);
}

/** [from, to] 里睡着了多久(各段睡眠与它的重叠之和)。 */
export function sleptMsBetween(from: number, to: number): number {
  let ms = 0;
  for (const s of sleepIntervals()) ms += Math.max(0, Math.min(to, s.end) - Math.max(from, s.start));
  return ms;
}

/** 仅测试:记一段睡眠 [start, end]。 */
export function __recordSleepForTests(start: number, end: number): void {
  testIntervals.push({ start, end });
}

/** 仅测试:清掉注入的睡眠。 */
export function __resetSleepForTests(): void {
  testIntervals = [];
}
