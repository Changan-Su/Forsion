import { describe, expect, it } from 'vitest';
import { RepeatedToolFailureGuard } from './repeatedToolFailure.js';
import type { ToolCall } from '../core/types.js';

const call = (id: string, args = '{"action":"update","id":"one"}'): ToolCall => ({
  id, type: 'function', function: { name: 'remember', arguments: args },
});
const error = (id: string, content = 'Error: fact is required') => ({ tool_call_id: id, content, isError: true });

describe('repeated tool failure guard', () => {
  it('recognizes unchanged arguments despite new call IDs and reordered JSON keys', () => {
    const guard = new RepeatedToolFailureGuard();
    expect(guard.record([call('a')], [error('a')])).toBe(false);
    expect(guard.record([call('b', ' { "id": "one", "action": "update" } ')], [error('b')])).toBe(false);
    expect(guard.record([call('c')], [error('c')])).toBe(true);
  });

  it('allows different parameters, different errors, progress, and user steering to recover', () => {
    const guard = new RepeatedToolFailureGuard();
    const twice = () => { guard.record([call('a')], [error('a')]); guard.record([call('b')], [error('b')]); };
    twice();
    expect(guard.record([call('c', '{"fact":"New name"}')], [error('c')])).toBe(false);
    twice();
    expect(guard.record([call('d')], [error('d', 'Error: version conflict')])).toBe(false);
    twice();
    expect(guard.record([call('ok')], [{ tool_call_id: 'ok', isError: false, content: 'saved' }])).toBe(false);
    twice(); guard.reset();
    expect(guard.record([call('e')], [error('e')])).toBe(false);
  });

  it('handles failed batches in any order but treats a successful result as progress', () => {
    const guard = new RepeatedToolFailureGuard();
    const other = { ...call('b'), function: { name: 'read_file', arguments: '{"path":"missing"}' } };
    expect(guard.record([call('a'), other], [error('a'), error('b')])).toBe(false);
    expect(guard.record([other, call('a')], [error('a'), error('b')])).toBe(false);
    expect(guard.record([call('a'), other], [error('a'), error('b')])).toBe(true);
    expect(guard.record([call('a'), other], [error('a'), { tool_call_id: 'b', isError: false }])).toBe(false);
    expect(guard.record([call('a'), other], [error('a'), error('b')])).toBe(false);
  });
});
