import { describe, it, expect, vi, beforeEach } from 'vitest';

// 用内存 map 替身代替插件设置存储(避免读 ~/.tangu/config),以验证 resolveReplySegment 的分支:
// 新 id 启用 / per-agent apply 覆盖 / 旧 wechat-segment 回落 / 全关。
const enabled = new Map<string, boolean>();
const settings = new Map<string, Record<string, any>>();
vi.mock('../plugins/settingsStore.js', () => ({
  isPluginEnabledSync: (id: string) => !!enabled.get(id),
  // 替身直接存「该作用域解析后」的值:有 agent 覆盖取之,否则取全局。
  getPluginSettingsSync: (id: string, opts?: { agentSlug?: string }) =>
    (opts?.agentSlug && settings.get(`${id}:${opts.agentSlug}`)) || settings.get(id) || {},
}));

import { resolveReplySegment } from './replySegment.js';

beforeEach(() => { enabled.clear(); settings.clear(); });

describe('resolveReplySegment', () => {
  it('两者皆未启用 → 不分段', () => {
    expect(resolveReplySegment()).toEqual({ enabled: false });
  });

  it('新 id 启用 + apply 默认开 → 分段,带延迟', () => {
    enabled.set('reply-segment', true);
    settings.set('reply-segment', { apply: true, segmentDelayMs: 500 });
    expect(resolveReplySegment()).toEqual({ enabled: true, delayBase: 500 });
  });

  it('per-agent apply=false 覆盖 → 该 agent 不分段,其余照常', () => {
    enabled.set('reply-segment', true);
    settings.set('reply-segment', { apply: true, segmentDelayMs: 500 });
    settings.set('reply-segment:bob', { apply: false, segmentDelayMs: 500 });
    expect(resolveReplySegment('bob').enabled).toBe(false);
    expect(resolveReplySegment('alice').enabled).toBe(true);
  });

  it('apply 缺省(未注册/未设)按开处理(undefined !== false)', () => {
    enabled.set('reply-segment', true);
    settings.set('reply-segment', { segmentDelayMs: 450 });
    expect(resolveReplySegment()).toEqual({ enabled: true, delayBase: 450 });
  });

  it('新 id 未启用但旧 wechat-segment 启用 → 沿用旧全局行为', () => {
    enabled.set('wechat-segment', true);
    settings.set('wechat-segment', { segmentDelayMs: 300 });
    expect(resolveReplySegment()).toEqual({ enabled: true, delayBase: 300 });
  });

  it('非数值延迟 → delayBase 留空(用内置默认)', () => {
    enabled.set('reply-segment', true);
    settings.set('reply-segment', { apply: true, segmentDelayMs: 'oops' });
    expect(resolveReplySegment()).toEqual({ enabled: true, delayBase: undefined });
  });
});
