import { describe, expect, it } from 'vitest';
import { teamOutputCollector } from '../src/services/teamOutputs.js';

const source = { runId: 'run-a', sessionId: 'child-a', slug: 'a', name: 'Agent A', modelId: 'model' };
describe('public team deliverables', () => {
  it('requires a successful complete sketch, ignores private output, and preserves full HTML', () => {
    const collect = teamOutputCollector(source);
    const html = `<p>${'完整内容'.repeat(1000)}</p>`;
    expect(collect({ seq: 1, type: 'tool_call', payload: { id: 's', name: 'sketch', arguments: JSON.stringify({ html }) } })).toBeUndefined();
    expect(collect({ seq: 2, type: 'tool_result', payload: { id: 's', result: 'Error: rejected' } })).toBeUndefined();
    expect(collect({ seq: 3, type: 'reasoning', payload: { delta: 'private' } })).toBeUndefined();
    expect(collect({ seq: 4, type: 'tool_result', payload: { id: 'missing', result: 'ok' } })).toBeUndefined();
    const event = { seq: 5, type: 'tool_result', payload: { id: 's', result: 'Rendered.' } };
    const output = collect(event)!;
    expect(JSON.parse(output.toolCalls[0].function.arguments).html).toBe(html);
    expect(collect(event)).toBeUndefined();
    const replay = teamOutputCollector(source);
    replay({ seq: 1, type: 'tool_call', payload: { id: 's', name: 'sketch', arguments: JSON.stringify({ html }) } });
    expect(replay(event)?.messageId).toBe(output.messageId);
  });
  it('forwards image, audio and document files with their source, without conflating members or duplicate events', () => {
    const a = teamOutputCollector(source);
    const b = teamOutputCollector({ ...source, runId: 'run-b' });
    for (const [seq, name, mime] of [[1, 'image.png', 'image/png'], [2, 'voice.mp3', 'audio/mpeg'], [3, 'report.pdf', 'application/pdf']] as const) {
      const ev = { seq, type: 'display_file', payload: { name, mime, path: `/tmp/${name}` } };
      const output = a(ev)!;
      expect(output.displayFiles?.[0]).toMatchObject({ name, mime, sourceSessionId: 'child-a' });
      expect(a(ev)).toBeUndefined();
      expect(b(ev)?.messageId).not.toBe(output.messageId);
    }
    expect(a({ seq: 4, type: 'display_file', payload: { name: 'broken' } })).toBeUndefined();
  });
});
