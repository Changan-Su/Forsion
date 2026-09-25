import { describe, it, expect, vi } from 'vitest';
import { parseAgentFile, serializeAgent, slugify, isValidSlug, parseAgentConfig, serializeAgentConfig, buildAgentDef, AGENT_MAX_ITERATIONS_MIN, type NormalAgentDef } from './agentRegistry.js';

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

  it('rejects invalid thinking/maxIterations; unknown approval fails closed to readonly', () => {
    const d = parseAgentFile('x', '---\nname: X\nthinkingLevel: bogus\napprovalMode: nope\nmaxIterations: -5\n---\nb');
    expect(d.thinkingLevel).toBe('');
    // H5(2026-09-25):未知非空审批档不再静默写成 ''(= 跟随会话,可能更宽),而是按 readonly
    expect(d.approvalMode).toBe('readonly');
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
      slug: 'r', name: 'Round', version: '1.0.0', description: 'd', model: 'm', tools: ['t1', 't2'],
      thinkingLevel: 'medium', maxIterations: 30, approvalMode: 'full-auto',
      createdBy: 'user', createdAt: '2026-06-18T00:00:00.000Z', systemPrompt: 'persona body',
    };
    const back = parseAgentFile('r', serializeAgent(def));
    expect(back).toEqual(def);
  });
});

describe('config.toml apps tag (per-app 标签)', () => {
  it('parses + normalizes apps array (小写/去空格)', () => {
    expect(parseAgentConfig('x', 'name = "X"\napps = ["Echo", " tangu "]\n', '').apps).toEqual(['echo', 'tangu']);
  });
  it('missing apps → []', () => {
    expect(parseAgentConfig('x', 'name = "X"\n', '').apps).toEqual([]);
  });
  it('survives serialize → parse round-trip', () => {
    const def: NormalAgentDef = {
      slug: 'r', name: 'R', version: '1.0.0', description: '', model: '', tools: [],
      thinkingLevel: '', maxIterations: null, approvalMode: '',
      createdBy: 'user', createdAt: '2026-06-18T00:00:00.000Z', systemPrompt: 'p',
      apps: ['echo'],
    };
    expect(parseAgentConfig('r', serializeAgentConfig(def), '').apps).toEqual(['echo']);
  });
  it('version: 持久化并回读;缺省 → 1.0.0', () => {
    const base: NormalAgentDef = {
      slug: 'r', name: 'R', version: '2.3.0', description: '', model: '', tools: [],
      thinkingLevel: '', maxIterations: null, approvalMode: '',
      createdBy: 'user', createdAt: '2026-06-18T00:00:00.000Z', systemPrompt: 'p',
    };
    expect(parseAgentConfig('r', serializeAgentConfig(base), '').version).toBe('2.3.0');
    expect(parseAgentConfig('r', 'name = "R"\n', '').version).toBe('1.0.0'); // 缺省
  });
});

describe('created_by = system (系统 agent,如 Muse)', () => {
  it('serialize → parse 保留 system;未知值回落 user', () => {
    const def: NormalAgentDef = {
      slug: 'muse', name: 'Muse', version: '1.0.0', description: '', model: '', tools: [],
      thinkingLevel: '', maxIterations: null, approvalMode: '',
      createdBy: 'system', createdAt: '2026-07-01T00:00:00.000Z', systemPrompt: 'p',
    };
    expect(parseAgentConfig('muse', serializeAgentConfig(def), '').createdBy).toBe('system');
    expect(parseAgentConfig('x', 'created_by = "weird"\n', '').createdBy).toBe('user');
    expect(parseAgentConfig('x', 'created_by = "agent"\n', '').createdBy).toBe('agent');
    expect(parseAgentConfig('x', '', '').createdBy).toBe('user');
  });
});

describe('buildAgentDef · max_iterations 下限', () => {
  it('低于下限清空(不 throw:头像上传等路径会原样透传旧值)并告警', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const def = buildAgentDef('a1', null, { name: 'A', systemPrompt: 'p', maxIterations: 3 } as any);
    expect(def.maxIterations).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });
  it('达到下限保留;解析仍忠实于磁盘值(UI 要能看见误设的 3)', () => {
    const def = buildAgentDef('a1', null, { name: 'A', systemPrompt: 'p', maxIterations: AGENT_MAX_ITERATIONS_MIN } as any);
    expect(def.maxIterations).toBe(AGENT_MAX_ITERATIONS_MIN);
    expect(parseAgentConfig('a1', 'name = "A"\nmax_iterations = 3\n', '').maxIterations).toBe(3);
  });
});

describe('config.toml [compaction] 表(09-15 压缩旋钮 per-agent 层)', () => {
  it('解析:合法字段归一化后进 def.compaction;非法字段丢弃;无表则无字段', () => {
    const toml = [
      'name = "Long Runner"',
      '',
      '[compaction]',
      'reserveTokens = 32000',
      'keepRecentTokens = 40000',
      'thinking = "inherit"',
      'instructions = "always keep ticket ids"',
      'summaryMaxTokens = "abc"',
      'bogus = 1',
    ].join('\n');
    const def = parseAgentConfig('runner', toml, '');
    expect(def.compaction).toEqual({ reserveTokens: 32000, keepRecentTokens: 40000, thinking: 'inherit', instructions: 'always keep ticket ids' });
    expect(parseAgentConfig('plain', 'name = "x"', '').compaction).toBeUndefined();
  });
  it('序列化 ↔ 解析往返:全部七个字段;[compaction] 表落在标量键之后,不吞掉多行 developer_instructions', () => {
    const compaction = {
      enabled: false, reserveTokens: 32000, keepRecentTokens: 40000, summaryMaxTokens: 4096,
      thinking: 'low', model: 'cheap-model', instructions: 'keep ids', prompt: 'CUSTOM BASE',
    };
    const def = { ...parseAgentConfig('r', 'name = "r"', ''), compaction, systemPrompt: 'line1\nline2' } as NormalAgentDef;
    const toml = serializeAgentConfig(def);
    expect(toml).toContain('[compaction]');
    expect(toml.indexOf("developer_instructions = '''")).toBeLessThan(toml.indexOf('[compaction]'));
    const back = parseAgentConfig('r', toml, '');
    expect(back.compaction).toEqual(compaction);
    expect(back.systemPrompt).toBe('line1\nline2');
    expect(back.name).toBe('r');
    // 单行 developer_instructions 那条路同样不被表头吞掉
    const single = serializeAgentConfig({ ...def, systemPrompt: 'one line' } as NormalAgentDef);
    expect(parseAgentConfig('r', single, '')).toMatchObject({ systemPrompt: 'one line', compaction });
  });
});
