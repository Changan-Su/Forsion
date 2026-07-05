import { describe, it, expect, afterEach, vi } from 'vitest';
import { fetchProviderModels } from './providerOAuth.js';

describe('fetchProviderModels', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('parses { data: [{ id }] } (Claude / OpenAI shape)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: true, json: () => Promise.resolve({ data: [{ id: 'claude-x' }, { id: 'claude-y' }] }) }));
    const r = await fetchProviderModels({ protocol: 'anthropic-messages', baseUrl: 'https://api.anthropic.com' } as any, 'tok');
    expect(r).toEqual(['claude-x', 'claude-y']);
  });

  it('parses [{ slug, visibility }] and drops hidden (Codex shape)', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve({
        ok: true,
        json: () => Promise.resolve([
          { slug: 'gpt-5.3-codex', visibility: 'list' },
          { slug: 'codex-auto-review', visibility: 'hide' },
        ]),
      }),
    );
    const r = await fetchProviderModels({ protocol: 'openai-responses', baseUrl: 'https://chatgpt.com/backend-api/codex' } as any, 'tok', 'acct');
    expect(r).toEqual(['gpt-5.3-codex']);
  });

  it('returns null on http error (→ caller falls back to curated hints)', async () => {
    vi.stubGlobal('fetch', () => Promise.resolve({ ok: false, json: () => Promise.resolve({}) }));
    const r = await fetchProviderModels({ protocol: 'openai', baseUrl: 'https://api.x.ai/v1' } as any, 'tok');
    expect(r).toBeNull();
  });
});
