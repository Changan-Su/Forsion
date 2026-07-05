/**
 * Phase 2 B(云端运行水合)的包级契约 + 人格组装。forsionSeams/httpBrain 的 `brain.agents.getAgent`
 * 就是「读 config.toml + SOUL.md → parseAgentConfig」;agentLoop 据 def 注入人格、按 resolveMemorySlug 定记忆桶。
 */
import { describe, it, expect } from 'vitest';
import { parseAgentConfig, resolveMemorySlug, currentAgentSlug, DEFAULT_AGENT_SLUG } from '../src/index.js';

describe('Phase B — package exports the cloud-hydration API', () => {
  it('exposes parseAgentConfig / resolveMemorySlug / currentAgentSlug / DEFAULT_AGENT_SLUG', () => {
    expect(typeof parseAgentConfig).toBe('function');
    expect(typeof resolveMemorySlug).toBe('function');
    expect(typeof currentAgentSlug).toBe('function');
    expect(DEFAULT_AGENT_SLUG).toBe('xyra');
  });
});

describe('Phase B — cloud persona assembly (what brain.agents.getAgent does)', () => {
  it('assembles persona/model/library from config.toml + SOUL.md', () => {
    const toml = 'name = "Researcher"\nmodel = "gpt-5.5"\nlibrary_order = ["notes.md"]\ndeveloper_instructions = "be rigorous"';
    const def = parseAgentConfig('researcher', toml, '# Soul\ncurious');
    expect(def.systemPrompt).toBe('be rigorous');
    expect(def.soul).toBe('# Soul\ncurious');
    expect(def.libraryOrder).toEqual(['notes.md']);
    expect(def.model).toBe('gpt-5.5');
    expect(resolveMemorySlug(def)).toBe('researcher'); // 专属记忆 → 自己 slug
  });

  it('share_default_memory agent routes memory to xyra scope (so cloud memory hits the right bucket)', () => {
    const def = parseAgentConfig('cat', 'name = "Cat"\nshare_default_memory = true', '');
    expect(resolveMemorySlug(def)).toBe('xyra');
  });
});
