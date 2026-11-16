/**
 * forsion_guide(11-16,用户反馈「Tangu 不知道 Forsion Git 是什么」):
 *   ① 在哪些会话形态里能装载 —— 桌面 Work(host)、轻聊天(chat + sandbox)、云端项目 / 网页 / 手机(sandbox)、云端 profile 都得在目录里;
 *   ② Git 那节按形态改说法 —— 只有 host 且属于本机项目才叫模型用 git_* 工具,沙盒里不许许诺推送;
 *   ③ topic 只取一节。
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { configureTangu } from '../../seams/runtime.js';
import { createAiStudioProfile, createTanguProfile } from '../../profiles/index.js';
import { listDeferredTools, executeTool } from '../registry.js';
import type { ToolContext } from '../registry.js';
import { CHAT_PRESET_DEFERRED } from '../../core/presetTable.js';
import { forsionGuide, GUIDE_TOPICS } from '../../knowledge/forsionProducts.js';

const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const desktop = createTanguProfile({ sandboxMode: 'none' });
const cloud = createAiStudioProfile();
const base: ToolContext = { userId: 'u1', sessionId: 's1', appId: desktop.appId, profile: desktop, execMode: 'host', cwd: '/tmp', unlockTools: () => {}, client: 'desktop/2.14.4' };
const listed = (ctx: ToolContext): boolean => listDeferredTools(ctx, { canUnlock: true }).some((d) => d.name === 'forsion_guide');

describe('forsion_guide 在哪些会话里能装载', () => {
  beforeAll(() => configureTangu({ host: stub, brain: stub, billing: stub, profile: desktop }));

  it('桌面 Work / 项目 Work / 轻聊天 / 云端项目都在按需目录里,目录说明点名 Forsion Git', () => {
    expect(listed(base)).toBe(true);
    expect(listed({ ...base, projectPath: '/tmp/proj' })).toBe(true);
    expect(listed({ ...base, execMode: 'sandbox', cwd: undefined, preset: 'chat' })).toBe(true);
    expect(listed({ ...base, execMode: 'sandbox', cwd: undefined, wsProject: 'Demo' })).toBe(true);
    const hint = listDeferredTools(base, { canUnlock: true }).find((d) => d.name === 'forsion_guide')?.hint ?? '';
    expect(hint).toContain('Forsion Git');
    expect(Buffer.byteLength(hint)).toBeLessThanOrEqual(200); // 每轮常驻的就这一行,别让它长成第二份正文
  });

  it('云端 profile(网页 / 手机的 Worker 形态)同样在', () => {
    expect(listed({ ...base, appId: cloud.appId, profile: cloud, execMode: 'sandbox', cwd: undefined })).toBe(true);
    expect(listed({ ...base, appId: cloud.appId, profile: cloud, execMode: 'sandbox', cwd: undefined, preset: 'chat' })).toBe(true);
  });

  it('开着宿主沙箱的桌面 Work、计划模式里也在(两张白名单都得有它 —— Codex 评审)', () => {
    expect(listed({ ...base, hostSandbox: { mode: 'workspace-write', network: 'deny' } as any })).toBe(true);
    expect(listed({ ...base, planMode: true })).toBe(true);
  });

  it('chat 按需面放行(D23 关的是技能体系,首方只读工具照放)', () => {
    expect(CHAT_PRESET_DEFERRED.has('forsion_guide')).toBe(true);
  });
});

describe('forsion_guide 正文按会话形态改说法', () => {
  beforeAll(() => configureTangu({ host: stub, brain: stub, billing: stub, profile: desktop }));
  const run = async (ctx: ToolContext, args: object = {}): Promise<string> => {
    const r = await executeTool({ id: 'g1', type: 'function', function: { name: 'forsion_guide', arguments: JSON.stringify(args) } } as any, ctx);
    expect(r.isError).toBe(false);
    return r.result;
  };

  it('host + 本机项目:先 git_status、要新建才 git_publish', async () => {
    const t = await run({ ...base, projectPath: '/tmp/proj' }, { topic: 'git' });
    expect(t).toContain('Call `git_status` first');
    expect(t).toContain('`git_publish`');
    expect(t).not.toContain('cloud sandbox');
  });

  it('host 但没有 git 工具(不在项目里):指去项目详情 › Git,不叫模型调 git 工具、不许许诺', async () => {
    const t = await run(base, { topic: 'git' });
    expect(t).toContain('git tools are not available');
    expect(t).toContain('must not offer');
    expect(t).toContain('Project details › Git');
    expect(t).not.toContain('Call `git_status` first');
  });

  it('沙盒(轻聊天 / 云端 / 网页 / 手机):跑不了 git、不许许诺推送,发布在桌面版里做', async () => {
    for (const ctx of [{ ...base, execMode: 'sandbox' as const, cwd: undefined, preset: 'chat' as const }, { ...base, execMode: 'sandbox' as const, cwd: undefined, projectPath: '/tmp/proj' }]) {
      const t = await run(ctx, { topic: 'git' });
      expect(t).toContain('cloud sandbox');
      expect(t).toContain('must not offer');
      expect(t).toContain('Forsion desktop app');
      expect(t).not.toContain('load_tools');
    }
  });

  it('topic 只取那一节;不传 = 全部;非法值当不传', async () => {
    const penzor = await run(base, { topic: 'penzor_cloud' });
    expect(penzor).toContain('蓬洲云 › 同步 / Penzor Cloud › Sync');
    expect(penzor).not.toContain('## Forsion Git');
    const all = await run(base);
    for (const h of ['## Forsion Git', '## Penzor Cloud', '## Store', '## Creations', '## Forsion account', '## Other names']) expect(all).toContain(h);
    expect(await run(base, { topic: 'bogus' })).toBe(all);
    expect(GUIDE_TOPICS.length).toBe(6);
  });

  it('账号 / 商店工具不在的形态:不说「你可以用 X」,指去设置 / 商店', () => {
    const none = forsionGuide({ host: false, gitTools: false, account: false, accountAction: false, marketplace: false });
    expect(none).not.toContain('`forsion_account`');
    expect(none).not.toContain('`search_marketplace`');
    expect(none).toContain('You cannot read or change the account from this conversation');
    const readOnly = forsionGuide({ host: true, gitTools: false, account: true, accountAction: false, marketplace: true });
    expect(readOnly).toContain('`forsion_account` reads');
    expect(readOnly).not.toContain('forsion_account_action');
  });

  it('界面入口中英原文都在(改入口时这里会红,提醒同步正文)', () => {
    const all = forsionGuide({ host: true, gitTools: true, account: true, accountAction: true, marketplace: true });
    for (const label of ['"添加远端…" / "Add remote…"', '"新建并推送" / "Create and push"', '"发布到 Forsion Git…" / "Publish to Forsion Git…"', '"从 Git 克隆…" / "Clone from Git…"', '"商店" / "Store"', 'Settings › Forsion 云端 › 我的网页 / Forsion Cloud › My web pages']) expect(all).toContain(label);
  });
});
