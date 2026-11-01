import { describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// @ts-expect-error test-only JavaScript harness module
import { classifyTaskOutcome, taskOutcomesLive } from '../scripts/lib/task-outcomes-live.mjs';
describe('task outcome accounting', () => {
  it('does not equate model narration with an actual result', () => {
    expect(classifyTaskOutcome({ claimedSuccess: true, observed: false })).toMatchObject({ outcome: 'model_behavior', falseSuccess: true });
    expect(classifyTaskOutcome({ observed: true })).toMatchObject({ outcome: 'completed', falseSuccess: false });
  });
  it('separates product invariants, external service failures and unknown writes', () => {
    expect(classifyTaskOutcome({ invariantErrors: ['secret reached another origin'] }).outcome).toBe('product_failure');
    expect(classifyTaskOutcome({ externalFailure: true }).outcome).toBe('external_failure');
    expect(classifyTaskOutcome({ cancelled: true, sent: true, observed: true }).outcome).toBe('outcome_unknown');
  });
  it.each([
    ['Not DONE: I did not complete the task.', 0],
    ['The requested success marker was "DONE"; the task remains incomplete.', 0],
    ['> DONE\n\nThat is quoted document text, not my result.', 0],
    ['DONE', 5],
  ])('accounts for the standalone completion marker in %j', async (content, expectedFalseSuccess) => {
    const dir = mkdtempSync(join(tmpdir(), 'task-outcome-marker-'));
    try {
      await taskOutcomesLive({ workspace: dir, out: dir, model: 'fixture', tokensOf: () => 0,
        run: async () => ({ content, done: true, runId: 'fixture', wallMs: 0,
          toolResults: [], toolCallIds: [], toolCalls: [], approvalResults: [], usages: [] }),
      });
      const evidence = JSON.parse(readFileSync(join(dir, 'taskoutcomes-evidence.json'), 'utf8'));
      expect(evidence.falseSuccess).toBe(expectedFalseSuccess);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
