import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTanguProfile, createAiStudioProfile } from '../profiles/index.js';
import { __browserUseInternals } from './builtin/browserUse.js';
import { getToolDefinitions, getToolCapabilities } from './registry.js';
import { toolNeedsApproval, approvalPreview } from '../services/approvals.js';
import type { ToolContext } from './toolTypes.js';

// 指向空 TANGU_HOME(无 config.json)——测试对真实 ~/.tangu 免疫,只由 env 覆盖驱动。
let home = '';
beforeAll(() => { home = mkdtempSync(join(tmpdir(), 'tangu-bu-test-')); process.env.TANGU_HOME = home; });

const toolNames = (ctx: ToolContext): string[] => getToolDefinitions(ctx).map((t) => t.function.name);

describe('browser_task visibility gating', () => {
  const tangu = createTanguProfile({ sandboxMode: 'none' });
  const aiStudio = createAiStudioProfile();
  const base = { userId: 'u1', sessionId: 's1' };

  it('is visible on the local tangu profile in host mode', () => {
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host' })).toContain('browser_task');
  });

  it('is hidden in sandbox exec mode (mode:host)', () => {
    expect(toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'sandbox' })).not.toContain('browser_task');
  });

  it('is hidden on the cloud ai-studio profile even in host mode (no hostExec)', () => {
    expect(toolNames({ ...base, appId: aiStudio.appId, profile: aiStudio, execMode: 'host' })).not.toContain('browser_task');
  });

  it('is appended after the existing browser_* tools (append-only prefix)', () => {
    const names = toolNames({ ...base, appId: tangu.appId, profile: tangu, execMode: 'host' });
    expect(names.indexOf('browser_task')).toBeGreaterThan(names.indexOf('browser_navigate'));
  });
});

describe('browser_task capability + config', () => {
  const profile = createTanguProfile({ sandboxMode: 'none' });
  const ctx: ToolContext = { userId: 'u1', sessionId: 's1', appId: profile.appId, profile, execMode: 'host', approvalMode: 'auto-edit' };

  const keys = ['TANGU_BROWSER_USE_PROVIDER', 'TANGU_BROWSER_USE_MODEL', 'TANGU_BROWSER_USE_API_KEY'] as const;
  afterEach(() => {
    for (const k of keys) delete process.env[k];
    rmSync(join(home, 'config.json'), { force: true });
  });

  it('serializes on the shared browser concurrency key', () => {
    expect(getToolCapabilities('browser_task', ctx)).toMatchObject({ sideEffect: 'browser', parallel: false, concurrencyKey: 'browser' });
  });

  it('reports not-configured until a model is set', () => {
    expect(__browserUseInternals.modelConfig()).toBeNull();
  });

  it('resolves an openai-style model from env overrides', () => {
    process.env.TANGU_BROWSER_USE_PROVIDER = 'openai';
    process.env.TANGU_BROWSER_USE_MODEL = 'gpt-strong';
    process.env.TANGU_BROWSER_USE_API_KEY = 'sk-test';
    expect(__browserUseInternals.modelConfig()).toMatchObject({ provider: 'openai', model: 'gpt-strong', apiKey: 'sk-test' });
  });

  it('allows the browser-use gateway without an explicit key/model', () => {
    process.env.TANGU_BROWSER_USE_PROVIDER = 'browser-use';
    expect(__browserUseInternals.modelConfig()).toMatchObject({ provider: 'browser-use' });
  });

  it('falls back to a configured direct provider (baseUrl+apiKey+first modelId)', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      providers: [{ providerId: 'Other', baseUrl: 'https://api.example/v1', apiKey: 'sk-p', modelIds: ['m-first', 'm-second'] }],
    }));
    expect(__browserUseInternals.modelConfig()).toMatchObject({ provider: 'openai', model: 'm-first', apiKey: 'sk-p', baseUrl: 'https://api.example/v1' });
  });

  it('prefers explicit browserUse.model over the providers fallback', () => {
    writeFileSync(join(home, 'config.json'), JSON.stringify({
      browserUse: { model: { provider: 'anthropic', model: 'claude-x', apiKey: 'sk-a' } },
      providers: [{ providerId: 'Other', baseUrl: 'https://api.example/v1', apiKey: 'sk-p', modelIds: ['m-first'] }],
    }));
    expect(__browserUseInternals.modelConfig()).toMatchObject({ provider: 'anthropic', model: 'claude-x', apiKey: 'sk-a' });
  });
});

describe('browser_task approval tier (same as run_bash)', () => {
  it('requires approval in readonly and auto-edit, passes in full-auto', () => {
    expect(toolNeedsApproval('browser_task', 'readonly')).toBe(true);
    expect(toolNeedsApproval('browser_task', 'auto-edit')).toBe(true);
    expect(toolNeedsApproval('browser_task', 'full-auto')).toBe(false);
  });

  it('previews task and allowed domains in the approval dialog', () => {
    const call = {
      id: 'c1', type: 'function' as const,
      function: { name: 'browser_task', arguments: JSON.stringify({ task: '给影视飓风最新视频点赞', allowed_domains: ['*.bilibili.com'] }) },
    };
    const p = approvalPreview(call as any);
    expect(p).toContain('browser_task');
    expect(p).toContain('*.bilibili.com');
    expect(p).toContain('点赞');
  });
});

describe('spawnRunner stream protocol', () => {
  const { spawnRunner, STEP_MARKER, RESULT_MARKER } = __browserUseInternals;

  it('parses STEP lines incrementally and recovers the final RESULT despite log noise', async () => {
    const script = [
      `process.stdout.write('browser-use log noise\\n');`,
      `process.stdout.write(${JSON.stringify(STEP_MARKER)} + JSON.stringify({step:1, goal:'open page', screenshot:'QUJD'}) + '\\n');`,
      `process.stdout.write(${JSON.stringify(STEP_MARKER)} + JSON.stringify({step:2}) + '\\n');`,
      `process.stdout.write('\\n' + ${JSON.stringify(RESULT_MARKER)} + JSON.stringify({success:true, result:'done'}) + '\\n');`,
    ].join('');
    const steps: any[] = [];
    const r = await spawnRunner(process.execPath, ['-e', script], '', process.env, 10_000, 'hint', undefined, (e) => steps.push(e));
    expect(r).toMatchObject({ success: true, result: 'done' });
    expect(steps.map((s) => s.step)).toEqual([1, 2]);
    expect(steps[0].screenshot).toBe('QUJD');
  });

  it('returns the install hint when the runner binary is missing', async () => {
    const r = await spawnRunner('tangu-definitely-missing-bin', [], '', process.env, 5_000, 'INSTALL HINT', undefined);
    expect(r.success).toBe(false);
    expect(r.error).toBe('INSTALL HINT');
  });
});
