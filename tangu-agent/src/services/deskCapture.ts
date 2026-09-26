/**
 * Agent Desk 截屏(desk_screenshot)的请求登记表——引擎 → 桌面渲染层的一次往返。
 * 机制照 inquiries.ts:工具发 `desk_capture_request` 事件 + 登记 resolver;桌面端截完图
 * POST /agent/runs/:runId/captures/:shotId 兑现。
 * 与询问的关键区别:**必须自带超时**——没有桌面端在线时(TUI / 云端 / 面板关着)根本没人会答,
 * 不能像等用户那样无限挂着。
 */
import { randomBytes } from 'node:crypto';
import { publish } from './eventBus.js';

export interface DeskShotResult {
  /** data:image/png;base64,… */
  dataUrl?: string;
  /** 桌面端给的失败原因(面板没开 / 窗口太窄 / 截图失败)。 */
  error?: string;
  /** 截到的形态:card=卡片小预览(缩略图),open=展开侧板。让模型知道自己看的是不是缩略图。 */
  mode?: 'card' | 'open';
  /** 截到的是插件伴随面(桌面端 ctx.desk.registerCompanion,如 3D 形象)时它的 key(`plugin:<id>:<name>`)。
   *  模型据此知道图里是插件画的东西,不是自己 desk_present 上去的。 */
  companion?: string;
}

/** POST 体 → 兑现结果(路由用;纯函数单测钉住)。dataUrl 会回灌进模型上下文 → 只认 png/jpeg 的 data URL;
 *  companion 同样进模型上下文 → 只收 `plugin:id:name` 这类短标识,别的一律丢掉(不让任意文本借道进提示词)。 */
export function parseDeskShotBody(body: unknown): DeskShotResult {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const dataUrl = typeof b.dataUrl === 'string' ? b.dataUrl : '';
  if (!/^data:image\/(png|jpeg);base64,/.test(dataUrl) || dataUrl.length > 12_000_000) {
    return { error: String(b.error || 'capture failed').slice(0, 200) };
  }
  const companion = typeof b.companion === 'string' && /^[\w:.-]{1,80}$/.test(b.companion) ? b.companion : undefined;
  return { dataUrl, mode: b.mode === 'card' ? 'card' : 'open', ...(companion ? { companion } : {}) };
}

/** shotId -> { runId, resolve }。⚠️ 必须连 runId 一起存(同 uiAck.ts):兑现路由只能证明 URL 里的 runId
 *  属于调用者,证明不了 shotId 属于那条 run —— 少了绑定,同一 worker 上任意已登录用户拿自己的 runId +
 *  别人的 shotId 就能把任意图片塞进受害者的模型上下文。 */
const pending = new Map<string, { runId: string; resolve: (r: DeskShotResult) => void }>();

let seq = 0;

export const DESK_SHOT_TIMEOUT_MS = 8000;

/** 登记一次截屏请求:发事件 + await 桌面端回图(超时/中止都按失败兑现,不挂 loop)。 */
export function requestDeskShot(
  runId: string,
  signal?: AbortSignal,
  timeoutMs = DESK_SHOT_TIMEOUT_MS,
): Promise<DeskShotResult> {
  if (signal?.aborted) return Promise.resolve({ error: 'aborted' });
  // 随机段:时间戳+计数可预测,而 shotId 就是兑现凭据(绑定 runId 之外的第二道)。
  const shotId = `shot_${Date.now().toString(36)}_${++seq}_${randomBytes(9).toString('base64url')}`;
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
    pending.set(shotId, { runId, resolve: done });
    void publish(runId, 'desk_capture_request', { shotId });
  });
}

/** HTTP 端点调用:兑现某次截屏。false = 该 id 已不在等待(超时/重复/多窗口第二个到达者)。 */
export function resolveDeskShot(runId: string, shotId: string, result: DeskShotResult): boolean {
  const entry = pending.get(shotId);
  // runId 不匹配 = 拿别条 run 的凭据来兑现 → 一律当作「不在等待」,不泄露它是否存在。
  if (!entry || entry.runId !== runId) return false;
  entry.resolve(result);
  return true;
}
