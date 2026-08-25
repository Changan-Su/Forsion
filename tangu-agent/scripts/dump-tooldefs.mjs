#!/usr/bin/env node
/**
 * G3 重构等价性校验:dump getToolDefinitions 的完整 JSON(sandbox / host / 带技能 三种 ctx)。
 * 重构前后各跑一次,diff 必须为空。用法:
 *   npm run build && node scripts/dump-tooldefs.mjs > /tmp/tooldefs-before.json
 *   (重构) npm run build && node scripts/dump-tooldefs.mjs > /tmp/tooldefs-after.json
 *   diff /tmp/tooldefs-before.json /tmp/tooldefs-after.json
 *
 * 基线快照入库于 scripts/__snapshots__/tooldefs.json:新增工具的 diff 必须是「严格追加」
 * (旧 defs 字节级前缀不变,新 provider 一律注册在 hostExecProvider 之后)。
 * ⚠️ transcribe_audio 按仓外文件门控(<共享域>/desktop-bridge.json 存在才可见,08-24):
 * 跑过新桌面的机器上快照会多出这一条,属预期追加,不是失败。
 * 注:MCP 工具(P6)与自定义工具走 ToolContext 运行时注入,不进本静态注册表,故不在快照内。
 */
import { configureTangu } from '../dist/seams/runtime.js';
import { createAiStudioProfile, createTanguProfile } from '../dist/profiles/index.js';
import { getToolDefinitions } from '../dist/tools/registry.js';

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

function dumpFor(profile, label) {
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
  // unlockTools 桩:让 load_tools 进快照(真实 loop 均提供回调;deferred 工具本体不进快照=精简后的正典)。
  const base = { userId: 'u1', sessionId: 's1', appId: profile.appId, profile, unlockTools: () => {} };
  const out = {};
  out[`${label}:sandbox`] = getToolDefinitions({ ...base, execMode: 'sandbox' });
  out[`${label}:sandbox+skills`] = getToolDefinitions({ ...base, execMode: 'sandbox', enabledSkillIds: ['sk1'] });
  out[`${label}:host`] = getToolDefinitions({ ...base, execMode: 'host', cwd: '/tmp', approvalMode: 'auto-edit' });
  out[`${label}:host+skills`] = getToolDefinitions({ ...base, execMode: 'host', enabledSkillIds: ['sk1'] });
  return out;
}

const all = {
  ...dumpFor(createAiStudioProfile(), 'ai-studio'),
  ...dumpFor(createTanguProfile({ sandboxMode: 'docker' }), 'tangu-docker'),
  ...dumpFor(createTanguProfile({ sandboxMode: 'none' }), 'tangu-none'),
};
// GUI 客户端面(ctx.client 门禁工具,如 sketch):追加在末尾钉住 GUI-only defs 字节,旧键零扰动。
{
  const p = createTanguProfile({ sandboxMode: 'none' });
  configureTangu({ host: stub, brain: stub, billing: stub, profile: p });
  all['tangu-none:host+gui'] = getToolDefinitions({
    userId: 'u1', sessionId: 's1', appId: p.appId, profile: p, unlockTools: () => {},
    execMode: 'host', cwd: '/tmp', approvalMode: 'auto-edit', client: 'desktop/0.0.0',
  });
}
process.stdout.write(JSON.stringify(all, null, 2) + '\n');
