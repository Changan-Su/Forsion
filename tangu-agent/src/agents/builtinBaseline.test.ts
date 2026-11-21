/** 内置指令基线(builtinBaseline.ts):升级不盖用户改过的 Coding / Muse 指令。
 *  四种情况(没改过换新、改过保留并提示、没有基线的老用户、读失败不覆盖)各走真磁盘:每个场景一个新 TANGU_HOME +
 *  resetModules(ensureAgentsReady 按模块记忆化)。每条先断言磁盘(旧代码在这一步就红),再断言新接口。 */
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { promises as fs, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { CODING_AGENT_VERSION, CODING_SYSTEM_PROMPT, CODING_SOUL } from './codingPrompt.js';
import { DEFAULT_MUSE_PROMPT } from '../services/specialAgentsConfig.js';
import { LEGACY_MUSE_PROMPTS } from './legacyPersonas.js';
import {
  BUILTIN_BASELINE_FILE, isStockText, planBuiltinRefresh, pendingBuiltinUpdate, readBuiltinBaseline, readBuiltinCurrent, textSha256,
  type BuiltinDefaults,
} from './builtinBaseline.js';
import { validAgentFilePath, agentContentSyncable } from '../contracts/agentSyncRules.js';

const OLD_DEFAULT = 'You are Coding (old built-in default). Build small web apps.';
const OLD_SOUL = '# Coding\n\nOld built-in persona.';
const USER_ADDITION = '\n\nAlways answer in Chinese and keep a CHANGELOG.md in the project root.';

let home: string;
const dir = (slug: string): string => path.join(home, 'agents', slug);
const cfgFile = (slug: string): string => path.join(dir(slug), 'config.toml');
const soulFile = (slug: string): string => path.join(dir(slug), 'SOUL.md');
const baseFile = (slug: string): string => path.join(dir(slug), BUILTIN_BASELINE_FILE);
/** 老 config.toml(和 serializeAgentConfig 一样把多行指令写成 ''' 字面串)。 */
const toml = (o: { version: string; prompt: string; description?: string; extra?: string }): string =>
  `name = "Coding"\nname_en = "Coding"\nversion = "${o.version}"\n${o.description !== undefined ? `description = ${JSON.stringify(o.description)}\n` : ''}model = "user-picked-model"\napproval_mode = "readonly"\n${o.extra || ''}created_by = "user"\ncreated_at = "2026-09-01T00:00:00.000Z"\ndeveloper_instructions = '''\n${o.prompt}'''\n`;
const baselineJson = (fields: Record<string, { text: string; version?: string }>): string => JSON.stringify({ format: 1, ...fields });

/** 已有安装:几个出厂 Agent 都在,标记都写过(只让 Coding / Muse 走升级那一条)。 */
function seedInstall(): void {
  for (const slug of ['xyra', 'aria', 'recita', 'coding', 'muse']) mkdirSync(path.join(dir(slug), 'Library'), { recursive: true });
  for (const m of ['.seeded', '.seeded-personas-v1', '.seeded-dsh-v1', '.effort-medium-v1', '.agent-names-v1']) writeFileSync(path.join(home, 'agents', m), 'old');
}
async function registry() {
  vi.resetModules();
  return import('./agentRegistry.js');
}

// 冷导入引擎模块图要好几秒(机器忙时超过缺省 5 秒);先导一次,后面 resetModules 后重导只付求值的钱
beforeAll(async () => { await import('./agentRegistry.js'); }, 120_000);
beforeEach(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-baseline-'));
  process.env.TANGU_HOME = home;
  seedInstall();
});
afterEach(async () => {
  await fs.rm(home, { recursive: true, force: true });
  delete process.env.TANGU_HOME;
});

vi.setConfig({ testTimeout: 30_000 });

describe('① 没改过 → 直接换新,基线跟上', () => {
  it('Coding:文本 == 基线(旧默认)→ 指令、人格、描述、版本都换成现行,模型 / 权限不动', async () => {
    writeFileSync(cfgFile('coding'), toml({ version: '1.3.0', prompt: OLD_DEFAULT, description: 'Old description' }));
    writeFileSync(soulFile('coding'), OLD_SOUL);
    writeFileSync(baseFile('coding'), baselineJson({ systemPrompt: { text: OLD_DEFAULT, version: '1.3.0' }, soul: { text: OLD_SOUL, version: '1.3.0' }, description: { text: 'Old description', version: '1.3.0' } }));
    const r = await registry();
    const coding = (await r.listAgents()).find((a) => a.slug === 'coding')!;
    expect(coding.systemPrompt).toBe(CODING_SYSTEM_PROMPT);
    expect(readFileSync(soulFile('coding'), 'utf-8')).toBe(CODING_SOUL);
    expect(coding.version).toBe(CODING_AGENT_VERSION);
    expect(coding.description).not.toBe('Old description');
    expect(coding.model).toBe('user-picked-model');
    expect(coding.approvalMode).toBe('readonly');
    const base = JSON.parse(readFileSync(baseFile('coding'), 'utf-8'));
    expect(base.systemPrompt).toEqual({ text: CODING_SYSTEM_PROMPT, version: CODING_AGENT_VERSION });
    expect(base.soul.text).toBe(CODING_SOUL);
    expect(await r.getBuiltinUpdate('coding')).toBeNull();
  });

  it('Muse(没有版本号):指令 == 基线 → 换成现行预设;旧代码只认三版原装,这一版会原样留着', async () => {
    const oldMuse = 'You are Muse (a previous default that is not in the legacy list).';
    writeFileSync(cfgFile('muse'), `name = "Muse"\nversion = "1.0.0"\ncreated_by = "system"\nmodel = "m"\ndeveloper_instructions = ${JSON.stringify(oldMuse)}\n`);
    writeFileSync(soulFile('muse'), 'x');
    writeFileSync(baseFile('muse'), baselineJson({ systemPrompt: { text: oldMuse } }));
    const r = await registry();
    await r.ensureMuseAgent();
    const def = await r.parseAgentFolder('muse', dir('muse'));
    expect(def.systemPrompt).toBe(DEFAULT_MUSE_PROMPT);
    expect(def.model).toBe('m');
    expect(def.createdBy).toBe('system');
    expect(readFileSync(soulFile('muse'), 'utf-8')).toBe('x'); // 人格没有基线、也不是出厂文本 = 改过,不碰
  });

  it('新装机:骨架写下出厂文本时就记基线,马上升级也不提示', async () => {
    await fs.rm(path.join(home, 'agents'), { recursive: true, force: true });
    const r = await registry();
    await r.listAgents();
    for (const slug of ['coding', 'muse']) {
      const read = await readBuiltinBaseline(dir(slug));
      expect(read.state).toBe('ok');
      if (read.state === 'ok') expect(Object.keys(read.baseline).sort()).toEqual(['description', 'soul', 'systemPrompt']);
      expect(await r.getBuiltinUpdate(slug)).toBeNull();
    }
    expect(JSON.parse(readFileSync(baseFile('coding'), 'utf-8')).systemPrompt.text).toBe(CODING_SYSTEM_PROMPT);
  });

  it('Muse 首次播种带旧自定义(legacyPrompt):config 里是用户的字,基线仍记出厂文本 —— 下次升级不会把它当没改过', async () => {
    await fs.rm(dir('muse'), { recursive: true, force: true });
    const r = await registry();
    await r.ensureMuseAgent('My own Muse prompt from the old settings.');
    expect((await r.parseAgentFolder('muse', dir('muse'))).systemPrompt).toBe('My own Muse prompt from the old settings.');
    expect(JSON.parse(readFileSync(baseFile('muse'), 'utf-8')).systemPrompt.text).toBe(DEFAULT_MUSE_PROMPT);
    expect(await r.getBuiltinUpdate('muse')).toBeNull(); // 基线 == 现行默认:没有新版本可提示
  });
});

describe('② 改过 → 保留用户的文本,配置页提示新旧默认的差异', () => {
  const setup = (): void => {
    writeFileSync(cfgFile('coding'), toml({ version: '1.3.0', prompt: OLD_DEFAULT + USER_ADDITION, description: 'My coding buddy' }));
    writeFileSync(soulFile('coding'), OLD_SOUL);
    writeFileSync(baseFile('coding'), baselineJson({ systemPrompt: { text: OLD_DEFAULT, version: '1.3.0' }, soul: { text: OLD_SOUL, version: '1.3.0' }, description: { text: 'Old description', version: '1.3.0' } }));
  };

  it('升级一个字节都不写用户改过的指令;人格没改过照常换新;提示带旧默认 → 新默认', async () => {
    setup();
    const before = readFileSync(cfgFile('coding'), 'utf-8');
    const r = await registry();
    await r.listAgents();
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toBe(before); // 旧代码在这一步就把用户加的那段盖掉了
    expect(readFileSync(soulFile('coding'), 'utf-8')).toBe(CODING_SOUL);
    const update = await r.getBuiltinUpdate('coding');
    expect(update?.fields).toEqual([{ field: 'systemPrompt', current: OLD_DEFAULT + USER_ADDITION, newDefault: CODING_SYSTEM_PROMPT, oldDefault: OLD_DEFAULT, fromVersion: '1.3.0' }]);
    expect(update?.toVersion).toBe(CODING_AGENT_VERSION);
  });

  it('保留我的:只把基线记成新默认,文本不动,提示消失', async () => {
    setup();
    const r = await registry();
    const update = (await r.getBuiltinUpdate('coding'))!;
    const before = readFileSync(cfgFile('coding'), 'utf-8');
    const agent = await r.resolveBuiltinUpdate('coding', 'keep', update.token);
    expect(agent?.systemPrompt).toBe(OLD_DEFAULT + USER_ADDITION);
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toBe(before); // 版本号也不升:config.toml 会同步,旧版设备见到版本变了会整份盖掉
    expect(JSON.parse(readFileSync(baseFile('coding'), 'utf-8')).systemPrompt.text).toBe(CODING_SYSTEM_PROMPT);
    expect(await r.getBuiltinUpdate('coding')).toBeNull();
    // 再起一次进程:用户的文本照旧
    const r2 = await registry();
    expect((await r2.listAgents()).find((a) => a.slug === 'coding')!.systemPrompt).toBe(OLD_DEFAULT + USER_ADDITION);
  });

  it('换成新默认:指令换新、版本跟上,其余配置不动;过时的 token 被拒、什么都不写', async () => {
    setup();
    const r = await registry();
    const update = (await r.getBuiltinUpdate('coding'))!;
    await expect(r.resolveBuiltinUpdate('coding', 'adopt', 'stale-token')).rejects.toBeInstanceOf(r.BuiltinUpdateStaleError);
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toContain(USER_ADDITION.trim());
    const agent = await r.resolveBuiltinUpdate('coding', 'adopt', update.token);
    expect(agent?.systemPrompt).toBe(CODING_SYSTEM_PROMPT);
    expect(agent?.version).toBe(CODING_AGENT_VERSION);
    expect(agent?.model).toBe('user-picked-model');
    expect(agent?.description).toBe('My coding buddy');
    expect(await r.getBuiltinUpdate('coding')).toBeNull();
  });

  it('看过之后用户又改了文本(另一个窗口):token 对不上 → 409,不换', async () => {
    setup();
    const r = await registry();
    const update = (await r.getBuiltinUpdate('coding'))!;
    writeFileSync(cfgFile('coding'), toml({ version: '1.3.0', prompt: OLD_DEFAULT + USER_ADDITION + '\nOne more rule.', description: 'My coding buddy' }));
    await expect(r.resolveBuiltinUpdate('coding', 'adopt', update.token)).rejects.toBeInstanceOf(r.BuiltinUpdateStaleError);
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toContain('One more rule.');
  });
});

describe('③ 没有基线的老用户', () => {
  it('版本落后、文本不是任何一版出厂 → 当改过:保留,提示比「你的版本 vs 新默认」(没有旧默认可比)', async () => {
    writeFileSync(cfgFile('coding'), toml({ version: '1.1.0', prompt: 'OLD_PROMPT_SENTINEL', description: 'Old description' }));
    writeFileSync(soulFile('coding'), CODING_SOUL);
    const before = readFileSync(cfgFile('coding'), 'utf-8');
    const r = await registry();
    await r.listAgents();
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toBe(before);
    const update = await r.getBuiltinUpdate('coding');
    expect(update?.fields).toEqual([{ field: 'systemPrompt', current: 'OLD_PROMPT_SENTINEL', newDefault: CODING_SYSTEM_PROMPT, oldDefault: null }]);
  });

  it('版本就是现行版本、文本改过 → 用户是在现行默认上改的:静默补基线,不提示,不写文本', async () => {
    writeFileSync(cfgFile('coding'), toml({ version: CODING_AGENT_VERSION, prompt: CODING_SYSTEM_PROMPT + USER_ADDITION, description: 'Mine' }));
    writeFileSync(soulFile('coding'), CODING_SOUL);
    const before = readFileSync(cfgFile('coding'), 'utf-8');
    const r = await registry();
    await r.listAgents();
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toBe(before);
    expect(JSON.parse(readFileSync(baseFile('coding'), 'utf-8')).systemPrompt.text).toBe(CODING_SYSTEM_PROMPT);
    expect(await r.getBuiltinUpdate('coding')).toBeNull();
  });

  it('文本就是某一版出厂(指纹表)→ 没改过,换新:没有基线也不让老用户卡在旧指令上', () => {
    const defaults: BuiltinDefaults = { version: '9.0.0', systemPrompt: 'NEXT DEFAULT', soul: 'NEXT SOUL', description: 'NEXT' };
    const plan = planBuiltinRefresh('coding', defaults, { version: CODING_AGENT_VERSION, systemPrompt: CODING_SYSTEM_PROMPT, soul: CODING_SOUL, description: 'Mine' }, null)!;
    expect(plan.replace).toEqual({ systemPrompt: 'NEXT DEFAULT', soul: 'NEXT SOUL' });
    expect(plan.version).toBe('9.0.0');
    expect(plan.baseline?.systemPrompt?.text).toBe('NEXT DEFAULT');
    expect(plan.baseline?.description).toBeUndefined(); // 描述改过、没基线、版本落后:不动也不补
    // Muse:写这张表时的现行默认、三版原装都算出厂
    for (const t of [DEFAULT_MUSE_PROMPT, ...LEGACY_MUSE_PROMPTS]) expect(isStockText('muse', 'systemPrompt', t)).toBe(true);
    expect(isStockText('muse', 'systemPrompt', `${DEFAULT_MUSE_PROMPT} Also water the plants.`)).toBe(false);
  });

  it('指纹表经真管道核对:骨架写盘 → 严格读 → 规范化后的哈希就是表里那条(对不上 = 所有没改过的老用户都会被判成改过)', async () => {
    await fs.rm(path.join(home, 'agents'), { recursive: true, force: true });
    const r = await registry();
    await r.listAgents();
    const coding = await readBuiltinCurrent(dir('coding'));
    const muse = await readBuiltinCurrent(dir('muse'));
    expect(coding.state === 'ok' && muse.state === 'ok').toBe(true);
    if (coding.state !== 'ok' || muse.state !== 'ok') return;
    expect(isStockText('coding', 'systemPrompt', coding.current.systemPrompt)).toBe(true);
    expect(isStockText('coding', 'soul', coding.current.soul!)).toBe(true);
    expect(textSha256(coding.current.systemPrompt)).toBe(textSha256(CODING_SYSTEM_PROMPT));
    expect(isStockText('muse', 'systemPrompt', muse.current.systemPrompt)).toBe(true);
    expect(isStockText('muse', 'soul', muse.current.soul!)).toBe(true);
  });
});

describe('④ 读失败不覆盖', () => {
  const stale = (): void => {
    writeFileSync(cfgFile('coding'), toml({ version: '1.3.0', prompt: OLD_DEFAULT }));
    writeFileSync(soulFile('coding'), OLD_SOUL);
  };

  it('基线坏了(半份 JSON):不知道 → 文本是旧默认也不换,基线不重写,不提示', async () => {
    stale();
    writeFileSync(baseFile('coding'), '{"format":1,"systemPrompt":{"text":"You are Cod');
    const cfg = readFileSync(cfgFile('coding'), 'utf-8');
    const r = await registry();
    await r.listAgents();
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toBe(cfg);
    expect(readFileSync(soulFile('coding'), 'utf-8')).toBe(OLD_SOUL);
    expect(readFileSync(baseFile('coding'), 'utf-8')).toBe('{"format":1,"systemPrompt":{"text":"You are Cod');
    expect(await r.getBuiltinUpdate('coding')).toBeNull();
  });

  it('基线读不出来(是个目录):同上,一个字节都不写', async () => {
    stale();
    mkdirSync(baseFile('coding'));
    const cfg = readFileSync(cfgFile('coding'), 'utf-8');
    const r = await registry();
    await r.listAgents();
    expect(readFileSync(cfgFile('coding'), 'utf-8')).toBe(cfg);
    expect(readFileSync(soulFile('coding'), 'utf-8')).toBe(OLD_SOUL);
  });

  it('config.toml 零字节 / 解析不了:不当成「指令为空」,不写回出厂', async () => {
    for (const broken of ['', 'name = "Coding"\ndeveloper_instructions = """unterminated\n']) {
      writeFileSync(cfgFile('coding'), broken);
      writeFileSync(soulFile('coding'), OLD_SOUL);
      writeFileSync(baseFile('coding'), baselineJson({ systemPrompt: { text: OLD_DEFAULT }, soul: { text: OLD_SOUL } }));
      const r = await registry();
      await r.listAgents();
      expect(readFileSync(cfgFile('coding'), 'utf-8')).toBe(broken); // 旧代码:解析失败 → 空表 → 照写一份出厂(用户的配置全丢)
      expect(readFileSync(soulFile('coding'), 'utf-8')).toBe(OLD_SOUL);
      expect(await r.getBuiltinUpdate('coding')).toBeNull();
    }
  });

  it('SOUL.md 读不出来:人格这一项不碰,指令照常判', async () => {
    writeFileSync(cfgFile('coding'), toml({ version: '1.3.0', prompt: OLD_DEFAULT }));
    mkdirSync(soulFile('coding'));
    writeFileSync(baseFile('coding'), baselineJson({ systemPrompt: { text: OLD_DEFAULT }, soul: { text: OLD_SOUL } }));
    const r = await registry();
    await r.listAgents();
    expect((await r.parseAgentFolder('coding', dir('coding'))).systemPrompt).toBe(CODING_SYSTEM_PROMPT);
    expect(existsSync(soulFile('coding')) && (await fs.stat(soulFile('coding'))).isDirectory()).toBe(true);
    expect(JSON.parse(readFileSync(baseFile('coding'), 'utf-8')).soul.text).toBe(OLD_SOUL);
  });
});

describe('同步边界与版本', () => {
  it('基线(和它的临时文件)两套同步都不收', () => {
    for (const p of [BUILTIN_BASELINE_FILE, '.builtin-baseline.123.abcd1234.tmp']) {
      expect(validAgentFilePath(p)).toBe(false);
      expect(agentContentSyncable(`agents/coding/${p}`)).toBe(false);
    }
  });

  it('config.toml 来自更新的 app(另一台同步过来的):不退回旧默认,也不提示', () => {
    const defaults: BuiltinDefaults = { version: '1.4.0', systemPrompt: 'P4', soul: 'S', description: 'D' };
    const current = { version: '1.5.0', systemPrompt: 'P5', soul: 'S5', description: 'D5' };
    expect(planBuiltinRefresh('coding', defaults, current, { systemPrompt: { text: 'P5', version: '1.5.0' } })).toBeNull();
    expect(pendingBuiltinUpdate('coding', defaults, current, null)).toBeNull();
  });
});
