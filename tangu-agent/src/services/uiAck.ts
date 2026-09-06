/**
 * 界面动作(set_ui_setting / run_ui_command)的请求登记表 —— 引擎 → 渲染层的一次往返。
 * 机制照 deskCapture.ts:工具发 `ui_cmd` 事件 + 登记 resolver;渲染端执行完
 * POST /agent/runs/:runId/ui-acks/:ackId 兑现。
 *
 * ⚠️ 为什么走 run 的 SSE 而不是主进程 IPC(推翻 二轮方案 §6 的载体裁决):
 *    web 与移动端**没有主进程** —— 那两端的引擎跑在云 worker 上,`window.tangu` 只是 WebView
 *    垫片。SSE 是唯一三端同形的通道,且已逐跳核实为类型透明(worker→stateApi→网关→浏览器)。
 *
 * ⚠️ 事件名 `ui_cmd` 必须 ≤24 字符:`agent_run_events.type` 是 VARCHAR(24),Postgres 强制而
 *    SQLite 不强制,且 eventBus 的 INSERT 失败只 console.error —— 超长会**桌面测试全绿、上云
 *    静默不落库**。改名前先量长度。
 *
 * ⚠️ 必须自带超时:没有渲染端在线时(TUI / 自动化 / 用户关了标签页 / 发起窗口已 reload)根本
 *    没人会答,不能像等用户那样无限挂着。超时文案要可操作——重试解决不了,得让用户回到那个窗口。
 */
import { randomBytes } from 'node:crypto';
import { publish } from './eventBus.js';

export interface UiAckResult {
  ok: boolean;
  /** 失败原因(英文,回给模型)。 */
  error?: string;
  /** 成功后的新状态,让模型不必再问一次。 */
  state?: string;
  /** 渲染端在 setter 落地**之后**读的全份设置值(key → value):工具据此刷新 run 内快照。老渲染端不带。 */
  settings?: Record<string, string>;
}

/** 日志字段单行化 + 限长:value 是模型给的、state/error 是客户端给的,都可能带换行 —— 桌面日志环按 \n 切条,一条多行文本会伪造出多条日志。 */
const oneLine = (s: string | undefined, n = 80): string => String(s ?? '-').replace(/\s+/g, ' ').slice(0, n);
const describeAction = (p: UiActionRequest): string =>
  p.kind === 'setting' ? `set ${oneLine(p.key, 32)}=${oneLine(p.value)}` : `run ${oneLine(p.id, 160)}`;

/** ackId -> { runId, resolve }。
 *  ⚠️ **必须连 runId 一起存**:兑现路由只能证明 URL 里的 runId 属于调用者,证明不了这个 ackId
 *  属于那条 run。少了这条绑定,同一个 worker 里的任意已登录用户拿自己的 runId + 猜到/看到的
 *  受害者 ackId 就能替别人的工具兑现成功 —— 模型于是报告「已应用」,而根本没有渲染端动过手
 *  (Codex 评审 2026-09-04 P1-2)。 */
const pending = new Map<string, { runId: string; resolve: (r: UiAckResult) => void }>();

let seq = 0;

export const UI_ACK_TIMEOUT_MS = 8000;

/** 发给渲染端的动作请求(ackId 由本模块补)。⚠️ 联合类型上不能用 Omit —— 它不分配到各分支,
 *  会把两个分支的独有字段一起抹掉(2026-09-04 首版就是这么写错的)。所以直接写请求形态。 */
export type UiActionRequest =
  | { kind: 'setting'; key: string; value: string }
  | { kind: 'command'; id: string; args?: Record<string, unknown> };

/** SSE 上真正发出去的电文 = 请求 + ackId。 */
export type UiCmdPayload = UiActionRequest & { ackId: string };

/** 登记一次界面动作:发事件 + await 渲染端回执(超时/中止都按失败兑现,不挂 loop)。 */
export function requestUiAction(
  runId: string,
  payload: UiActionRequest,
  signal?: AbortSignal,
  timeoutMs = UI_ACK_TIMEOUT_MS,
): Promise<UiAckResult> {
  if (signal?.aborted) return Promise.resolve({ ok: false, error: 'aborted' });
  // 随机段:时间戳+进程内计数是可预测的,而这个 id 就是兑现凭据。绑定 runId 之后猜中也没用,
  // 但两道一起上,免得日后有人挪走绑定那道还以为是安全的。
  const ackId = `ui_${Date.now().toString(36)}_${++seq}_${randomBytes(9).toString('base64url')}`;
  const t0 = Date.now();
  // 一行请求 + 一行结果:桌面 managed 模式下引擎 stdout 进主进程日志缓冲,随「导出会话日志」带走。
  // 只写单行、不写载荷(缓冲是整进程共用的环,几份快照就把别的上下文冲掉了)。
  console.log(`[ui-cmd] → ${describeAction(payload)} (${ackId})`);
  return new Promise<UiAckResult>((resolve) => {
    const done = (r: UiAckResult): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      pending.delete(ackId);
      console.log(`[ui-cmd] ← ${r.ok ? 'ok' : 'fail'} ${describeAction(payload)} state=${oneLine(r.state)}${r.error ? ` error=${oneLine(r.error, 120)}` : ''} (${Date.now() - t0}ms)`);
      resolve(r);
    };
    const onAbort = (): void => done({ ok: false, error: 'aborted' });
    const timer = setTimeout(
      () =>
        done({
          ok: false,
          error:
            'no Forsion window applied this. The window that started this conversation must be open — ' +
            'reloading it detaches the channel for the rest of this run. Ask the user to make the change ' +
            'in Settings instead of retrying.',
        }),
      timeoutMs,
    );
    timer.unref?.(); // 别让这颗定时器吊住进程退出(standalone CLI 路径)
    signal?.addEventListener('abort', onAbort, { once: true });
    pending.set(ackId, { runId, resolve: done });
    void publish(runId, 'ui_cmd', { ...payload, ackId });
  });
}

/**
 * run 级设置快照的就地更新器(agentLoop 装进 `ToolContext.updateUiSettings`,回执带来的新值经它写回)。
 * ⚠️ 闭包捕获 snapshot 对象本身:registry 给每次工具调用的 ctx 是浅拷贝,工具里 `ctx.uiSettings = …` 是静默
 *    no-op,只有就地写才穿得过去。累计键数上限 40(与 routes/runs.ts MAX_UI_SETTINGS 同):每次回执最多 40 键,
 *    不封顶就是每 run 无界。uiCommands.test.ts 用同一个函数建假 ctx,并钉住 agentLoop 的装配行。
 */
export function makeUiSettingsUpdater(
  snapshot: Record<string, { value: string; allowed?: string[] }> | undefined,
): (values: Record<string, string>) => void {
  return (values) => {
    if (!snapshot) return;
    for (const [k, v] of Object.entries(values)) {
      if (!(k in snapshot) && Object.keys(snapshot).length >= 40) continue;
      snapshot[k] = { ...(snapshot[k] || {}), value: v };
    }
  };
}

/** HTTP 端点调用:兑现某次界面动作。false = 该 id 已不在等待(超时/重复/第二个到达的窗口)。 */
export function resolveUiAction(runId: string, ackId: string, result: UiAckResult): boolean {
  const entry = pending.get(ackId);
  // runId 不匹配 = 拿着别条 run 的凭据来兑现 → 一律当作「不在等待」,不泄露它是否存在。
  if (!entry || entry.runId !== runId) return false;
  entry.resolve(result);
  return true;
}
