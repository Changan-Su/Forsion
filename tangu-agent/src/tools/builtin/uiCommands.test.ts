/**
 * 界面面三工具的**门禁**单测。
 *
 * 为什么值得钉:这道闸是 default-deny 的唯一实现点,而它出错的方式是软故障 ——
 * 放松了不会崩,只会让模型在一个根本没人应答的 run 里调工具,然后**报告说已经帮用户改好了**
 * (工具超时 8s 才失败,模型常把它读成"大概生效了")。收紧了同样不报错,只是能力静默消失。
 */
import { describe, it, expect } from 'vitest';
import { uiSurfaceEnabledFor } from './uiCommands.js';

const gui = { client: 'desktop/2.9.1', uiCommands: [] as any[] };

describe('uiSurfaceEnabledFor', () => {
  it('三个 GUI 端都放行(mobile 必须在内——本轮的目标端就是它)', () => {
    for (const c of ['desktop/2.9.1', 'web/2.9.1', 'mobile/2.9.1']) {
      expect(uiSurfaceEnabledFor({ ...gui, client: c })).toBe(true);
    }
  });

  it('没有 client tag 的 run 一律拒(TUI / 通道 / 自动化 / 嵌套 run)', () => {
    expect(uiSurfaceEnabledFor({ ...gui, client: undefined })).toBe(false);
    expect(uiSurfaceEnabledFor({ ...gui, client: '' })).toBe(false);
  });

  it('CLI/TUI 明确拒(它们有 tag,但没有可操作的界面)', () => {
    expect(uiSurfaceEnabledFor({ ...gui, client: 'cli/2.9.1' })).toBe(false);
    expect(uiSurfaceEnabledFor({ ...gui, client: 'tui/2.9.1' })).toBe(false);
  });

  it('客户端没上报目录 = 渲染端太老,不会处理 ui_cmd → 拒(能力握手)', () => {
    expect(uiSurfaceEnabledFor({ client: 'desktop/2.9.1', uiCommands: undefined })).toBe(false);
  });

  it('空目录仍放行:目录为空 ≠ 不支持,设置面照样可用', () => {
    expect(uiSurfaceEnabledFor({ client: 'mobile/2.9.1', uiCommands: [] })).toBe(true);
  });

  it('子代理 / 计划模式 / 通道会话 / 讨论 run 一律拒', () => {
    expect(uiSurfaceEnabledFor({ ...gui, subAgentDepth: 1 })).toBe(false);
    expect(uiSurfaceEnabledFor({ ...gui, planMode: true })).toBe(false);
    expect(uiSurfaceEnabledFor({ ...gui, channelSession: true })).toBe(false);
    expect(uiSurfaceEnabledFor({ ...gui, inDiscussion: true })).toBe(false);
  });
});

describe('ui_cmd 事件名', () => {
  it('必须 ≤24 字符 —— agent_run_events.type 是 VARCHAR(24)', async () => {
    // Postgres 强制、SQLite 不强制,且 eventBus 的 INSERT 失败只 console.error:
    // 超长会「桌面测试全绿、上云静默不落库」。这条断言就是那个静默失败的替身。
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../services/uiAck.ts', import.meta.url), 'utf-8'));
    const m = src.match(/publish\(runId,\s*'([^']+)'/);
    expect(m, 'uiAck.ts 里应有一处 publish(runId, \'<type>\', …)').toBeTruthy();
    expect(m![1].length).toBeLessThanOrEqual(24);
  });
});

/**
 * 回执刷新快照:set_ui_setting 成功后,同一 run 里的 list_ui_commands 必须报**新值**。
 *
 * 2026-09-05 实报的第二半:ctx.uiSettings 是 run 开始那一刻的快照,set 之后再 list 仍是旧值,
 * 模型把它当成「没生效」的证据。
 * ⚠️ 必须走 registry.executeTool 而不是直接 tool.execute:registry 给每次调用一份 ctx 浅拷贝
 *    (withTimeoutSignal),直接调 execute 复用同一个对象 = 假绿。
 */
describe('set_ui_setting 之后 list_ui_commands 反映新值', () => {
  it('回执带 settings → 同 run 内 list 报新值', async () => {
    const { configureTangu } = await import('../../seams/runtime.js');
    const { createTanguProfile } = await import('../../profiles/index.js');
    const { executeTool } = await import('../registry.js');
    const { resolveUiAction, makeUiSettingsUpdater } = await import('../../services/uiAck.js');
    const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
    const profile = createTanguProfile({ sandboxMode: 'none' });
    // 假 state:只认 appendEvent;收到 ui_cmd 就在微任务里当渲染端兑现(带一份新快照)。
    const fakeState = new Proxy({
      appendEvent: async (runId: string, type: string, payload: any) => {
        if (type === 'ui_cmd') {
          queueMicrotask(() => resolveUiAction(runId, payload.ackId, { ok: true, state: 'light', settings: { color_mode: 'light' } }));
        }
        return 1;
      },
    } as Record<string, any>, { get: (t, k) => (k in t ? t[k as string] : () => { throw new Error(`stub state.${String(k)}`); }) });
    configureTangu({ host: stub, brain: stub, billing: stub, profile, state: fakeState });

    const uiSettings: Record<string, { value: string; allowed?: string[] }> = { color_mode: { value: 'dark', allowed: ['light', 'dark', 'system'] } };
    const ctx: any = {
      userId: 'u1', sessionId: 's1', appId: 'tangu', runId: 'r1', profile, client: 'desktop/0.0.0', execMode: 'host', cwd: '/tmp',
      uiCommands: [], uiSettings,
      // 与 agentLoop 装的是同一个更新器(不在测试里另抄一份逻辑)。
      updateUiSettings: makeUiSettingsUpdater(uiSettings),
    };
    const call = (name: string, args: Record<string, unknown>) => executeTool({ id: name, type: 'function', function: { name, arguments: JSON.stringify(args) } } as any, ctx);

    const before = await call('list_ui_commands', {});
    expect(before.result).toContain('color_mode = dark');
    const set = await call('set_ui_setting', { key: 'color_mode', value: 'light' });
    expect(set.result).toBe('Applied. color_mode is now light.');
    const after = await call('list_ui_commands', {});
    expect(after.result).toContain('color_mode = light');
  });

  it('agentLoop 必须真的把更新器装进 ToolContext(装配行按源码文本钉住:上面那条用的是假 ctx,删掉装配它照样绿)', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync(new URL('../../services/agentLoop.ts', import.meta.url), 'utf-8'));
    expect(src).toContain('updateUiSettings: makeUiSettingsUpdater(uiSettings)');
  });

  it('更新器:就地写、老键保留 allowed、累计键数封顶 40', () => {
    return import('../../services/uiAck.js').then(({ makeUiSettingsUpdater }) => {
      const snap: Record<string, { value: string; allowed?: string[] }> = { color_mode: { value: 'dark', allowed: ['light', 'dark'] } };
      const update = makeUiSettingsUpdater(snap);
      update({ color_mode: 'light', extra: 'x' });
      expect(snap.color_mode).toEqual({ value: 'light', allowed: ['light', 'dark'] });
      expect(snap.extra).toEqual({ value: 'x' });
      const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`k${i}`, 'v']));
      update(many);
      expect(Object.keys(snap).length).toBe(40);
      update({ color_mode: 'dark' }); // 满了仍能改已有键
      expect(snap.color_mode.value).toBe('dark');
      makeUiSettingsUpdater(undefined)({ a: 'b' }); // 没快照:不抛
    });
  });
});
