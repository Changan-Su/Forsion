/**
 * lifecycle hook 的 matcher 按工具的**全部拼写**比(Codex 09-15 复审 #3):审批与执行都已把旧别名
 * muse_watch 归一成 manage_automation,只有 hook 还按模型原名比的话,别名就成了绕过 PreToolUse 的路;
 * 反过来存量 matcher 写着旧名也不能在升级那一刻静默失效。
 */
import { describe, it, expect } from 'vitest';
import { selectHooksFor } from './runner.js';

const hook = (matcher: string): any => ({ matcher, active: true, event: 'PreToolUse', key: matcher, handler: { command: 'true' } });
const pre = (tool_name: string): any => ({ tool_name, tool_input: {} });

describe('selectHooksFor 按工具全部拼写匹配', () => {
  it('matcher 写正典名 manage_automation:模型调旧名 muse_watch 也命中', () => {
    expect(selectHooksFor('PreToolUse', pre('muse_watch'), [hook('manage_automation')])).toHaveLength(1);
  });
  it('存量 matcher 写旧名 muse_watch:模型调新名 manage_automation 也命中', () => {
    expect(selectHooksFor('PreToolUse', pre('manage_automation'), [hook('muse_watch')])).toHaveLength(1);
  });
  it('通配 manage_* 对旧名调用同样命中', () => {
    expect(selectHooksFor('PreToolUse', pre('muse_watch'), [hook('manage_*')])).toHaveLength(1);
  });
  it('负对照:不相干的工具名不命中;非工具事件(SessionStart)按 source 比,不走拼写表', () => {
    expect(selectHooksFor('PreToolUse', pre('web_fetch'), [hook('manage_automation')])).toHaveLength(0);
    expect(selectHooksFor('SessionStart', { source: 'startup' } as any, [hook('startup')])).toHaveLength(1);
    expect(selectHooksFor('SessionStart', { source: 'resume' } as any, [hook('startup')])).toHaveLength(0);
  });
  it('Stop / UserPromptSubmit 忽略 matcher(既有语义不变)', () => {
    expect(selectHooksFor('Stop', {} as any, [hook('anything')])).toHaveLength(1);
  });
});
