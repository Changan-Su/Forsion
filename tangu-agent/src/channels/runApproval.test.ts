/**
 * 通道 run 的审批档 = 通道设置 × 绑定 × Agent 自己的档(设了才算)里最严的那个。矩阵钉住:
 *   - 只收紧不放宽;Agent 没设 → 和只有通道 × 绑定时一样;Agent 的 custom / 不认识的值 → 只读。
 */
import { describe, it, expect } from 'vitest';
// hub 先进:直接先进 service 会经 agentLoop → standInRun → hub 半路撞上还没求值完的 service(既有的环,生产入口从 hub 进)
import './hub.js';
import { channelRunApprovalMode } from './service.js';
import { agentApprovalCeiling, tightenChannelApprovalForAgent } from './runApproval.js';

const THREE = ['readonly', 'auto-edit', 'full-auto'] as const;
const RANK: Record<string, number> = { readonly: 0, 'auto-edit': 1, 'full-auto': 2 };
const min = (...xs: string[]): string => xs.reduce((a, b) => (RANK[a] <= RANK[b] ? a : b));

describe('agentApprovalCeiling', () => {
  it('没设 → 不参与;三档原样;custom / 不认识 → readonly', () => {
    expect(agentApprovalCeiling(undefined)).toBeUndefined();
    expect(agentApprovalCeiling(null)).toBeUndefined();
    expect(agentApprovalCeiling('')).toBeUndefined();
    for (const m of THREE) expect(agentApprovalCeiling(m)).toBe(m);
    expect(agentApprovalCeiling('custom')).toBe('readonly');
    expect(agentApprovalCeiling('bogus')).toBe('readonly');
  });
});

describe('channelRunApprovalMode:通道设置 × 绑定 × Agent 档', () => {
  // Agent 档:未设(三种写法)/ 三档 / custom
  const AGENT: Array<[unknown, (ch: string) => string]> = [
    [undefined, (ch) => ch],
    ['', (ch) => ch],
    [null, (ch) => ch],
    ['readonly', () => 'readonly'],
    ['auto-edit', (ch) => min(ch, 'auto-edit')],
    ['full-auto', (ch) => ch],
    ['custom', () => 'readonly'],
  ];
  for (const s of THREE) for (const b of THREE) for (const [agent, want] of AGENT) {
    it(`设置 ${s} × 绑定 ${b} × Agent ${JSON.stringify(agent)}`, () => {
      expect(channelRunApprovalMode(s, { remote_approval_mode: b }, [agent])).toBe(want(min(s, b)));
    });
  }

  it('不带 Agent 档 = 旧的两者取严(逐字节同旧口径)', () => {
    for (const s of THREE) for (const b of THREE) {
      expect(channelRunApprovalMode(s, { remote_approval_mode: b })).toBe(min(s, b));
      expect(channelRunApprovalMode(s, { remote_approval_mode: b }, [])).toBe(min(s, b));
    }
  });

  it('分身:自己没设、本体设了只读 → 只读;本体读不到按只读传入', () => {
    expect(channelRunApprovalMode('full-auto', { remote_approval_mode: 'full-auto' }, ['', 'readonly'])).toBe('readonly');
    expect(channelRunApprovalMode('full-auto', { remote_approval_mode: 'full-auto' }, [undefined, 'auto-edit'])).toBe('auto-edit');
    expect(channelRunApprovalMode('auto-edit', { remote_approval_mode: 'auto-edit' }, ['', 'full-auto'])).toBe('auto-edit');
  });
});

describe('tightenChannelApprovalForAgent', () => {
  it('Agent 全都没设 → 原值原样返回(不归一)', () => {
    expect(tightenChannelApprovalForAgent('full-auto', [undefined, ''])).toBe('full-auto');
    const odd = { weird: true };
    expect(tightenChannelApprovalForAgent(odd, [])).toBe(odd);
  });
  it('通道档 × Agent 档 取严', () => {
    for (const ch of THREE) for (const a of THREE) expect(tightenChannelApprovalForAgent(ch, [a])).toBe(min(ch, a));
  });
});
