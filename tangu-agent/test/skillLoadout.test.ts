/**
 * skillLoadout — /skill 经 requestedSkillIds 的「加性」语义(回归「点选一个技能其它都不识别」的 bug):
 * 指定一个技能不会收窄目录(其它技能仍在 enabledSkillIds 与 deferred 目录里)。
 * 参考 Hermes:指定技能走「指针」(进 requested,**不内联正文进 system**),强指令由 agentLoop 拼到
 * 尾部 user 消息、正文经 use_skill 取回——故 /skill 不改 system 前缀,缓存照常命中。
 * 无网络:fake brain.assets 经 configureTangu 注入。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { loadSkillLoadout } from '../src/services/skillLoadout.js';

const profile = createTanguProfile({ sandboxMode: 'none' });
const hostStub: any = new Proxy({}, { get: () => () => { throw new Error('host stub'); } });

const CATALOG = [
  { id: 'local:foo', name: 'Foo', description: 'foo skill', content: 'FOO BODY' },
  { id: 'local:bar', name: 'Bar', description: 'bar skill', content: 'BAR BODY' },
  { id: 'local:baz', name: 'Baz', description: 'baz skill', content: 'BAZ BODY' },
];

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'tangu-skill-'));
  process.env.TANGU_HOME = home;
  const assets: any = {
    listSkills: async () => CATALOG.map(({ id, name, description }) => ({ id, name, description })),
    getSkill: async (id: string) => CATALOG.find((s) => s.id === id) || null,
  };
  // materializeSkill 经 cloudStorageService(host)写盘——本测无 host,故其 promise 会 reject,
  // 但 skillLoadout 内 `void materializeSkill(...).catch(()=>{})` 已吞掉,返回值不受影响。
  configureTangu({ host: hostStub, brain: { assets } as any, billing: {} as any, profile, state: {} as any });
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe('loadSkillLoadout — requestedSkillIds 加性(指针,不内联正文进 system)', () => {
  it('host 默认(无显式技能):全部本地技能进 deferred 目录,无 requested', async () => {
    const { enabledSkillIds, sections, requested } = await loadSkillLoadout('u', 'tangu', { execMode: 'host' });
    expect([...enabledSkillIds].sort()).toEqual(['local:bar', 'local:baz', 'local:foo']);
    expect(sections.join('\n')).toContain('Available Skills');
    expect(requested).toEqual([]);
  });

  it('指定 foo:不收窄目录;foo 进 requested(指针),正文不进 system;bar/baz 仍在 deferred', async () => {
    const { enabledSkillIds, sections, requested } = await loadSkillLoadout('u', 'tangu', {
      execMode: 'host',
      requestedSkillIds: ['local:foo'],
    });
    // 其它技能没被收窄掉:全部仍在可用集
    expect([...enabledSkillIds].sort()).toEqual(['local:bar', 'local:baz', 'local:foo']);
    // foo 走指针(requested),不再内联正文进 system(正文由 use_skill 取回、落尾部)
    expect(requested.map((r) => r.id)).toEqual(['local:foo']);
    const text = sections.join('\n');
    expect(text).not.toContain('FOO BODY');         // 不再内联正文进 system
    expect(text).not.toContain('用户本轮指定技能');   // 强指令改由 agentLoop 拼到尾部 user 消息
    expect(text).toContain('Available Skills');      // 其余技能仍在 deferred 目录
    expect(text).toContain('local:bar');
    expect(text).toContain('local:baz');
    expect(text).not.toContain('local:foo');         // foo 已从 deferred 摘除(避免与尾部指令重复)
  });

  it('cloud 会话(无默认目录):requestedSkillIds 仍并入可用集 + 进 requested(指针),不内联正文', async () => {
    const { enabledSkillIds, sections, requested } = await loadSkillLoadout('u', 'tangu', {
      execMode: 'sandbox',
      requestedSkillIds: ['local:foo'],
    });
    expect(enabledSkillIds).toContain('local:foo');
    expect(requested.map((r) => r.id)).toEqual(['local:foo']);
    expect(sections.join('\n')).not.toContain('FOO BODY');
  });
});

describe('loadSkillLoadout — 技能段不因单轮配置不完整而消失(host 兜底)', () => {
  it('execMode 缺失(未回填)→ 仍兜底列出全部本地技能(修「装完技能本轮技能段消失」)', async () => {
    const { enabledSkillIds, sections } = await loadSkillLoadout('u', 'tangu', {});
    expect([...enabledSkillIds].sort()).toEqual(['local:bar', 'local:baz', 'local:foo']);
    expect(sections.join('\n')).toContain('Available Skills');
  });

  it('enabledSkillIds 为空数组 → 按「未配置」处理,host 仍列全部(空列表不再清空技能段)', async () => {
    const { enabledSkillIds, sections } = await loadSkillLoadout('u', 'tangu', { execMode: 'host', enabledSkillIds: [] });
    expect([...enabledSkillIds].sort()).toEqual(['local:bar', 'local:baz', 'local:foo']);
    expect(sections.join('\n')).toContain('Available Skills');
  });

  it('云端沙箱(sandbox)无显式技能 → 不在此列本地技能段(仍走云端技能)', async () => {
    const { sections } = await loadSkillLoadout('u', 'tangu', { execMode: 'sandbox' });
    expect(sections.join('\n')).not.toContain('Available Skills');
  });

  it('显式非空 enabledSkillIds 仍精确生效(只列点名的)', async () => {
    const { enabledSkillIds } = await loadSkillLoadout('u', 'tangu', { execMode: 'host', enabledSkillIds: ['local:foo'] });
    expect(enabledSkillIds).toEqual(['local:foo']);
  });
});
