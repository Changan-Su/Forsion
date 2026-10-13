import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';
import { findProjectRoot, projectDocPaths, loadProjectDoc, projectDocSection } from './projectDoc.js';

let root: string;
const w = (rel: string, body: string): void => {
  const p = path.join(root, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, body, 'utf8');
};

beforeAll(() => {
  root = mkdtempSync(path.join(tmpdir(), 'tangu-projdoc-'));
  // 布局:
  //   <root>/outside.md                 ← 项目根之外,永远不该被读到
  //   <root>/repo/.git/HEAD             ← 项目根标记
  //   <root>/repo/AGENTS.md
  //   <root>/repo/pkg/CLAUDE.md         ← 中间层用别家文件名
  //   <root>/repo/pkg/app/AGENTS.md + CLAUDE.md   ← 同层两份,两个家族各取一份
  w('AGENTS.md', '库外的约定,不该出现');
  w('repo/.git/HEAD', 'ref: refs/heads/main');
  w('repo/AGENTS.md', '仓库通则');
  w('repo/pkg/CLAUDE.md', '包级约定');
  w('repo/pkg/app/AGENTS.md', '应用级约定');
  w('repo/pkg/app/CLAUDE.md', '同层另一份,也要读到');
  w('repo/pkg/app/.agents/AGENTS.md', '同家族次选,不该出现');
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

describe('项目根定位', () => {
  it('找最近的含标记祖先', () => {
    expect(findProjectRoot(path.join(root, 'repo/pkg/app'))).toBe(path.join(root, 'repo'));
  });
  it('⚠️`.tangu` 不是标记:它就是引擎 home 的目录名(~/.tangu),认了会让 $HOME 恒为项目根', () => {
    w('solo/.tangu/AGENTS.md', 'x');
    expect(findProjectRoot(path.join(root, 'solo'))).toBeNull();
    // 但那份 .tangu/AGENTS.md 照样读得到 —— 无根时只看 cwd,cwd 就是它所在那层
    expect(projectDocPaths(path.join(root, 'solo'))).toEqual([path.join(root, 'solo/.tangu/AGENTS.md')]);
  });
  it('⚠️走到家目录就停:$HOME 自己是 dotfiles 仓也不当项目根', () => {
    const sub = path.join(homedir(), 'no-such-dir-for-test');
    expect(findProjectRoot(homedir())).toBeNull();
    expect(findProjectRoot(sub)).toBeNull(); // 不存在也不该上溯出 $HOME
  });
  it('⚠️家目录守卫比的是真实身份:软链别名绕不过去(codex)', () => {
    // 用可控的假 home 建真场景:home 自己是 dotfiles 仓(有 .git)+ 一条指向它的软链别名。
    // 字面比对下 `<root>/homealias` !== `<root>/fakehome` → 守卫不命中 → 经别名看到 .git
    // → 把家目录判成项目根 → 家目录那份 AGENTS.md 被当成项目约定注入。
    const fakeHome = path.join(root, 'fakehome');
    w('fakehome/.git/HEAD', 'ref: refs/heads/main');
    w('fakehome/AGENTS.md', '家目录的通用约定,不该被当成项目约定');
    w('fakehome/work/deep/note.txt', 'x');
    const alias = path.join(root, 'homealias');
    symlinkSync(fakeHome, alias);
    const prevHome = process.env.HOME;
    const prevProfile = process.env.USERPROFILE;
    process.env.HOME = fakeHome; // os.homedir() 在 POSIX 上读 $HOME
    process.env.USERPROFILE = fakeHome; // Windows 上读 %USERPROFILE%
    try {
      expect(findProjectRoot(fakeHome)).toBeNull(); // 字面命中
      expect(findProjectRoot(alias)).toBeNull(); // ⚠️软链别名:修复前会返回 alias
      expect(findProjectRoot(path.join(alias, 'work/deep'))).toBeNull(); // ⚠️修复前会返回 alias
      expect(projectDocPaths(path.join(alias, 'work/deep'))).toEqual([]); // 家目录那份没渗进来
    } finally {
      if (prevHome === undefined) delete process.env.HOME;
      else process.env.HOME = prevHome;
      if (prevProfile === undefined) delete process.env.USERPROFILE;
      else process.env.USERPROFILE = prevProfile;
    }
  });
});

describe('沿途收集', () => {
  it('根 → cwd 顺序;同层 AGENTS.md 与 CLAUDE.md 都读,同家族的两个位置只取第一个', () => {
    const paths = projectDocPaths(path.join(root, 'repo/pkg/app'));
    expect(paths).toEqual([
      path.join(root, 'repo/AGENTS.md'),
      path.join(root, 'repo/pkg/CLAUDE.md'),
      path.join(root, 'repo/pkg/app/AGENTS.md'),
      path.join(root, 'repo/pkg/app/CLAUDE.md'),
    ]);
  });

  it('⚠️绝不越过项目根:库外那份永远读不到', () => {
    const joined = projectDocPaths(path.join(root, 'repo/pkg/app')).join('|');
    expect(joined).not.toContain(path.join(root, 'AGENTS.md'));
  });

  it('拼装顺序 = 越具体越靠后(下层要能压过上层)', () => {
    const doc = loadProjectDoc(path.join(root, 'repo/pkg/app'))!;
    expect(doc.text.indexOf('仓库通则')).toBeLessThan(doc.text.indexOf('包级约定'));
    expect(doc.text.indexOf('包级约定')).toBeLessThan(doc.text.indexOf('应用级约定'));
    expect(doc.text.indexOf('应用级约定')).toBeLessThan(doc.text.indexOf('同层另一份,也要读到'));
    expect(doc.text).not.toContain('同家族次选,不该出现');
  });

  it('同层两份正文一模一样(CLAUDE.md 是 AGENTS.md 的拷贝)→ 只收一次', () => {
    w('dup/AGENTS.md', '同一份约定');
    w('dup/CLAUDE.md', '同一份约定\n');
    const doc = loadProjectDoc(path.join(root, 'dup'))!;
    expect(doc.sources).toEqual([path.join(root, 'dup/AGENTS.md')]);
  });

  it('⚠️去重只在同层:跨层重复是覆盖顺序,最里层那份不能丢(codex)', () => {
    w('ovr/.git/HEAD', 'ref: refs/heads/main');
    w('ovr/AGENTS.md', 'Use npm');
    w('ovr/pkg/AGENTS.md', 'Use pnpm');
    w('ovr/pkg/app/AGENTS.md', 'Use npm');
    const doc = loadProjectDoc(path.join(root, 'ovr/pkg/app'))!;
    expect(doc.sources).toHaveLength(3);
    expect(doc.text.lastIndexOf('Use npm')).toBeGreaterThan(doc.text.indexOf('Use pnpm'));
  });

  it('⚠️同层两份大文件一模一样:第二份读进来已被额度截短也要认出来,不能吃光额度挤掉下层(codex)', () => {
    const big = '约定:多字节也要对得上。\n'.repeat(700); // ~24KB,两份加起来超 32KB
    w('twin/.git/HEAD', 'ref: refs/heads/main');
    w('twin/AGENTS.md', big);
    w('twin/CLAUDE.md', big);
    w('twin/app/AGENTS.md', '下层的短约定');
    const doc = loadProjectDoc(path.join(root, 'twin/app'))!;
    expect(doc.sources).toEqual([path.join(root, 'twin/AGENTS.md'), path.join(root, 'twin/app/AGENTS.md')]);
    expect(doc.truncated).toBe(false);
  });

  it('没有任何一份 → null(不产生空段)', () => {
    mkdirSync(path.join(root, 'bare/.git'), { recursive: true });
    expect(loadProjectDoc(path.join(root, 'bare'))).toBeNull();
    expect(projectDocSection(path.join(root, 'bare'))).toBeNull();
    expect(projectDocSection(undefined)).toBeNull();
  });

  it('没有项目根标记 → 只看 cwd,不上溯(否则家目录的文件渗进每个项目)', () => {
    w('loose/sub/AGENTS.md', '就地一份');
    // <root>/AGENTS.md 存在但 loose/sub 之上没有 .git/.tangu → 只该收自己这层
    expect(projectDocPaths(path.join(root, 'loose/sub'))).toEqual([path.join(root, 'loose/sub/AGENTS.md')]);
  });

  it('超上限在文件边界截断并标记,不把上下文吃穿', () => {
    w('big/.git/HEAD', 'x');
    w('big/AGENTS.md', 'A'.repeat(5000));
    w('big/sub/AGENTS.md', 'B'.repeat(5000));
    const doc = loadProjectDoc(path.join(root, 'big/sub'), 4000)!;
    expect(doc.truncated).toBe(true);
    expect(doc.sources.length).toBeLessThanOrEqual(2);
  });
});

describe('信任边界(codex 评审)', () => {
  it('⚠️拒绝符号链接:仓库提交 AGENTS.md -> ~/.ssh/id_rsa 不能把私钥读进系统提示', () => {
    mkdirSync(path.join(root, 'evil/.git'), { recursive: true });
    writeFileSync(path.join(root, 'secret.key'), 'PRIVATE KEY', 'utf8');
    symlinkSync(path.join(root, 'secret.key'), path.join(root, 'evil/AGENTS.md'));
    expect(projectDocPaths(path.join(root, 'evil'))).toEqual([]);
    expect(loadProjectDoc(path.join(root, 'evil'))).toBeNull();
  });

  it('⚠️目录段软链也要拒:提交 `.claude -> 别处` 不能把别处的 CLAUDE.md 读进系统提示', () => {
    // lstat 只判最后一段 → 光有上面那条防线,目录软链能整个绕过去
    mkdirSync(path.join(root, 'evildir/.git'), { recursive: true });
    w('elsewhere/CLAUDE.md', '别人家的约定');
    symlinkSync(path.join(root, 'elsewhere'), path.join(root, 'evildir/.claude'));
    expect(projectDocPaths(path.join(root, 'evildir'))).toEqual([]);
  });

  it('二进制文件(含 NUL)跳过,不把控制字符塞进系统提示', () => {
    mkdirSync(path.join(root, 'bin/.git'), { recursive: true });
    writeFileSync(path.join(root, 'bin/AGENTS.md'), Buffer.from([0x41, 0x00, 0x42]));
    expect(loadProjectDoc(path.join(root, 'bin'))).toBeNull();
  });

  it('实际拼出来的文本不超过声称的上限(计费含来源标题与分隔符)', () => {
    mkdirSync(path.join(root, 'cap/.git'), { recursive: true });
    writeFileSync(path.join(root, 'cap/AGENTS.md'), 'x'.repeat(4000), 'utf8');
    const cap = 2000;
    const doc = loadProjectDoc(path.join(root, 'cap'), cap)!;
    expect(doc.truncated).toBe(true);
    expect(Buffer.byteLength(doc.text, 'utf8')).toBeLessThanOrEqual(cap);
  });

  it('超大文件不整份读进内存(有界读取:只取额度+1 字节)', () => {
    mkdirSync(path.join(root, 'huge/.git'), { recursive: true });
    writeFileSync(path.join(root, 'huge/AGENTS.md'), 'y'.repeat(2_000_000), 'utf8');
    const doc = loadProjectDoc(path.join(root, 'huge'), 1000)!;
    expect(doc.truncated).toBe(true);
    expect(Buffer.byteLength(doc.text, 'utf8')).toBeLessThanOrEqual(1000);
  });
});
