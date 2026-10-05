/**
 * use_skill 带上技能文件夹,以及随包的 skill-creator 与 manage_skill 的衔接(10-05)。
 * 钉的病理:
 *   ① use_skill 只回正文 —— 带脚本 / 资料的技能(skill-creator、forsion-plugin、模型自建的)正文里写的 scripts/ references/
 *      相对路径无处可找。本机会话里装载本地技能时把文件夹告诉模型;云端技能没有文件夹、沙箱会话够不着这个路径,都不给。
 *   ② skill-creator 是通用版(写给 Claude Code),不提 manage_skill、不提技能存在哪 —— 模型照它做会手写文件夹、打 .skill 包。
 *      开头的「In Forsion」一节把它接到本引擎上;它点名的工具必须是真工具名(改名时这里红),manage_skill 的描述也要指回它。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';
import { getLocalSkill, builtinSkillsDir } from '../../skills/localSkills.js';
import { getToolDefinitions, listDeferredTools } from '../registry.js';
import { skillsProvider } from './skills.js';
import { manageSkillProvider } from './manageSkill.js';

const useSkill = skillsProvider.tools().find((t) => t.name === 'use_skill')!;
const manage = manageSkillProvider.tools()[0];
const profile = createTanguProfile({ sandboxMode: 'none' });
const stub: any = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
const CLOUD = { id: 'cloud-1', name: 'Cloud one', description: 'd', content: 'cloud body' };

let home: string;
const load = (id: string, ctx: Record<string, unknown> = {}) =>
  useSkill.execute({ skill_id: id }, { userId: 'u1', sessionId: 's1', appId: 'tangu', execMode: 'host', enabledSkillIds: [id], ...ctx } as any) as Promise<string>;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-useskill-'));
  process.env.TANGU_HOME = home;
  const brain: any = { assets: { getSkill: async (id: string) => (id.startsWith('local:') ? getLocalSkill(id) : id === CLOUD.id ? CLOUD : null) } };
  configureTangu({ host: stub, brain, billing: stub, profile } as any);
  await manage.execute({ action: 'create', name: 'Ship Web', description: 'how to ship', instructions: 'Run scripts/ship.sh from the skill folder.' }, {} as any);
  await fs.mkdir(path.join(home, 'skills', 'ship-web', 'scripts'), { recursive: true });
  await fs.writeFile(path.join(home, 'skills', 'ship-web', 'scripts', 'ship.sh'), 'echo ship\n');
});
afterAll(async () => {
  delete process.env.TANGU_HOME;
  await fs.rm(home, { recursive: true, force: true });
});

describe('use_skill:技能文件夹', () => {
  it('本机会话装载本地技能:正文之前写着它的文件夹', async () => {
    const out = await load('local:ship-web');
    const dir = path.join(home, 'skills', 'ship-web');
    expect(out).toContain(`Skill folder: ${dir}\n`);
    expect(out.indexOf('Skill folder:')).toBeLessThan(out.indexOf('Run scripts/ship.sh'));
    expect(out.startsWith('# Skill: Ship Web\n')).toBe(true);
  });

  // 目录里写的是 `local:ship-web`,模型有时只传 `ship-web`(10-05 真模型实测:装载 skill-creator 因此落空)
  it('本地技能的 id 没带 local: 前缀也认;准许清单里没有的照样拒', async () => {
    const bare = await useSkill.execute({ skill_id: 'ship-web' }, { userId: 'u1', sessionId: 's1', appId: 'tangu', execMode: 'host', enabledSkillIds: ['local:ship-web'] } as any);
    expect(bare).toContain('# Skill: Ship Web');
    expect(bare).toContain('Run scripts/ship.sh');
    const denied = await useSkill.execute({ skill_id: 'ship-web' }, { userId: 'u1', sessionId: 's1', appId: 'tangu', execMode: 'host', enabledSkillIds: ['local:other'] } as any);
    expect(denied).toBe('Skill "ship-web" is not available in this session.');
  });

  it('沙箱会话 / 云端技能:不给(那个路径够不着 / 根本没有文件夹)', async () => {
    expect(await load('local:ship-web', { execMode: 'sandbox' })).not.toContain('Skill folder:');
    const cloud = await load(CLOUD.id);
    expect(cloud).toContain('cloud body');
    expect(cloud).not.toContain('Skill folder:');
  });

  it('包内置技能:文件夹指家目录里那份镜像,不是应用包里的原件', async () => {
    const out = await load('local:skill-creator');
    expect(out).toContain(`Skill folder: ${path.join(home, 'skills', 'skill-creator')}\n`);
    expect(out).not.toContain(path.join(builtinSkillsDir(), 'skill-creator'));
    // 镜像里真有正文点名的那些文件
    for (const rel of ['scripts/quick_validate.py', 'agents/grader.md', 'references/schemas.md']) {
      await expect(fs.access(path.join(home, 'skills', 'skill-creator', rel))).resolves.toBeUndefined();
    }
  });
});

describe('skill-creator ↔ manage_skill', () => {
  it('skill-creator 开头就讲在 Forsion 里怎么存;它点名的工具都是真工具名', async () => {
    const out = await load('local:skill-creator');
    const at = out.indexOf('## In Forsion');
    expect(at).toBeGreaterThan(0);
    expect(at).toBeLessThan(out.indexOf('## Communicating with the user')); // 在通用正文之前
    const section = out.slice(at, out.indexOf('## Communicating with the user'));
    expect(section).toContain('added by Forsion'); // Apache-2.0 §4(b):改过的文件要写明改了
    const ctx: any = { userId: 'u1', sessionId: 's1', appId: 'tangu', profile, execMode: 'host', cwd: home, enabledSkillIds: ['local:x'] }; // use_skill 只在有技能可装时出现
    const real = new Set([
      ...getToolDefinitions({ ...ctx, unlockTools: () => {} }).map((t: any) => t.function?.name),
      ...listDeferredTools(ctx).map((d) => d.name),
    ]);
    const named = ['manage_skill', 'load_tools', 'use_skill', 'delegate'];
    for (const n of named) {
      expect(section, `「In Forsion」一节应提到 ${n}`).toContain(`\`${n}\``);
      expect(real.has(n), `${n} 不是引擎里的工具名(改名了?)`).toBe(true);
    }
    // 保存走哪条路(只提到工具名不够:这句没了,模型又回去手写文件夹)
    expect(section).toContain('use the `manage_skill` tool; do not hand-write the skill folder');
    // 它叫模型别做的那几件事
    for (const s of ['.skill', '/tmp', 'quick_validate.py', '.tangu/skills/']) expect(section).toContain(s);
  });

  it('manage_skill 的描述指回 skill-creator(复杂场合先装载它),并说明带文件的技能放哪', () => {
    const d = (manage.definition as any).function.description as string;
    expect(d).toContain('local:skill-creator');
    expect(d).toContain('skill folder this tool returns');
  });
});
