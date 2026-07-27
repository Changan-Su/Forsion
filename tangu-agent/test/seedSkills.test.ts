import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { seedSkillsInto } from '../src/skills/localSkills.js';

// 关键不变量:播种内置技能时绝不覆盖用户已编辑/已导入的同名技能(否则丢用户数据)。
describe('seedSkillsInto', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = path.join(os.tmpdir(), `tangu-seed-${process.pid}-${Date.now()}`);
    await fs.mkdir(tmp, { recursive: true });
  });
  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('copies missing skills but never clobbers an existing (edited) one', async () => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    for (const [name, body] of [['alpha', 'ALPHA orig'], ['beta', 'BETA orig']]) {
      await fs.mkdir(path.join(src, name), { recursive: true });
      await fs.writeFile(path.join(src, name, 'SKILL.md'), body);
    }
    // dest 已有用户改过的 beta
    await fs.mkdir(path.join(dest, 'beta'), { recursive: true });
    await fs.writeFile(path.join(dest, 'beta', 'SKILL.md'), 'BETA edited');

    await seedSkillsInto(src, dest);

    expect(await fs.readFile(path.join(dest, 'alpha', 'SKILL.md'), 'utf8')).toBe('ALPHA orig'); // 缺失 → 复制
    expect(await fs.readFile(path.join(dest, 'beta', 'SKILL.md'), 'utf8')).toBe('BETA edited'); // 已存在 → 保留
  });

  /** 写一棵源技能树,播种一次,返回 (src, dest) 便于后续改动。 */
  const seedOnce = async (name: string, body: string): Promise<{ src: string; dest: string }> => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    await fs.mkdir(path.join(src, name), { recursive: true });
    await fs.writeFile(path.join(src, name, 'SKILL.md'), body);
    await seedSkillsInto(src, dest);
    return { src, dest };
  };

  // 「永不覆盖」曾经写成「目标已存在就跳过」,后果是内置技能的修订**永远传不下去** ——
  // 而查表时用户目录优先,陈年副本一直遮住仓库里已修好的版本(实测差了两个大版本)。
  it('用户没动过的副本跟着内置更新(判据是目录指纹,不是版本号)', async () => {
    const { src, dest } = await seedOnce('alpha', 'v1');
    await fs.writeFile(path.join(src, 'alpha', 'SKILL.md'), 'v2');

    const r = await seedSkillsInto(src, dest);

    expect(r.updated).toEqual(['alpha']);
    expect(r.protectedStale).toEqual([]);
    expect(await fs.readFile(path.join(dest, 'alpha', 'SKILL.md'), 'utf8')).toBe('v2');
  });

  it('源里删掉的文件不会残留在用户那边(整目录替换,不是 merge)', async () => {
    const { src, dest } = await seedOnce('alpha', 'v1');
    await fs.writeFile(path.join(src, 'alpha', 'helper.mjs'), 'x');
    await seedSkillsInto(src, dest);
    expect(await fs.readFile(path.join(dest, 'alpha', 'helper.mjs'), 'utf8')).toBe('x');

    await fs.rm(path.join(src, 'alpha', 'helper.mjs')); // 上游删掉了这个脚本
    await seedSkillsInto(src, dest);

    // merge 语义会把它留在用户机器上,还可能被「枚举 scripts/ 执行」之类的用法捡起来跑。
    await expect(fs.access(path.join(dest, 'alpha', 'helper.mjs'))).rejects.toThrow();
  });

  it('改动只在非 SKILL.md 的文件里也算「用户改过」', async () => {
    const { src, dest } = await seedOnce('alpha', 'v1');
    await fs.writeFile(path.join(dest, 'alpha', 'notes.md'), '我的笔记'); // 只加了个附件
    await fs.writeFile(path.join(src, 'alpha', 'SKILL.md'), 'v2');

    const r = await seedSkillsInto(src, dest);

    // 只哈希 SKILL.md 的话,这次改动看不见 → 用户的 notes.md 被整目录替换吃掉。
    expect(r.protectedStale).toEqual(['alpha']);
    expect(await fs.readFile(path.join(dest, 'alpha', 'notes.md'), 'utf8')).toBe('我的笔记');
  });

  it('没有指纹的老副本一律保护,并且**报出来**(不静默停更)', async () => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    await fs.mkdir(path.join(src, 'alpha'), { recursive: true });
    await fs.writeFile(path.join(src, 'alpha', 'SKILL.md'), 'v2');
    await fs.mkdir(path.join(dest, 'alpha'), { recursive: true });
    await fs.writeFile(path.join(dest, 'alpha', 'SKILL.md'), 'v1'); // 播种早于指纹机制的装机

    const r = await seedSkillsInto(src, dest);

    // 分不清「老副本」与「用户自己写的同名技能」→ 不敢自动覆盖;但必须说出来,否则用户
    // 永远用着陈年版本还不知道。
    expect(r.protectedStale).toEqual(['alpha']);
    expect(await fs.readFile(path.join(dest, 'alpha', 'SKILL.md'), 'utf8')).toBe('v1');
  });

  it('内容逐字节相同的无指纹副本会被补上指纹(老装机唯一安全的自愈口子)', async () => {
    const src = path.join(tmp, 'src');
    const dest = path.join(tmp, 'dest');
    await fs.mkdir(path.join(src, 'alpha'), { recursive: true });
    await fs.writeFile(path.join(src, 'alpha', 'SKILL.md'), 'same');
    await fs.mkdir(path.join(dest, 'alpha'), { recursive: true });
    await fs.writeFile(path.join(dest, 'alpha', 'SKILL.md'), 'same');

    await seedSkillsInto(src, dest); // 补指纹(内容相同,补它吃不掉任何改动)
    await fs.writeFile(path.join(src, 'alpha', 'SKILL.md'), 'next');
    const r = await seedSkillsInto(src, dest);

    expect(r.updated).toEqual(['alpha']); // 于是下一次内置更新就能正常跟上
    expect(await fs.readFile(path.join(dest, 'alpha', 'SKILL.md'), 'utf8')).toBe('next');
  });

  it('missing source dir is a no-op (no throw)', async () => {
    // 2026-07-26 起返回播种报告(installed/updated/protectedStale),源不存在 = 空报告、不抛
    await expect(seedSkillsInto(path.join(tmp, 'nope'), path.join(tmp, 'dest'))).resolves.toEqual({
      installed: [],
      updated: [],
      protectedStale: [],
    });
  });
});
