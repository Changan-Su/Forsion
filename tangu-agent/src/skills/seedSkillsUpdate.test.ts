import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { seedSkillsInto } from './localSkills.js';

let root: string, src: string, dest: string;
const put = (dir: string, name: string, body: string, extra?: Record<string, string>): void => {
  mkdirSync(path.join(dir, name), { recursive: true });
  writeFileSync(path.join(dir, name, 'SKILL.md'), body, 'utf8');
  for (const [rel, c] of Object.entries(extra ?? {})) {
    mkdirSync(path.dirname(path.join(dir, name, rel)), { recursive: true });
    writeFileSync(path.join(dir, name, rel), c, 'utf8');
  }
};
const read = (name: string, rel = 'SKILL.md'): string => readFileSync(path.join(dest, name, rel), 'utf8');
/** 复现**上一版** treeHash(OS 垃圾也进哈希),用来伪造老装机上已经写下的指纹。 */
const legacyStamp = (dir: string): string => {
  const files: string[] = [];
  const walk = (rel: string): void => {
    for (const e of readdirSync(path.join(dir, rel), { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(r);
      else if (e.isFile() && r !== '.seed-stamp') files.push(r);
    }
  };
  walk('');
  files.sort();
  const h = createHash('sha256');
  for (const f of files) {
    h.update(f);
    h.update('\0');
    h.update(readFileSync(path.join(dir, f)));
    h.update('\0');
  }
  return h.digest('hex').slice(0, 16);
};
const stampOf = (name: string): string => readFileSync(path.join(dest, name, '.seed-stamp'), 'utf8').trim();

beforeEach(() => {
  root = mkdtempSync(path.join(tmpdir(), 'seed-'));
  src = path.join(root, 'builtin');
  dest = path.join(root, 'user');
  mkdirSync(src, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('内置技能播种', () => {
  it('首次播种:整夹复制,并留下指纹', async () => {
    put(src, 'alpha', 'v1', { 'template.md': 'T1' });
    const r = await seedSkillsInto(src, dest);
    expect(r.installed).toEqual(['alpha']);
    expect(read('alpha')).toBe('v1');
    expect(existsSync(path.join(dest, 'alpha', '.seed-stamp'))).toBe(true);
  });

  it('⚠️用户没改过 → 内置更新跟着传下去(旧行为是「已存在就永远跳过」,修订永远传不到)', async () => {
    put(src, 'alpha', 'v1');
    await seedSkillsInto(src, dest);
    put(src, 'alpha', 'v2(新增一整节)');
    const r = await seedSkillsInto(src, dest);
    expect(r.updated).toEqual(['alpha']);
    expect(read('alpha')).toBe('v2(新增一整节)');
  });

  it('⚠️.DS_Store 不参与指纹 —— 否则 Finder 一开文件夹就把技能永久冻在旧版(2026-08-19 实翻 skill-creator)', async () => {
    put(src, 'alpha', 'v1');
    await seedSkillsInto(src, dest);
    // 两边各自被 Finder 写了一个内容不同的 .DS_Store(源里的还会随构建打进包)
    writeFileSync(path.join(src, 'alpha', '.DS_Store'), 'finder-A', 'utf8');
    writeFileSync(path.join(dest, 'alpha', '.DS_Store'), 'finder-B', 'utf8');
    put(src, 'alpha', 'v2');
    const r = await seedSkillsInto(src, dest);
    expect(r.protectedStale).toEqual([]);
    expect(r.updated).toEqual(['alpha']);
    expect(read('alpha')).toBe('v2');
  });

  it('.DS_Store 之外的真实用户改动照旧保护(上一条不能把保护也一起放水)', async () => {
    put(src, 'alpha', 'v1');
    await seedSkillsInto(src, dest);
    writeFileSync(path.join(dest, 'alpha', '.DS_Store'), 'finder-B', 'utf8');
    writeFileSync(path.join(dest, 'alpha', 'SKILL.md'), '用户自己改的', 'utf8');
    put(src, 'alpha', 'v2');
    const r = await seedSkillsInto(src, dest);
    expect(r.protectedStale).toEqual(['alpha']);
    expect(read('alpha')).toBe('用户自己改的');
  });

  it('⚠️老装机的旧算法指纹仍要认 —— 否则「排除 OS 垃圾」这一改会把一批本来正常的镜像判成用户改过(Codex P1)', async () => {
    put(src, 'alpha', 'v1');
    writeFileSync(path.join(src, 'alpha', '.DS_Store'), 'finder', 'utf8');
    await seedSkillsInto(src, dest);
    writeFileSync(path.join(dest, 'alpha', '.seed-stamp'), legacyStamp(path.join(dest, 'alpha')), 'utf8');
    put(src, 'alpha', 'v2');
    writeFileSync(path.join(src, 'alpha', '.DS_Store'), 'finder', 'utf8');
    const r = await seedSkillsInto(src, dest);
    expect(r.protectedStale).toEqual([]);
    expect(r.updated).toEqual(['alpha']);
    expect(read('alpha')).toBe('v2');
    expect(stampOf('alpha')).not.toBe(legacyStamp(path.join(dest, 'alpha')));
  });

  it('内容已是最新但指纹是旧算法 → 就地迁移成新算法值(不必等下一版内置)', async () => {
    put(src, 'alpha', 'v1');
    writeFileSync(path.join(src, 'alpha', '.DS_Store'), 'finder', 'utf8');
    await seedSkillsInto(src, dest);
    const legacy = legacyStamp(path.join(dest, 'alpha'));
    writeFileSync(path.join(dest, 'alpha', '.seed-stamp'), legacy, 'utf8');
    const r = await seedSkillsInto(src, dest);
    expect(r.updated).toEqual([]);
    expect(r.protectedStale).toEqual([]);
    expect(stampOf('alpha')).not.toBe(legacy);
  });

  it('⚠️用户改过 SKILL.md → 保护,且报告出来(不静默停更)', async () => {
    put(src, 'alpha', 'v1');
    await seedSkillsInto(src, dest);
    writeFileSync(path.join(dest, 'alpha', 'SKILL.md'), '我自己改的', 'utf8');
    put(src, 'alpha', 'v2');
    const r = await seedSkillsInto(src, dest);
    expect(read('alpha')).toBe('我自己改的');
    expect(r.protectedStale).toEqual(['alpha']);
  });

  it('⚠️用户只改了附属文件、没碰 SKILL.md → 一样要保护(只哈希 SKILL.md 会吃掉这类改动)', async () => {
    put(src, 'alpha', 'v1', { 'scripts/run.py': 'print(1)' });
    await seedSkillsInto(src, dest);
    writeFileSync(path.join(dest, 'alpha', 'scripts/run.py'), 'print("我的改动")', 'utf8');
    put(src, 'alpha', 'v2', { 'scripts/run.py': 'print(2)' });
    const r = await seedSkillsInto(src, dest);
    expect(read('alpha', 'scripts/run.py')).toBe('print("我的改动")');
    expect(r.protectedStale).toEqual(['alpha']);
  });

  it('⚠️源里删掉的文件不会残留(整目录替换,不是 merge)', async () => {
    put(src, 'alpha', 'v1', { 'scripts/legacy.py': '老脚本' });
    await seedSkillsInto(src, dest);
    rmSync(path.join(src, 'alpha', 'scripts'), { recursive: true });
    put(src, 'alpha', 'v2');
    await seedSkillsInto(src, dest);
    expect(existsSync(path.join(dest, 'alpha', 'scripts/legacy.py'))).toBe(false);
  });

  it('内置只改了脚本、SKILL.md 没动 → 脚本修订照样传下去', async () => {
    put(src, 'alpha', 'same', { 'scripts/run.py': 'v1' });
    await seedSkillsInto(src, dest);
    put(src, 'alpha', 'same', { 'scripts/run.py': 'v2' });
    const r = await seedSkillsInto(src, dest);
    expect(r.updated).toEqual(['alpha']);
    expect(read('alpha', 'scripts/run.py')).toBe('v2');
  });

  it('⚠️老装机(无指纹、内容不同)保护住并报告 —— 不假定「没被改过」就覆盖', async () => {
    put(src, 'alpha', 'v2');
    mkdirSync(path.join(dest, 'alpha'), { recursive: true });
    writeFileSync(path.join(dest, 'alpha', 'SKILL.md'), '来路不明的旧副本', 'utf8');
    const r = await seedSkillsInto(src, dest);
    expect(read('alpha')).toBe('来路不明的旧副本');
    expect(r.protectedStale).toEqual(['alpha']);
  });

  it('老装机内容恰好与当前内置逐字节相同 → 补指纹(吃不掉任何改动),此后能正常跟上', async () => {
    put(src, 'alpha', 'v1');
    mkdirSync(path.join(dest, 'alpha'), { recursive: true });
    writeFileSync(path.join(dest, 'alpha', 'SKILL.md'), 'v1', 'utf8'); // 无指纹但内容相同
    await seedSkillsInto(src, dest);
    expect(existsSync(path.join(dest, 'alpha', '.seed-stamp'))).toBe(true);
    put(src, 'alpha', 'v2');
    const r = await seedSkillsInto(src, dest);
    expect(r.updated).toEqual(['alpha']); // ← 这才是「补上指纹后下一次跟上」,上一版这条断言是假的
    expect(read('alpha')).toBe('v2');
  });

  it('同版重跑幂等:不算更新、不留暂存目录', async () => {
    put(src, 'alpha', 'v1');
    await seedSkillsInto(src, dest);
    const r = await seedSkillsInto(src, dest);
    expect(r).toEqual({ installed: [], updated: [], protectedStale: [] });
    expect(readFileSync(path.join(dest, 'alpha', '.seed-stamp'), 'utf8')).toBeTruthy();
  });

  it('替换失败不留半成品:目标只读时保住旧内容并报告', async () => {
    put(src, 'alpha', 'v1');
    await seedSkillsInto(src, dest);
    put(src, 'alpha', 'v2');
    chmodSync(dest, 0o500); // 目录不可写 → rename 失败
    try {
      const r = await seedSkillsInto(src, dest);
      expect(r.updated).toEqual([]);
      expect(read('alpha')).toBe('v1'); // 旧内容还在
    } finally {
      chmodSync(dest, 0o700);
    }
  });

  it('源里没有 SKILL.md 的目录、以及点开头的目录都不当技能', async () => {
    mkdirSync(path.join(src, 'notaskill'), { recursive: true });
    mkdirSync(path.join(src, '.hidden'), { recursive: true });
    writeFileSync(path.join(src, '.hidden', 'SKILL.md'), 'x', 'utf8');
    await seedSkillsInto(src, dest);
    expect(existsSync(path.join(dest, 'notaskill'))).toBe(false);
    expect(existsSync(path.join(dest, '.hidden'))).toBe(false);
  });
});
