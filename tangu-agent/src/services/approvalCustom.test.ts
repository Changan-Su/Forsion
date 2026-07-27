/**
 * custom 审批档(config.json approval 段)的规则匹配与优先级。
 * gateToolCall 会读真实 config.json,不适合单测;此处直接喂规则给 customVerdict——
 * 判定逻辑(通配、参数前缀、deny>ask>allow)全在这一层,配置读取只是取值。
 */
import { describe, it, expect } from 'vitest';
import { customVerdict, type CustomApprovalRules } from './approvals.js';
import type { ToolCall } from '../core/types.js';

const call = (name: string, args: Record<string, unknown> = {}): ToolCall =>
  ({ id: 't1', type: 'function', function: { name, arguments: JSON.stringify(args) } }) as ToolCall;

const rules = (p: Partial<CustomApprovalRules>): CustomApprovalRules =>
  ({ base: 'auto-edit', allow: [], ask: [], deny: [], ...p });

describe('customVerdict', () => {
  it('无规则 → undefined(退回 base 档)', () => {
    expect(customVerdict(call('run_bash', { command: 'npm test' }), rules({}))).toBeUndefined();
  });

  it('裸工具名精确匹配', () => {
    expect(customVerdict(call('web_fetch', { url: 'x' }), rules({ allow: ['web_fetch'] }))).toBe('allow');
    expect(customVerdict(call('web_search', { query: 'x' }), rules({ allow: ['web_fetch'] }))).toBeUndefined();
  });

  it('`*` 结尾 = 前缀通配(整片 MCP 工具)', () => {
    expect(customVerdict(call('mcp__fs__read'), rules({ allow: ['mcp__*'] }))).toBe('allow');
    expect(customVerdict(call('run_bash', { command: 'ls' }), rules({ allow: ['mcp__*'] }))).toBeUndefined();
  });

  it('`:前缀` 比 bash command', () => {
    const r = rules({ allow: ['run_bash:npm test'] });
    expect(customVerdict(call('run_bash', { command: 'npm test -- --watch' }), r)).toBe('allow');
    expect(customVerdict(call('run_bash', { command: 'npm publish' }), r)).toBeUndefined();
  });

  it('`:前缀` 比写工具的目标路径', () => {
    const r = rules({ deny: ['write_file:/etc/'] });
    expect(customVerdict(call('write_file', { path: '/etc/hosts' }), r)).toBe('deny');
    expect(customVerdict(call('write_file', { path: '/tmp/a' }), r)).toBeUndefined();
  });

  it('优先级 deny > ask > allow(同一次调用被多条命中时)', () => {
    const c = call('run_bash', { command: 'rm -rf /' });
    expect(customVerdict(c, rules({ allow: ['run_bash'], ask: ['run_bash'], deny: ['run_bash:rm'] }))).toBe('deny');
    expect(customVerdict(c, rules({ allow: ['run_bash'], ask: ['run_bash'] }))).toBe('ask');
  });

  it('坏参数 JSON 不炸,退化成「只按工具名匹配」', () => {
    const bad = { id: 't1', type: 'function', function: { name: 'run_bash', arguments: '{oops' } } as ToolCall;
    expect(customVerdict(bad, rules({ ask: ['run_bash'] }))).toBe('ask');
    expect(customVerdict(bad, rules({ ask: ['run_bash:ls'] }))).toBeUndefined();
  });
});
