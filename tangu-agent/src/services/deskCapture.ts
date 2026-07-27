/**
 * Agent Desk 截屏(desk_screenshot)的请求登记表——引擎 → 桌面渲染层的一次往返。
 * 机制照 inquiries.ts:工具发 `desk_capture_request` 事件 + 登记 resolver;桌面端截完图
 * POST /agent/runs/:runId/captures/:shotId 兑现。
 * 与询问的关键区别:**必须自带超时**——没有桌面端在线时(TUI / 云端 / 面板关着)根本没人会答,
 * 不能像等用户那样无限挂着。
 */
import { publish } from './eventBus.js';

export interface DeskShotResult {
  /** data:image/png;base64,… */
  dataUrl?: string;
  /** 桌面端给的失败原因(面板没开 / 窗口太窄 / 截图失败)。 */
  error?: string;
  /** 截到的形态:card=卡片小预览(缩略图),open=展开侧板。让模型知道自己看的是不是缩略图。 */
  mode?: 'card' | 'open';
}

const pending = new Map<string, (r: DeskShotResult) => void>(); // shotId -> resolver

let seq = 0;

export const DESK_SHOT_TIMEOUT_MS = 8000;

/** 登记一次截屏请求:发事件 + await 桌面端回图(超时/中止都按失败兑现,不挂 loop)。 */
export function requestDeskShot(
  runId: string,
  signal?: AbortSignal,
  timeoutMs = DESK_SHOT_TIMEOUT_MS,
): Promise<DeskShotResult> {
  if (signal?.aborted) return Promise.resolve({ error: 'aborted' });
  const shotId = `shot_${Date.now().toString(36)}_${++seq}`;
  return new Promise<DeskShotResult>((resolve) => {
    const done = (r: DeskShotResult): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending.delete(shotId);
      resolve(r);
    };
    const onAbort = (): void => done({ error: 'aborted' });
    const timer = setTimeout(() => done({ error: 'no response from the desktop app' }), timeoutMs);
    timer.unref?.(); // 别让这颗定时器吊住进程退出(standalone CLI 路径)
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(shotId, done);
    void publish(runId, 'desk_capture_request', { shotId });
  });
}

/** HTTP 端点调用:兑现某次截屏。false = 该 id 已不在等待(超时/重复/多窗口第二个到达者)。 */
export function resolveDeskShot(shotId: string, result: DeskShotResult): boolean {
  const done = pending.get(shotId);
  if (!done) return false;
  done(result);
  return true;
}
