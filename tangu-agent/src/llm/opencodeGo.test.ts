import { describe, it, expect } from 'vitest';
import { buildOpenCodeHeaders, isOpenCodeHost, openCodeSessionId, OPENCODE_USER_AGENT } from './opencodeGo.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('OpenCode 网关请求契约', () => {
  it('host 全等 opencode.ai 才算(Go / Zen 都算;子域伪装、别家、非法 URL 不算)', () => {
    expect(isOpenCodeHost('https://opencode.ai/inference/go/v1')).toBe(true);
    expect(isOpenCodeHost('https://OpenCode.ai/zen/v1')).toBe(true);
    expect(isOpenCodeHost('https://opencode.ai.evil.tld/inference/go/v1')).toBe(false);
    expect(isOpenCodeHost('https://evil.tld/opencode.ai/v1')).toBe(false);
    expect(isOpenCodeHost('https://api.openai.com/v1')).toBe(false);
    expect(isOpenCodeHost('not a url')).toBe(false);
    expect(isOpenCodeHost(undefined)).toBe(false);
  });

  it('会话头:同一个键永远同一个值,派生键哈希成 UUID 形状,没有键也一定有值', () => {
    const sid = '0F2E8C9A-1B2C-4D3E-8F90-A1B2C3D4E5F6';
    expect(openCodeSessionId(sid)).toBe(sid.toLowerCase());
    const sub = openCodeSessionId(`${sid}:sub:1`);
    expect(sub).toMatch(UUID);
    expect(openCodeSessionId(`${sid}:sub:1`)).toBe(sub);
    expect(openCodeSessionId(`${sid}:sub:2`)).not.toBe(sub);
    expect(sub).not.toContain(':sub:'); // 内部键的拼法不上 wire
    const a = openCodeSessionId(undefined), b = openCodeSessionId('  ');
    expect(a).toMatch(UUID);
    expect(b).toMatch(UUID);
    expect(a).not.toBe(b);
  });

  it('两个必需头:x-opencode-session + 自报身份的 User-Agent(不是 node / undici 这类通用名)', () => {
    const h = buildOpenCodeHeaders('btw:abc');
    expect(h['x-opencode-session']).toBe(openCodeSessionId('btw:abc'));
    expect(h['User-Agent']).toBe(OPENCODE_USER_AGENT);
    expect(OPENCODE_USER_AGENT).toMatch(/^forsion-[a-z-]+\/\d/);
  });
});
