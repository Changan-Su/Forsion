/** Agent 双语名字:解析、写盘白名单、改名归位、一次性迁移、Identity。
 *  独立文件(自己的 TANGU_HOME):ensureAgentsReady 进程内只跑一次,迁移要在它之前摆好旧文件。 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildAgentDef, builtinAgentDef, deleteAgentAvatar, getAgent, listAgents, parseAgentConfig, patchAgent, saveAgent, saveAgentAvatar,
  serializeAgentConfig, slugFromNames, migrateAgentNamesOnce,
} from '../src/agents/agentRegistry.js';
import { agentIdentitySection } from '../src/services/agentActivation.js';
import { parseMentions } from '../src/services/groupChat.js';
import { buildAgentRoster } from '../src/services/agentRoster.js';
import { CODING_AGENT_VERSION } from '../src/agents/codingPrompt.js';

const toml = (name: string, extra = ''): string => `name = "${name}"\ndeveloper_instructions = "p"\n${extra}`;
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64');

describe('解析:只有 name 的旧定义按迁移表现算', () => {
  it.each([['xyra', 'Arioso', '行香子', 'Arioso'], ['xyra', 'Tangu Arioso', '行香子', 'Arioso'], ['recita', 'Recita', '临江仙', 'Recita'], ['aria', 'Aria', '浣溪沙', 'Aria'], ['muse', 'Muse', '卜算子', 'Muse'], ['coding', 'Coding', '', 'Coding']])('%s 没改过(%s)', (slug, name, nameZh, nameEn) => {
    expect(parseAgentConfig(slug, toml(name), '')).toMatchObject({ name, nameZh, nameEn });
  });
  it('内置改过名:用户起的进中文名,英文名用缺省', () => {
    expect(parseAgentConfig('aria', toml('小雅'), '')).toMatchObject({ name: '小雅', nameZh: '小雅', nameEn: 'Aria' });
    expect(parseAgentConfig('coding', toml('码农'), '')).toMatchObject({ nameZh: '码农', nameEn: 'Coding' });
  });
  it('自己建的:原名进中文名,英文名留空', () => {
    expect(parseAgentConfig('helper', toml('Helper'), '')).toMatchObject({ nameZh: 'Helper', nameEn: '' });
  });
  it('有一个名字在场就是新格式,不再套迁移表', () => {
    expect(parseAgentConfig('aria', `name_en = "Aria"\n${toml('Aria')}`, '')).toMatchObject({ nameZh: '', nameEn: 'Aria' });
  });
  it('虚拟内置 Agent 带两个名字', () => {
    expect(builtinAgentDef('xyra')).toMatchObject({ name: 'Arioso', nameZh: '行香子', nameEn: 'Arioso' });
  });
});

describe('写盘白名单', () => {
  it('三个字段往返不丢,auto 不落盘', () => {
    const def = buildAgentDef('x', null, { name: '', nameZh: '夜猫', nameEn: 'Owl', namePref: 'en', systemPrompt: 'p' });
    const text = serializeAgentConfig(def);
    expect(text).toContain('name_pref = "en"');
    expect(parseAgentConfig('x', text, '')).toMatchObject({ name: 'Owl', nameZh: '夜猫', nameEn: 'Owl', namePref: 'en' });
    const auto = serializeAgentConfig(buildAgentDef('x', def, { name: 'Owl', namePref: 'auto', systemPrompt: 'p' }));
    expect(auto).not.toContain('name_pref');
  });
});

describe('算名字', () => {
  const base = buildAgentDef('x', null, { name: 'Owl', nameZh: '夜猫', nameEn: 'Owl', systemPrompt: 'p' });
  const again = (patch: object) => buildAgentDef('x', base, { name: base.name, systemPrompt: 'p', ...patch });
  it('至少一个名字', () => {
    expect(() => buildAgentDef('x', null, { name: ' ', nameZh: '', systemPrompt: 'p' })).toThrow('name required');
    expect(() => again({ name: '', nameZh: '', nameEn: '' })).toThrow('name required');
  });
  it('英文名不许有汉字;磁盘上手写的旧值不让别的保存失败', () => {
    expect(() => again({ nameEn: 'Owl 猫' })).toThrow('name_en');
    const hand = parseAgentConfig('x', `name_en = "猫"\n${toml('猫')}`, '');
    expect(buildAgentDef('x', hand, { name: '猫', systemPrompt: 'p', avatar: 'a.png' }).nameEn).toBe('猫');
  });
  it('两个名字都可以是同一个字符串', () => {
    expect(buildAgentDef('x', null, { name: '', nameZh: 'Coding', nameEn: 'Coding', systemPrompt: 'p' })).toMatchObject({ nameZh: 'Coding', nameEn: 'Coding' });
  });
  it('固定偏好决定 name;跟随界面时认客户端报的显示名', () => {
    expect(again({ namePref: 'zh' }).name).toBe('夜猫');
    expect(again({ namePref: 'en' }).name).toBe('Owl');
    expect(again({ name: '夜猫' }).name).toBe('夜猫');
  });
  it('只给 name:是任一名字 = 切显示,不是改名(英文界面的老客户端原样存回)', () => {
    expect(again({ name: '夜猫' })).toMatchObject({ nameZh: '夜猫', nameEn: 'Owl' });
  });
  it('只给 name 且是新名字:改现在显示的那一格', () => {
    expect(again({ name: 'Hawk' })).toMatchObject({ name: 'Hawk', nameZh: '夜猫', nameEn: 'Hawk' });
    expect(again({ name: '老鹰' })).toMatchObject({ name: '老鹰', nameZh: '老鹰', nameEn: 'Owl' }); // 英文格放不下汉字
    const zh = buildAgentDef('x', base, { name: '夜猫', systemPrompt: 'p' });
    expect(buildAgentDef('x', zh, { name: 'Hawk', systemPrompt: 'p' })).toMatchObject({ name: 'Hawk', nameZh: 'Hawk', nameEn: 'Owl' });
  });
  it('两格同名:一起改;新名字有汉字只改中文名', () => {
    const same = buildAgentDef('x', null, { name: 'Alex', nameZh: 'Alex', nameEn: 'Alex', namePref: 'zh', systemPrompt: 'p' });
    expect(buildAgentDef('x', same, { name: 'Bob', systemPrompt: 'p' })).toMatchObject({ name: 'Bob', nameZh: 'Bob', nameEn: 'Bob' });
    expect(buildAgentDef('x', same, { name: '阿明', systemPrompt: 'p' })).toMatchObject({ name: '阿明', nameZh: '阿明', nameEn: 'Alex' });
  });
  it('改偏好时带的 name 读旧了:不算改名,不盖掉别处刚改的', () => {
    const hawk = buildAgentDef('x', base, { name: 'Hawk', systemPrompt: 'p' });
    expect(buildAgentDef('x', hawk, { name: 'Owl', namePref: 'en', systemPrompt: 'p' })).toMatchObject({ name: 'Hawk', nameEn: 'Hawk', namePref: 'en' });
  });
  it('新建只给 name:进中文名(同迁移)', () => {
    expect(buildAgentDef('x', null, { name: 'Reviewer', systemPrompt: 'p' })).toMatchObject({ nameZh: 'Reviewer', nameEn: '' });
  });
  it('由名字推 id:只认带 ASCII 的,全中文推不出', () => {
    expect(slugFromNames('', 'Night Owl')).toBe('night-owl');
    expect(slugFromNames('Owl', '夜猫')).toBe('owl');
    expect(slugFromNames(undefined, '夜猫')).toBe('');
  });
});

describe('Identity', () => {
  const zhEn = { name: 'Aria', nameZh: '浣溪沙', nameEn: 'Aria', description: '' };
  it('跟随界面:按对话语言选', () => {
    expect(agentIdentitySection(zhEn)).toContain('- Name: 浣溪沙 when the conversation is in Chinese, Aria in any other language');
  });
  it('固定名字:所有语言都用它,另一个也认', () => {
    expect(agentIdentitySection({ ...zhEn, namePref: 'zh' })).toContain('- Name: 浣溪沙, in every language (you also answer to Aria)');
    expect(agentIdentitySection({ ...zhEn, namePref: 'en' })).toContain('- Name: Aria, in every language (you also answer to 浣溪沙)');
  });
  it('只有一个名字 / 两个一样:就写这一个', () => {
    expect(agentIdentitySection({ name: 'Coding', nameEn: 'Coding', description: '' })).toContain('- Name: Coding\n');
    expect(agentIdentitySection({ name: 'Coding', nameZh: 'Coding', nameEn: 'Coding', description: '' })).toContain('- Name: Coding\n');
  });
});

describe('认人', () => {
  const people = [{ slug: 'aria', name: 'Aria', nameZh: '浣溪沙', nameEn: 'Aria' }, { slug: 'recita', name: '临江仙', nameZh: '临江仙', nameEn: 'Recita' }];
  it('@ 任一名字或 slug 都认,插入的是哪个名字都一样', () => {
    expect(parseMentions('@浣溪沙 看看', people, '')).toEqual(['aria']);
    expect(parseMentions('@Aria 看看', people, '')).toEqual(['aria']);
    expect(parseMentions('@aria 看看', people, '')).toEqual(['aria']);
    expect(parseMentions('@Recita 和 @临江仙 同一个', people, '')).toEqual(['recita']);
    expect(parseMentions('@Recita', people, 'recita')).toEqual([]);
  });
});

describe('本地迁移(旧安装升级)', () => {
  let home: string;
  const write = (slug: string, text: string) => {
    mkdirSync(path.join(home, 'agents', slug), { recursive: true });
    writeFileSync(path.join(home, 'agents', slug, 'config.toml'), text);
  };
  const read = (slug: string) => readFileSync(path.join(home, 'agents', slug, 'config.toml'), 'utf-8');

  beforeAll(async () => {
    home = mkdtempSync(path.join(tmpdir(), 'tangu-agent-names-'));
    process.env.TANGU_HOME = home;
    write('xyra', toml('Tangu Arioso', 'version = "1.1.0"\n'));
    write('aria', `# 我的笔记\n${toml('小雅', 'future_key = "keep me"\n')}`);
    write('recita', toml('Recita'));
    write('coding', toml('码农', 'version = "1.0.0"\n'));
    write('broken', 'approval_mode = readonly\nname = "坏"\n');
    write('emptykey', `name_zh = ""\n${toml('Helper')}`);
    write('helper', toml('Helper'));
    await listAgents();
  });
  afterAll(() => {
    delete process.env.TANGU_HOME;
    rmSync(home, { recursive: true, force: true });
  });

  it('写进磁盘:没改过的拿词牌,改过的留用户起的', async () => {
    expect(read('xyra')).toContain('name_zh = "行香子"');
    expect(read('xyra')).toContain('name_en = "Arioso"');
    expect(read('aria')).toContain('name_zh = "小雅"');
    expect(read('aria')).toContain('name_en = "Aria"');
    expect(await getAgent('recita')).toMatchObject({ nameZh: '临江仙', nameEn: 'Recita' });
    expect(read('helper')).toContain('name_zh = "Helper"');
    expect(read('helper')).not.toContain('name_en');
  });
  it('手写的注释和白名单外的键原样留着', () => {
    expect(read('aria')).toContain('# 我的笔记');
    expect(read('aria')).toContain('future_key = "keep me"');
  });
  it('解析不了的文件一个字不动', () => {
    expect(read('broken')).toBe('approval_mode = readonly\nname = "坏"\n');
  });
  it('键在但是空串:不再插一行(重复键 = 整份 TOML 坏掉),读时照样算出名字', async () => {
    expect(read('emptykey').match(/name_zh/g)).toHaveLength(1);
    expect(await getAgent('emptykey')).toMatchObject({ nameZh: 'Helper', systemPrompt: 'p' });
  });
  it('Coding 版本刷新只换提示词,名字留着', async () => {
    const coding = await getAgent('coding');
    expect(coding).toMatchObject({ version: CODING_AGENT_VERSION, name: '码农', nameZh: '码农', nameEn: 'Coding' });
    expect(coding?.systemPrompt).not.toBe('p');
  });
  it('标记之后不再跑:用户清掉中文名不会被补回来', async () => {
    expect(existsSync(path.join(home, 'agents', '.agent-names-v1'))).toBe(true);
    await patchAgent('recita', { nameZh: '' });
    await migrateAgentNamesOnce();
    expect(await getAgent('recita')).toMatchObject({ name: 'Recita', nameZh: '', nameEn: 'Recita' });
  });
  it('只改别的字段、换头像、删头像都不丢名字(写路径都经 buildAgentDef)', async () => {
    await saveAgent({ slug: 'owl', name: '', nameZh: '夜猫', nameEn: 'Owl', namePref: 'en', systemPrompt: 'p' });
    await patchAgent('owl', { description: 'd' });
    await saveAgentAvatar('owl', PNG, 'image/png');
    await deleteAgentAvatar('owl');
    expect(await getAgent('owl')).toMatchObject({ name: 'Owl', nameZh: '夜猫', nameEn: 'Owl', namePref: 'en', description: 'd' });
  });
  it('老版本存过一次、新字段丢了:读时按迁移表补回', async () => {
    write('aria', toml('Aria'));
    expect(await getAgent('aria')).toMatchObject({ nameZh: '浣溪沙', nameEn: 'Aria' });
  });
  it('给模型看的名册带两个名字', async () => {
    expect(await buildAgentRoster('xyra')).toContain('- 浣溪沙 / Aria (slug: `aria`)');
  });
});
