/**
 * 插件自带的 hook 只观察:照常跑(有副作用为证),但 block / continue:false / additionalContext 一律不进判定;
 * 同样的输出出自用户 hook 时照常生效(对照)。拦截类事件不收。开关不落用户配置。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { attachPluginHooks, sanitizePluginHooks } from './pluginHooks.js';
import { discoverHooks, loadHooksConfig, saveHooksConfig, setHookEnabled, syncUserTrust, trustHook, withoutPluginHooks } from './config.js';
import { runHooks } from './runner.js';

let dir: string;
let prevHome: string | undefined;
const offs: Array<() => void> = [];
const ctx = (): any => ({ profile: { capabilities: { hostExec: true } }, execMode: 'host', cwd: dir });
const loud = JSON.stringify({ decision: 'block', reason: 'nope', continue: false, hookSpecificOutput: { additionalContext: 'injected' } });

beforeEach(() => {
  prevHome = process.env.TANGU_HOME;
  dir = mkdtempSync(join(tmpdir(), 'tangu-phooks-'));
  process.env.TANGU_HOME = dir;
});
afterEach(() => {
  for (const off of offs.splice(0)) off();
  if (prevHome === undefined) delete process.env.TANGU_HOME;
  else process.env.TANGU_HOME = prevHome;
  rmSync(dir, { recursive: true, force: true });
});

describe('sanitizePluginHooks', () => {
  it('只收观察档事件;${pluginDir} 展开', () => {
    const ev = sanitizePluginHooks({
      Stop: [{ hooks: [{ type: 'command', command: 'node ${pluginDir}/h.js' }] }],
      PreToolUse: [{ hooks: [{ type: 'command', command: 'echo x' }] }],
      UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo x' }] }],
    }, 'p', '/plug');
    expect(Object.keys(ev)).toEqual(['Stop']);
    expect(ev.Stop![0].hooks[0].command).toBe('node /plug/h.js');
  });
});

describe('插件 hook 只观察', () => {
  it('跑了,但输出不进判定;用户 hook 的同样输出照常生效', async () => {
    const mark = join(dir, 'ran');
    offs.push(attachPluginHooks('p1', 'P1', dir, {
      Stop: [{ hooks: [{ type: 'command', command: `touch '${mark}'; printf '%s' '${loud}'` }] }],
    })!);
    const pv = await runHooks('Stop', {}, ctx());
    expect(existsSync(mark)).toBe(true);
    expect(pv.block).toBeFalsy();
    expect(pv.stop).toBeFalsy();
    expect(pv.additionalContext).toEqual([]);
    expect(pv.runs).toHaveLength(1);

    // 对照:同一段输出出自用户 hook → 拦下、停、注入
    saveHooksConfig(syncUserTrust({ events: { Stop: [{ hooks: [{ type: 'command', command: `printf '%s' '${loud}'` }] }] }, state: {} }));
    const uv = await runHooks('Stop', {}, ctx());
    expect(uv.block).toBe(true);
    expect(uv.stop).toBe(true);
    expect(uv.additionalContext).toEqual(['injected']);
    expect(uv.runs).toHaveLength(2); // 用户的 + 插件的
  });

  it('exit 2(拦截码)也不拦', async () => {
    offs.push(attachPluginHooks('p2', 'P2', dir, { PostToolUse: [{ matcher: '*', hooks: [{ type: 'command', command: 'echo no >&2; exit 2' }] }] })!);
    const v = await runHooks('PostToolUse', { tool_name: 'read_file' }, ctx());
    expect(v.block).toBeFalsy();
    expect(v.runs[0].status).toBe('completed');
  });

  it('列在用户 hook 之后、trusted;开关 / 信任不落用户配置;撤销后消失', () => {
    const off = attachPluginHooks('p3', 'P3', dir, { SessionStart: [{ hooks: [{ type: 'command', command: 'true' }] }] })!;
    const [h] = discoverHooks(loadHooksConfig(), 'SessionStart');
    expect(h).toMatchObject({ source: 'plugin', trust: 'trusted', active: true, plugin: { id: 'p3', name: 'P3' } });
    setHookEnabled(h.key, false);
    trustHook(h.key);
    expect(loadHooksConfig().state).toEqual({});
    off();
    expect(discoverHooks(loadHooksConfig(), 'SessionStart')).toEqual([]);
  });

  it('面板 PUT 回来的插件 hook 被剔掉(不升成用户 hook);用户本来就有的同一条保留', () => {
    const off = attachPluginHooks('p5', 'P5', dir, { Stop: [{ hooks: [{ type: 'command', command: 'echo plug' }] }] })!;
    const incoming = { Stop: [{ hooks: [{ type: 'command' as const, command: 'echo plug' }, { type: 'command' as const, command: 'echo mine' }] }] };
    expect(withoutPluginHooks(incoming, {})).toEqual({ Stop: [{ hooks: [{ type: 'command', command: 'echo mine' }] }] });
    expect(withoutPluginHooks(incoming, { Stop: [{ hooks: [{ type: 'command', command: 'echo plug' }] }] })).toEqual(incoming);
    off();
  });

  it('没声明 / 全是不收的事件 → 不登记', () => {
    expect(attachPluginHooks('p4', 'P4', dir, undefined)).toBeUndefined();
    expect(attachPluginHooks('p4', 'P4', dir, { PreToolUse: [{ hooks: [{ type: 'command', command: 'true' }] }] })).toBeUndefined();
  });
});
