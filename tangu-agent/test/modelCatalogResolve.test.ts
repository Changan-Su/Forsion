/**
 * resolveModelQuery · 同名模型不静默选错(Codex 09-25 P2):
 *   两个直连 provider 都提供「gpt-5」时,旧口径对精确名称用 find → 取目录第一项,/model 与 update_session_settings
 *   会静默切到另一家 provider。现在:id 精确优先(id 唯一);精确名称命中多条 → ambiguous,调用方列候选。
 */
import { describe, expect, it } from 'vitest';
import { resolveModelQuery, type CatalogModel } from '../src/services/modelCatalog.js';

const M = (id: string, name: string, provider: string): CatalogModel =>
  ({ id, name, provider, source: 'direct', modelType: 'llm', contextWindow: 1, contextWindowSource: 'default', supportsVision: false } as CatalogModel);

const models = [
  M('openai/gpt-5', 'gpt-5', 'openai'),
  M('azure/gpt-5', 'gpt-5', 'azure'),
  M('anthropic/claude-opus-5-5', 'Claude Opus 5.5', 'anthropic'),
  M('ollama/qwen3.5:4b', 'qwen3.5:4b', 'ollama'),
];

describe('resolveModelQuery · 精确名称多条命中', () => {
  it('两家 provider 同名 → ambiguous,两条都列出(不是目录第一项)', () => {
    const r = resolveModelQuery('gpt-5', models);
    expect(r.kind).toBe('ambiguous');
    expect(r.kind === 'ambiguous' && r.candidates.map((m) => m.id).sort()).toEqual(['azure/gpt-5', 'openai/gpt-5']);
    // 大小写 / 空格折叠后同名也算
    expect(resolveModelQuery('GPT 5', models).kind).toBe('ambiguous');
  });

  it('id 精确永远先判:给全 id / provider:model 写法直接命中那一家', () => {
    expect(resolveModelQuery('azure/gpt-5', models)).toMatchObject({ kind: 'hit', model: { id: 'azure/gpt-5' } });
    expect(resolveModelQuery('openai:gpt-5', models)).toMatchObject({ kind: 'hit', model: { id: 'openai/gpt-5' } });
  });

  it('名称唯一照旧命中;ollama 带冒号的 tag 不被改写吞掉', () => {
    expect(resolveModelQuery('claude opus 5.5', models)).toMatchObject({ kind: 'hit', model: { id: 'anthropic/claude-opus-5-5' } });
    expect(resolveModelQuery('qwen3.5:4b', models)).toMatchObject({ kind: 'hit', model: { id: 'ollama/qwen3.5:4b' } });
  });

  it('某条的 id 恰好等于另一条的名称 → 取 id 那条', () => {
    const tricky = [M('x/alpha', 'beta', 'x'), M('beta', 'Beta Cloud', 'forsion')];
    expect(resolveModelQuery('beta', tricky)).toMatchObject({ kind: 'hit', model: { id: 'beta' } });
  });

  it('归一后 id 相撞(云端 Qwen/Qwen3-235B × 直连 qwen/qwen3-235b):原样 id 精确命中那一家;大小写不对 → ambiguous,不取目录第一项', () => {
    const clash = [
      { ...M('Qwen/Qwen3-235B', 'Qwen3 235B', 'forsion'), source: 'forsion' as const },
      M('qwen/qwen3-235b', 'qwen3-235b', 'qwen'),
      ...models,
    ];
    expect(resolveModelQuery('Qwen/Qwen3-235B', clash)).toMatchObject({ kind: 'hit', model: { id: 'Qwen/Qwen3-235B' } });
    expect(resolveModelQuery('qwen/qwen3-235b', clash)).toMatchObject({ kind: 'hit', model: { id: 'qwen/qwen3-235b' } });
    expect(resolveModelQuery('  qwen:qwen3-235b ', clash)).toMatchObject({ kind: 'hit', model: { id: 'qwen/qwen3-235b' } }); // provider:model 原样写法
    for (const q of ['QWEN/QWEN3-235B', 'qwen/Qwen3_235B', 'Qwen:qwen3 235b']) {
      const r = resolveModelQuery(q, clash);
      expect(r.kind, q).toBe('ambiguous');
      expect(r.kind === 'ambiguous' && r.candidates.map((m) => m.id).sort(), q).toEqual(['Qwen/Qwen3-235B', 'qwen/qwen3-235b']);
    }
    // 归一后只撞一条的照旧命中
    expect(resolveModelQuery('AZURE/GPT-5', clash)).toMatchObject({ kind: 'hit', model: { id: 'azure/gpt-5' } });
  });
});
