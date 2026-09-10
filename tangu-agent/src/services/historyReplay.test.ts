import { describe, expect, it } from 'vitest';
import { replayAssistantHistory } from './historyReplay.js';

const call = (id: string) => ({ id, type: 'function', function: { name: 'find_roots', arguments: '{"text":"Music"}' } });
describe('execution evidence survives a new run', () => {
  it('restores tool-only rows and matching results, including serialized database columns', () => {
    const row = { content: '', tool_calls: JSON.stringify([call('c')]), tool_results: JSON.stringify([{ tool_call_id: 'c', content: 'window @r1', isError: false }]) };
    expect(replayAssistantHistory(row)).toEqual([
      { role: 'assistant', content: '', tool_calls: [call('c')] },
      { role: 'tool', tool_call_id: 'c', content: 'window @r1' },
    ]);
  });
  it('preserves failed and missing outcomes without claiming success or replaying operations', () => {
    const rows = replayAssistantHistory({ content: 'checking', tool_calls: [call('a'), call('b')], tool_results: [{ tool_call_id: 'a', content: 'access denied', isError: true }] });
    expect(rows[1].content).toContain('access denied');
    expect(rows[1].content).toContain('failed');
    expect(rows[2].content).toContain('unknown');
    expect(rows[2].content).toContain('partially executed');
  });
  it('ignores malformed calls, orphan results and duplicates while keeping normal text', () => {
    const rows = replayAssistantHistory({ content: 'text', tool_calls: [null, {}, call('c'), call('c')], tool_results: [{ tool_call_id: 'orphan', content: 'not trusted as a result' }] });
    expect(rows).toHaveLength(2);
    expect(rows[0].tool_calls).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain('orphan');
    expect(replayAssistantHistory({ content: 'text', tool_calls: '{bad', tool_results: null })).toEqual([{ role: 'assistant', content: 'text' }]);
  });
  it('bounds large outputs and leaves the stored evidence unchanged', () => {
    const row = { content: '', tool_calls: [call('c')], tool_results: [{ tool_call_id: 'c', content: 'x'.repeat(200_000) + 'END' }] };
    const before = JSON.stringify(row);
    const rows = replayAssistantHistory(row);
    expect(String(rows[1].content).length).toBeLessThan(110_000);
    expect(String(rows[1].content)).toContain('END');
    expect(JSON.stringify(row)).toBe(before);
  });
});
