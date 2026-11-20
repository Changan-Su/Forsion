/**
 * 系统睡眠检测(drift timer):合盖 / 睡眠期间定时器不走,醒来后两次心跳之间的墙钟间隙远大于心跳周期。
 * 间隙超过 SLEEP_GAP_MS 就记一次「醒来」(lastWakeAt)。
 *
 * 用处(llm/retry.ts):重试预算从 max(重试链开始, 最近一次醒来) 算起,睡着的那段不算;睡前发出、醒来才报错的请求
 * 按断网处理(探网、网通就立刻重发,不扣次数)。否则醒来那一刻离开始早过了 60 秒,按「慢失败」直接判死。
 *
 * 事件循环被同步重活卡住 >15s 也会被当成一次醒来:代价只是多一次免费重试,不值得为它再加一路信号。
 * 引擎启动时由 startBackgroundTasks 开(index.ts);单测不开,用 createDriftDetector / __setLastWakeAtForTests。
 */
export const SLEEP_TICK_MS = 1_000;
export const SLEEP_GAP_MS = 15_000;

export interface DriftDetector {
  /** 心跳:离上一次心跳超过 gapMs 就记一次醒来。 */
  tick(at?: number): void;
  /** 最近一次醒来的时刻;0 = 没睡过。 */
  lastWakeAt(): number;
}

export function createDriftDetector(opts: { gapMs?: number; now?: () => number } = {}): DriftDetector {
  const gapMs = opts.gapMs ?? SLEEP_GAP_MS;
  const now = opts.now ?? Date.now;
  let lastTick = now();
  let lastWake = 0;
  return {
    tick(at = now()) {
      if (at - lastTick > gapMs) lastWake = at;
      lastTick = at;
    },
    lastWakeAt: () => lastWake,
  };
}

let detector: DriftDetector | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let testWakeAt = 0;

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

/** 最近一次醒来的时刻(0 = 没睡过 / 检测器没开)。读时顺手补一拍:醒来后心跳回调可能排在退避定时器后面。 */
export function lastWakeAt(): number {
  if (timer && detector) detector.tick();
  return Math.max(detector?.lastWakeAt() ?? 0, testWakeAt);
}

/** 仅测试:假装刚醒(0 = 撤销)。 */
export function __setLastWakeAtForTests(at: number): void {
  testWakeAt = at;
}
