import { describe, expect, it } from 'vitest';
import { CompactionAttemptGuard, ContextUsageTracker, estimateMessageTokens, estimateMessagesTokens } from '../src/services/contextBudget.js';
import { normalizeImageAttachments, toImageParts } from '../src/services/imageAttachments.js';

// 5e42265b: same payload length as the reported screenshot; no private image is checked in.
const screenshot = 'A'.repeat(2_406_140);
const imageMessage = (data: string) => ({ role: 'user', content: toImageParts('inspect this',
  normalizeImageAttachments([{ mimeType: 'image/png', data }])) });

describe('multimodal context budget regression', () => {
  it('does not count a screenshot transport encoding as 300k model tokens', () => {
    const message = imageMessage(screenshot);
    const before = JSON.stringify(message);
    expect(estimateMessageTokens(message)).toBeLessThan(10_000);
    expect(estimateMessageTokens(message)).toBe(estimateMessageTokens(imageMessage('AAAA')));
    expect(JSON.stringify(message)).toBe(before); // the estimator must not rewrite or drop the image
  });

  it('also discounts images inside Responses tool outputs, not just user attachments', () => {
    const replay = { role: 'assistant', content: '', providerItems: [{ type: 'function_call_output',
      call_id: 'shot', output: [{ type: 'input_image', image_url: `data:image/png;base64,${screenshot}` }] }] };
    expect(estimateMessageTokens(replay)).toBeLessThan(10_000);
  });

  it('counts each image but continues to budget large real text', () => {
    const one = imageMessage(screenshot);
    expect(estimateMessagesTokens([one, one] as any)).toBe(estimateMessageTokens(one) * 2);
    expect(estimateMessageTokens({ role: 'user', content: 'x'.repeat(400_000) })).toBeGreaterThan(99_000);
  });
});

describe('measured usage and compaction progress', () => {
  it('uses measured input plus new tool results without letting the old estimate override it', () => {
    const usage = new ContextUsageTracker();
    const messages: any[] = [imageMessage(screenshot), { role: 'user', content: 'x'.repeat(100_000) }];
    usage.observe(messages, 2300);
    expect(usage.estimate(messages)).toBe(2300);
    const tool = { role: 'tool', content: 'x'.repeat(80_000), tool_call_id: 't' };
    messages.push(tool);
    expect(usage.estimate(messages)).toBe(2300 + estimateMessageTokens(tool));
    expect(usage.estimate(messages)).toBeGreaterThan(20_000); // new big outputs must not be hidden
  });

  it('invalidates stale baselines after compaction, prefix changes, and missing usage', () => {
    const usage = new ContextUsageTracker();
    const messages: any[] = [{ role: 'user', content: 'small' }];
    usage.observe(messages, 50_000);
    messages[0].content = 'changed'.repeat(100);
    expect(usage.estimate(messages)).toBe(estimateMessagesTokens(messages));
    usage.observe(messages, 50_000);
    usage.invalidate();
    expect(usage.estimate(messages)).toBe(estimateMessagesTokens(messages));
    usage.observe(messages, 0);
    expect(usage.estimate(messages)).toBe(estimateMessagesTokens(messages));
  });

  it('does not repeatedly summarize an unchanged high-water context', () => {
    const guard = new CompactionAttemptGuard();
    expect(guard.shouldAttempt(98_000)).toBe(true);
    guard.record(97_000, 100_000);
    expect(guard.shouldAttempt(97_000)).toBe(false);
    expect(guard.shouldAttempt(97_100)).toBe(false);
    expect(guard.shouldAttempt(100_000)).toBe(true);
    guard.record(20_000, 100_000);
    expect(guard.shouldAttempt(96_000)).toBe(true);
  });

  it('does not recompact just because provider calibration changes the reported size', () => {
    const guard = new CompactionAttemptGuard();
    const messages: any[] = [{ role: 'system', content: 'compacted summary' }];
    guard.record(100, 100_000, messages);
    messages.push({ role: 'assistant', content: 'checking' });
    expect(guard.shouldAttempt(98_000, messages)).toBe(false);
    messages.push({ role: 'tool', content: 'x'.repeat(20_000) });
    expect(guard.shouldAttempt(98_000, messages)).toBe(true);
  });
});
