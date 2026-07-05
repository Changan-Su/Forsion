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

  it('missing source dir is a no-op (no throw)', async () => {
    await expect(seedSkillsInto(path.join(tmp, 'nope'), path.join(tmp, 'dest'))).resolves.toBeUndefined();
  });
});
