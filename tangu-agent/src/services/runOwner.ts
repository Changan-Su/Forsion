/**
 * run 的持有者身份 = `<pid>:<进程启动时刻(epoch 秒)>`(PI-DSH 评审 R2)。
 * 只记 pid 不够:引擎崩了之后它的 pid 可能被无关进程复用,探活会误判「还活着」,那几行就一直卡在 running。
 * 加上启动时刻,同一个 pid 换了进程就对不上。本机 SQLite 建 run 时写(sqlStateStore.createRun),重启自愈时探(agentLoop.recoverQueuedRuns)。
 */
import { execFile } from 'node:child_process';

/** 本进程的身份。自算启动时刻与 ps 读到的实测相差 0–1 秒,比对留 3 秒余量。 */
export const SELF_OWNER = `${process.pid}:${Math.round(Date.now() / 1000 - process.uptime())}`;
const START_TOLERANCE_S = 3;

/** 另一个进程的启动时刻(epoch 秒);进程不在或探不到 → null。 */
export function processStartedAt(pid: number): Promise<number | null> {
  return new Promise((resolve) => {
    const done = (err: unknown, out: string, parse: (s: string) => number): void => {
      const v = err ? NaN : parse(String(out).trim());
      resolve(Number.isFinite(v) && v > 0 ? Math.round(v) : null);
    };
    if (process.platform === 'win32') {
      execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `([DateTimeOffset](Get-Process -Id ${pid}).StartTime).ToUnixTimeSeconds()`],
        { timeout: 8000, windowsHide: true }, (err, out) => done(err, out, Number));
    } else {
      // LC_ALL=C:lstart 走 C 区域的英文日期格式,Date.parse 才认得
      execFile('ps', ['-o', 'lstart=', '-p', String(pid)], { timeout: 5000, env: { ...process.env, LC_ALL: 'C' } },
        (err, out) => done(err, out, (s) => Date.parse(s) / 1000));
    }
  });
}

/** 持有者是不是那个还活着的进程。自己 → 是;同 pid 换了进程(启动时刻对不上)→ 否;pid 不在 → 否;
 *  启动时刻探不到 → 按活着算(宁可不碰别人的 run)。空 / 格式不对(升级前的行)→ 否。 */
export async function ownerAlive(owner: string | null | undefined): Promise<boolean> {
  if (!owner) return false;
  if (owner === SELF_OWNER) return true;
  const [pidText, startText] = owner.split(':');
  const pid = Number(pidText);
  const startedAt = Number(startText);
  if (!Number.isInteger(pid) || pid <= 0 || !Number.isFinite(startedAt) || pid === process.pid) return false;
  try {
    process.kill(pid, 0);
  } catch (e: any) {
    if (e?.code !== 'EPERM') return false; // EPERM = 在,只是无权发信号
  }
  const actual = await processStartedAt(pid);
  return actual === null || Math.abs(actual - startedAt) <= START_TOLERANCE_S;
}
