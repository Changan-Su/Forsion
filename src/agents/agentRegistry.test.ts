import { describe, it, expect } from 'vitest';
import { parseAgentFile, serializeAgent, slugify, isValidSlug, type NormalAgentDef } from './agentRegistry.js';

describe('slugify / isValidSlug', () => {
  it('lowercases + hyphenates + strips', () => {
    expect(slugify('Code Reviewer!')).toBe('code-reviewer');
    expect(slugify('  多  空格  ')).toBe('agent'); // 非 ascii 全过滤 → 兜底
    expect(slugify('')).toBe('agent');
  });
  it('validates slug shape', () => {
    expect(isValidSlug('code-reviewer')).toBe(true);
    expect(isValidSlug('a')).toBe(true);
    expect(isValidSlug('Bad Slug')).toBe(false);
    expect(isValidSlug('-leading')).toBe(false);
    expect(isValidSlug('x'.repeat(65))).toBe(false);
  });
});

describe('parseAgentFile', () => {
  it('parses frontmatter scalars + tools list + body', () => {
    const raw = [
      '---',
      'name: Code Reviewer',
      'description: Reviews PRs',
      'model: gpt-x',
      'tools: a, b, c',
      'thinkingLevel: high',
      'maxIterations: 50',
      'approvalMode: auto-edit',
      'created_by: agent',
      'created_at: 2026-06-18T00:00:00.000Z',
      '---',
      'You are a reviewer.',
      'Second line.',
    ].join('\n');
    const d = parseAgentFile('code-reviewer', raw);
    expect(d.name).toBe('Code Reviewer');
    expect(d.description).toBe('Reviews PRs');
    expect(d.model).toBe('gpt-x');
    expect(d.tools).toEqual(['a', 'b', 'c']);
    expect(d.thinkingLevel).toBe('high');
    expect(d.maxIterations).toBe(50);
    expect(d.approvalMode).toBe('auto-edit');
    expect(d.createdBy).toBe('agent');
    expect(d.systemPrompt).toBe('You are a reviewer.\nSecond line.');
  });

  it('tolerates inline-array tools + missing fields', () => {
    const d = parseAgentFile('x', '---\nname: X\ntools: [one, "two"]\n---\nbody');
    expect(d.tools).toEqual(['one', 'two']);
    expect(d.model).toBe('');
    expect(d.thinkingLevel).toBe('');
    expect(d.maxIterations).toBe(null);
    expect(d.createdBy).toBe('user'); // 默认
  });

  it('rejects invalid thinking/approval/maxIterations', () => {
    const d = parseAgentFile('x', '---\nname: X\nthinkingLevel: bogus\napprovalMode: nope\nmaxIterations: -5\n---\nb');
    expect(d.thinkingLevel).toBe('');
    expect(d.approvalMode).toBe('');
    expect(d.maxIterations).toBe(null);
  });

  it('no frontmatter → whole body, name=slug', () => {
    const d = parseAgentFile('plain', 'just a persona');
    expect(d.name).toBe('plain');
    expect(d.systemPrompt).toBe('just a persona');
  });
});

describe('serializeAgent ↔ parseAgentFile round-trip', () => {
  it('survives a round trip', () => {
    const def: NormalAgentDef = {
      slug: 'r', name: 'Round', description: 'd', model: 'm', tools: ['t1', 't2'],
      thinkingLevel: 'medium', maxIterations: 30, approvalMode: 'full-auto',
      createdBy: 'user', createdAt: '2026-06-18T00:00:00.000Z', systemPrompt: 'persona body',
    };
    const back = parseAgentFile('r', serializeAgent(def));
    expect(back).toEqual(def);
  });
});
