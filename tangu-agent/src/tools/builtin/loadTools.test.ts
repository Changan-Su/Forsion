/**
 * load_tools × 情境 deferred(coding 预设):可解锁集合必须与目录/defs 过滤同一判定。
 * 2026-08-09 前只认静态 deferred:true——coding 目录里广而告之的工具(read_session/web_search 等)
 * 一律 "Unknown/not loadable",Codex 评审抓到的存量 bug。本文件钉死修后的行为。
 */
import { describe, it, expect } from 'vitest';
import '../registry.js'; // 副作用:注册全部内置 provider(resolveTools 依赖注册表)
import { loadToolsProvider } from './loadTools.js';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';

const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } }) as any;
const profile = createTanguProfile({ sandboxMode: 'none' });
configureTangu({ host: stub, brain: stub, billing: stub, profile });
const tool = loadToolsProvider.tools()[0];
const baseCtx = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: '/tmp' };

describe('load_tools × CODING_PRESET_DEFERRED', () => {
  it('coding 预设:目录里的情境 deferred 工具(read_session/search_sessions/web_search)可解锁', async () => {
    const unlocked: string[] = [];
    const ctx = { ...baseCtx, preset: 'coding', unlockTools: (ns: string[]) => unlocked.push(...ns) } as any;
    const r = String(await tool.execute({ names: ['read_session', 'search_sessions', 'web_search'] }, ctx));
    expect(r).toContain('Loaded tool(s)');
    expect(r).not.toContain('Unknown/not loadable');
    expect(unlocked).toEqual(expect.arrayContaining(['read_session', 'search_sessions', 'web_search']));
  });

  it('无 preset:同名工具本就不是 deferred,行为不变(仍 not loadable)', async () => {
    const ctx = { ...baseCtx, unlockTools: () => {} } as any;
    const r = String(await tool.execute({ names: ['read_session'] }, ctx));
    expect(r).toContain('Unknown/not loadable');
  });
});
