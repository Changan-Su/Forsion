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
 * 注:MCP 工具(P6)与自定义工具走 ToolContext 运行时注入,不进本静态注册表,故不在快照内。
 */
import { configureTangu } from '../dist/seams/runtime.js';
import { createAiStudioProfile, createTanguProfile } from '../dist/profiles/index.js';
import { getToolDefinitions } from '../dist/tools/registry.js';

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

function dumpFor(profile, label) {
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
  const base = { userId: 'u1', sessionId: 's1', appId: profile.appId, profile };
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
process.stdout.write(JSON.stringify(all, null, 2) + '\n');
