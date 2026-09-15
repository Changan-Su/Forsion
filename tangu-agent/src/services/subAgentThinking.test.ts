/** D3 档位分层:delegate 子代理的思考档必须**继承父 run**,而不是硬编码 medium。
 *  回归防线 —— 用户把主对话拨到 low/off,委派出去的子代理曾照样按 medium 烧推理。 */
import { describe, it, expect } from 'vitest';
import { subAgentThinkingLevel } from './subAgent.js';

describe('subAgentThinkingLevel(D3 档位继承)', () => {
  it('父 run 的档位继承下去(不再一律 medium)', () => {
    expect(subAgentThinkingLevel(undefined, 'low')).toBe('low');
    expect(subAgentThinkingLevel(undefined, 'off')).toBe('off');
    expect(subAgentThinkingLevel('', 'high')).toBe('high');
  });
  it('具名 agent 的显式档位压过父档(既有契约不动)', () => {
    expect(subAgentThinkingLevel('high', 'low')).toBe('high');
  });
  it('父 run 也没有档位时才回落会话缺省 medium', () => {
    expect(subAgentThinkingLevel(undefined, undefined)).toBe('medium');
    expect(subAgentThinkingLevel('', '')).toBe('medium');
  });
});
