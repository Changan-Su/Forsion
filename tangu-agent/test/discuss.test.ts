import { describe, it, expect } from 'vitest';
import { discussProvider } from '../src/tools/builtin/discuss.js';
import { formatConclusion } from '../src/services/discussion.js';

const hostProfile: any = { capabilities: { hostExec: true } };
const cloudProfile: any = { capabilities: { hostExec: false } };
const gate = (profile: any, ctx: any): boolean => {
  const tool = discussProvider.tools().find((t) => t.name === 'start_discussion')!;
  return !!tool.isEnabledFor!(profile, ctx);
};

describe('discuss tools — visibility gate (host-only, no recursion)', () => {
  it('visible on a host main run', () => {
    expect(gate(hostProfile, {})).toBe(true);
  });
  it('hidden inside a subagent (depth ≥ 1)', () => {
    expect(gate(hostProfile, { subAgentDepth: 1 })).toBe(false);
  });
  it('hidden inside a discussion run (no recursion)', () => {
    expect(gate(hostProfile, { inDiscussion: true })).toBe(false);
  });
  it('hidden when the profile has no hostExec (cloud)', () => {
    expect(gate(cloudProfile, {})).toBe(false);
  });
  it('exposes exactly start_discussion + wait_discussion', () => {
    expect(discussProvider.tools().map((t) => t.name).sort()).toEqual(['start_discussion', 'wait_discussion']);
  });
});

describe('formatConclusion', () => {
  it('prefers the moderator (主持人) summary as the conclusion', () => {
    const msgs = ['**🗣 A**\n\nfoo', '**🗣 B**\n\nbar', '**🗣 主持人**\n\nSUMMARY'];
    expect(formatConclusion(msgs, 'done')).toBe('**🗣 主持人**\n\nSUMMARY');
  });
  it('falls back to the full transcript when there is no summary', () => {
    const msgs = ['**🗣 A**\n\nfoo', '**🗣 B**\n\nbar'];
    expect(formatConclusion(msgs, 'done')).toBe('**🗣 A**\n\nfoo\n\n**🗣 B**\n\nbar');
  });
  it('reports in-progress when empty and not terminal', () => {
    expect(formatConclusion([], 'running')).toContain('in progress');
  });
  it('reports no-output when empty and terminal', () => {
    expect(formatConclusion([], 'failed')).toBe('(discussion failed with no output)');
  });
  it('prefixes a status note for non-done terminal states', () => {
    expect(formatConclusion(['**🗣 主持人**\n\nS'], 'aborted')).toBe('(discussion ended: aborted)\n\n**🗣 主持人**\n\nS');
  });
});
