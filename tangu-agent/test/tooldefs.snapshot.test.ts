import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createAiStudioProfile, createTanguProfile } from '../src/profiles/index.js';
import { getToolDefinitions } from '../src/tools/registry.js';

// 把 scripts/dump-tooldefs.mjs 的 12-context dump 变成自动闸门:从 src 跑(免 build),
// 与提交的基线 scripts/__snapshots__/tooldefs.json 深等比对。任何工具定义漂移都会让测试失败。
// 有意变更工具时:`npm run build && node scripts/dump-tooldefs.mjs > scripts/__snapshots__/tooldefs.json` 重生并提交。
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });

function dumpFor(profile: any, label: string): Record<string, unknown> {
  configureTangu({ host: stub, brain: stub, billing: stub, profile });
  const base = { userId: 'u1', sessionId: 's1', appId: profile.appId, profile } as any;
  const out: Record<string, unknown> = {};
  out[`${label}:sandbox`] = getToolDefinitions({ ...base, execMode: 'sandbox' });
  out[`${label}:sandbox+skills`] = getToolDefinitions({ ...base, execMode: 'sandbox', enabledSkillIds: ['sk1'] });
  out[`${label}:host`] = getToolDefinitions({ ...base, execMode: 'host', cwd: '/tmp', approvalMode: 'auto-edit' });
  out[`${label}:host+skills`] = getToolDefinitions({ ...base, execMode: 'host', enabledSkillIds: ['sk1'] });
  return out;
}

describe('getToolDefinitions snapshot (behavior-preserving)', () => {
  it('matches committed baseline tooldefs.json', () => {
    const all = {
      ...dumpFor(createAiStudioProfile(), 'ai-studio'),
      ...dumpFor(createTanguProfile({ sandboxMode: 'docker' }), 'tangu-docker'),
      ...dumpFor(createTanguProfile({ sandboxMode: 'none' }), 'tangu-none'),
    };
    const here = dirname(fileURLToPath(import.meta.url));
    const snapshotPath = join(here, '../scripts/__snapshots__/tooldefs.json');
    const expected = JSON.parse(readFileSync(snapshotPath, 'utf8'));
    expect(all).toEqual(expected);
  });
});
