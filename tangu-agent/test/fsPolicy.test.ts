import { describe, it, expect, afterAll } from 'vitest';
import path from 'node:path';
import os from 'node:os';
import { mkdirSync, writeFileSync, symlinkSync, rmSync, mkdtempSync, realpathSync, existsSync } from 'node:fs';
import { checkWritePath, isOutsideWorkspace, foldPath, foldPathSegment } from '../src/tools/fsPolicy.js';
import { agentsDir, DEFAULT_AGENT_SLUG } from '../src/core/tanguHome.js';
import { enterRunContext } from '../src/seams/runContext.js';

const ctx = (cwd: string, extraRoots?: string[]) => ({ cwd, extraRoots } as any);
const ws = path.resolve('/tmp/forsion-ws-test');

describe('fsPolicy.checkWritePath', () => {
  it('allows writes inside the workspace root', () => {
    expect(checkWritePath(ctx(ws), path.join(ws, 'a/b.ts'))).toEqual({ ok: true, hardDeny: false, reason: '' });
  });

  it('flags writes outside the workspace as escalation (not hardDeny)', () => {
    const v = checkWritePath(ctx(ws), path.resolve('/tmp/other/x.ts'));
    expect(v.ok).toBe(false);
    expect(v.hardDeny).toBe(false);
  });

  it('hard-denies writes into .git even inside the workspace', () => {
    expect(checkWritePath(ctx(ws), path.join(ws, '.git', 'config')).hardDeny).toBe(true);
  });

  it('hard-denies writes into ~/.ssh', () => {
    expect(checkWritePath(ctx(ws), path.join(os.homedir(), '.ssh', 'id_rsa')).hardDeny).toBe(true);
  });

  it('allows the agent to write its own Library (home is a writable root, no escalation)', () => {
    const lib = path.join(agentsDir(), DEFAULT_AGENT_SLUG, 'Library', 'notes.md');
    expect(checkWritePath(ctx(ws), lib)).toEqual({ ok: true, hardDeny: false, reason: '' });
  });
  it('额外工作文件夹并入可写根:不再判越界写', () => {
    const extra = path.resolve('/tmp/forsion-extra-test');
    expect(checkWritePath(ctx(ws, [extra]), path.join(extra, 'docs/a.md')).ok).toBe(true);
    expect(isOutsideWorkspace(ctx(ws, [extra]), path.join(extra, 'docs/a.md'))).toBe(false);
    // 没加进来的目录照旧升审批
    expect(isOutsideWorkspace(ctx(ws, [extra]), path.resolve('/tmp/nope/a.md'))).toBe(true);
  });

  it('⚠️额外工作文件夹提不了权:受保护路径仍硬拒', () => {
    const ssh = path.join(os.homedir(), '.ssh');
    expect(checkWritePath(ctx(ws, [ssh]), path.join(ssh, 'id_rsa')).hardDeny).toBe(true);
    const repo = path.resolve('/tmp/forsion-extra-test');
    expect(checkWritePath(ctx(ws, [repo]), path.join(repo, '.git', 'config')).hardDeny).toBe(true);
  });

});

describe('agent 身份/自进化文件硬拒(Codex 评审 #1 + 复核软链绕过)', () => {
  // 真实临时 agent 目录(软链测试需要真文件系统)。
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fsp-agent-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it('generic 写自己 SOUL.md/config.toml/HARNESS.md/journal → 硬拒;Library/MEMORY 照常可写', () => {
    enterRunContext('u1', 'r1', DEFAULT_AGENT_SLUG, 'testbot');
    for (const f of ['SOUL.md', 'config.toml', 'HARNESS.md', '.harness-refinements.jsonl', '.harness-raw.md', '.cloudsync-accounts.json', '.memory-state.json', '.memory-tombstones.json', '.memory-dream.json', '.memory-raw.md', '.memory.lock']) {
      // 展示身份与记忆域两个 slug 的目录都拒
      expect(checkWritePath(ctx(ws), path.join(agentsDir(), 'testbot', f)).hardDeny, f).toBe(true);
      expect(checkWritePath(ctx(ws), path.join(agentsDir(), DEFAULT_AGENT_SLUG, f)).hardDeny, `mem:${f}`).toBe(true);
    }
    // 可写根是记忆域 slug 的目录(writableRoots 既有行为):Library/MEMORY 照常
    expect(checkWritePath(ctx(ws), path.join(agentsDir(), DEFAULT_AGENT_SLUG, 'Library', 'n.md')).ok).toBe(true);
    expect(checkWritePath(ctx(ws), path.join(agentsDir(), DEFAULT_AGENT_SLUG, 'MEMORY.md')).ok).toBe(true);
    // 别人的 SOUL 不在此判(manage_agent/用户域):不硬拒
    expect(checkWritePath(ctx(ws), path.join(agentsDir(), 'someone-else', 'SOUL.md')).hardDeny).toBe(false);
  });

  it('共用默认记忆的 agent:提示词指路的是展示身份的 Library,它也得是可写根(否则每次写自己的 Library 都弹「工作区外」)', () => {
    enterRunContext('u1', 'r1', DEFAULT_AGENT_SLUG, 'testbot');
    expect(checkWritePath(ctx(ws), path.join(agentsDir(), 'testbot', 'Library', 'n.md')).ok).toBe(true);
    expect(isOutsideWorkspace(ctx(ws), path.join(agentsDir(), 'someone-else', 'Library', 'n.md'))).toBe(true);
  });

  it('软链绕不过:Library 里指向 SOUL.md 的 symlink 照样硬拒', () => {
    const agentDir = path.join(tmp, 'agents', 'linky');
    mkdirSync(path.join(agentDir, 'Library'), { recursive: true });
    writeFileSync(path.join(agentDir, 'SOUL.md'), 'soul');
    symlinkSync('../SOUL.md', path.join(agentDir, 'Library', 'soul-link'));
    const prevHome = process.env.TANGU_HOME;
    process.env.TANGU_HOME = tmp; // agentsDir() → tmp/agents
    try {
      enterRunContext('u1', 'r1', 'linky', 'linky');
      expect(checkWritePath(ctx(ws), path.join(agentDir, 'Library', 'soul-link')).hardDeny).toBe(true);
    } finally {
      if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
    }
  });
});

describe('fsPolicy.isOutsideWorkspace', () => {
  it('true for out-of-workspace, false for in-workspace, false for hardDeny (handled by tool)', () => {
    expect(isOutsideWorkspace(ctx(ws), path.resolve('/tmp/other/x.ts'))).toBe(true);
    expect(isOutsideWorkspace(ctx(ws), path.join(ws, 'x.ts'))).toBe(false);
    expect(isOutsideWorkspace(ctx(ws), path.join(os.homedir(), '.ssh', 'k'))).toBe(false); // hardDeny ≠ escalation
  });
});

describe('任一 Agent 的 config.toml 硬拒(Codex 09-25 P1:会话目录盖住 agents/ 时改别人的审批档)', () => {
  // 真实临时 home:macOS 的 tmpdir 在 /var → /private/var 软链下,字面与 realpath 两种写法都得拦。
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fsp-anycfg-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const withHome = <T>(fn: (agents: string) => T): T => {
    const prev = process.env.TANGU_HOME;
    process.env.TANGU_HOME = tmp;
    try {
      const agents = agentsDir();
      mkdirSync(path.join(agents, 'other', 'Library'), { recursive: true });
      writeFileSync(path.join(agents, 'other', 'config.toml'), 'name = "Other"\napproval_mode = "readonly"\n');
      return fn(agents);
    } finally {
      if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev;
    }
  };

  it('会话目录 = home(盖住 agents/):别人的 / 新建的 config.toml、旧式扁平 <slug>.md 一律硬拒;Library 照常', () => {
    withHome((agents) => {
      enterRunContext('u1', 'r1', 'me', 'me');
      const c = ctx(tmp);
      const deny = (p: string): boolean => checkWritePath(c, p).hardDeny;
      expect(deny(path.join(agents, 'other', 'config.toml'))).toBe(true);
      expect(deny(path.join(agents, 'brand-new', 'config.toml'))).toBe(true); // 新建一个 full-auto agent 同样不行
      expect(deny(path.join(agents, 'evil.md'))).toBe(true); // 旧式扁平定义会被迁成 config.toml
      // 大小写不敏感盘:CONFIG.TOML / AGENTS/ 落在同一个文件上
      expect(deny(path.join(agents, 'other', 'CONFIG.TOML'))).toBe(true);
      expect(deny(path.join(path.dirname(agents), 'AGENTS', 'Other', 'Config.toml'))).toBe(true);
      // realpath 写法(/private/var/...)同样拦
      expect(deny(path.join(realpathSync(agents), 'other', 'config.toml'))).toBe(true);
      // 不放宽也不误伤:别人的 Library / MEMORY 仍按工作区规则可写,别人的 SOUL 不在此判
      expect(checkWritePath(c, path.join(agents, 'other', 'Library', 'n.md')).ok).toBe(true);
      expect(checkWritePath(c, path.join(agents, 'other', 'MEMORY.md')).ok).toBe(true);
      expect(deny(path.join(agents, 'other', 'SOUL.md'))).toBe(false);
      expect(deny(path.join(agents, 'other', 'Library', 'config.toml'))).toBe(false); // 只认 agents/<slug>/config.toml 这一层
    });
  });

  it('额外工作文件夹 = agents/ 也提不了权;工作区里指向别人 config.toml 的软链照样硬拒', () => {
    withHome((agents) => {
      enterRunContext('u1', 'r1', 'me', 'me');
      expect(checkWritePath(ctx(ws, [agents]), path.join(agents, 'other', 'config.toml')).hardDeny).toBe(true);
      const w = path.join(tmp, 'ws');
      mkdirSync(w, { recursive: true });
      symlinkSync(path.join(agents, 'other', 'config.toml'), path.join(w, 'cfg-link'));
      expect(checkWritePath(ctx(w), path.join(w, 'cfg-link')).hardDeny).toBe(true);
      symlinkSync(agents, path.join(w, 'agents-link'));
      expect(checkWritePath(ctx(w), path.join(w, 'agents-link', 'other', 'config.toml')).hardDeny).toBe(true);
    });
  });

  it('自己的身份文件:换大小写(SOUL.MD / OTHER/Harness.md)也绕不过', () => {
    withHome((agents) => {
      enterRunContext('u1', 'r1', 'other', 'other');
      expect(checkWritePath(ctx(tmp), path.join(agents, 'other', 'SOUL.MD')).hardDeny).toBe(true);
      expect(checkWritePath(ctx(tmp), path.join(agents, 'OTHER', 'Harness.md')).hardDeny).toBe(true);
    });
  });
});

describe('Unicode 大小写折叠绕不过硬拒(09-25 P1:APFS 按完整大小写折叠,ﬁ / ſ / ß 都落在同一个文件上)', () => {
  // 真实临时 home:已存在的文件走 realpath.native 取盘上真名,不存在的尾段走折叠 —— 两条路都钉。
  // 大小写敏感盘(Linux CI)上 native 不改名,全靠折叠,断言照样成立。
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'fsp-fold-'));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const withHome = <T>(fn: (agents: string) => T): T => {
    const prev = process.env.TANGU_HOME;
    process.env.TANGU_HOME = tmp;
    try {
      const agents = agentsDir();
      mkdirSync(path.join(agents, 'other', 'Library'), { recursive: true });
      writeFileSync(path.join(agents, 'other', 'config.toml'), 'name = "Other"\napproval_mode = "readonly"\n');
      mkdirSync(path.join(agents, 'self'), { recursive: true });
      writeFileSync(path.join(agents, 'self', 'SOUL.md'), 'soul');
      return fn(agents);
    } finally {
      if (prev === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prev;
    }
  };
  const FI = '\uFB01'; // ﬁ 连字
  const LONG_S = '\u017F'; // ſ 长 s

  it('别人的 / 新建的 config.toml:ﬁ 连字、ſ 写的 agents 目录、全角字母一律硬拒', () => {
    withHome((agents) => {
      enterRunContext('u1', 'r1', 'me', 'me');
      const c = ctx(tmp); // 会话目录盖住 agents/
      const deny = (p: string): boolean => checkWritePath(c, p).hardDeny;
      const home = path.dirname(agents);
      expect(deny(path.join(agents, 'other', `con${FI}g.toml`))).toBe(true); // 已存在:同一个文件
      expect(deny(path.join(home, `agent${LONG_S}`, 'other', 'config.toml'))).toBe(true);
      expect(deny(path.join(agents, 'newbot', `con${FI}g.toml`))).toBe(true); // 新建的 agent:尾段不存在,靠折叠
      expect(deny(path.join(home, `agent${LONG_S}`, 'newbot', `CON${FI.toUpperCase()}G.TOML`))).toBe(true);
      expect(deny(path.join(agents, 'newbot', '\uFF43\uFF4F\uFF4E\uFF46\uFF49\uFF47.toml'))).toBe(true); // 全角 ｃｏｎｆｉｇ
      expect(deny(path.join(home, `agent${LONG_S}`, 'newbot.md'))).toBe(true); // 旧式扁平定义
      // 不误伤:别人的 Library 里同名文件、别人的 MEMORY 照常可写
      expect(checkWritePath(c, path.join(agents, 'other', 'Library', `con${FI}g.toml`)).ok).toBe(true);
      expect(checkWritePath(c, path.join(agents, 'other', 'MEMORY.md')).ok).toBe(true);
    });
  });

  it('自己的身份文件:ſOUL.md / HARNEß.md(已存在与不存在两种)一律硬拒;Library 照常', () => {
    withHome((agents) => {
      enterRunContext('u1', 'r1', 'self', 'self');
      const c = ctx(path.join(tmp, 'ws'));
      expect(checkWritePath(c, path.join(agents, 'self', `${LONG_S}OUL.md`)).hardDeny).toBe(true); // SOUL.md 已存在
      expect(checkWritePath(c, path.join(agents, 'self', 'HARNE\u00DF.md')).hardDeny).toBe(true); // HARNESS.md 尚不存在
      expect(checkWritePath(c, path.join(agents, 'self', `.memory-${LONG_S}tate.json`)).hardDeny).toBe(true);
      expect(checkWritePath(c, path.join(agents, 'self', 'Library', `${LONG_S}OUL.md`)).ok).toBe(true);
    });
  });

  it('已存在的段取盘上真名(realpath.native):不分大小写的盘上,拒绝语里点名的是真正的 config.toml', () => {
    withHome((agents) => {
      const alias = path.join(agents, 'other', `con${FI}g.toml`);
      // 只在「ﬁ 写法确实打开同一个文件」的盘上有意义(macOS APFS 默认);大小写敏感盘上跳过断言
      if (!existsSync(alias)) return;
      enterRunContext('u1', 'r1', 'me', 'me');
      const v = checkWritePath(ctx(tmp), alias);
      expect(v.hardDeny).toBe(true);
      expect(v.reason).toContain(`${path.sep}other${path.sep}config.toml`);
      expect(v.reason).not.toContain(FI);
    });
  });

  it('.git 段按折叠比:.GIT / 全角同样是 git 元数据', () => {
    expect(checkWritePath(ctx(ws), path.join(ws, '.GIT', 'config')).hardDeny).toBe(true);
    expect(checkWritePath(ctx(ws), path.join(ws, '.\uFF47it', 'HEAD')).hardDeny).toBe(true);
    expect(checkWritePath(ctx(ws), path.join(ws, '.gitignore')).ok).toBe(true);
  });

  it('win32 折叠(本机非 Windows,只单测折叠本身):尾部点 / 空格、备用数据流都归回原名;posix 不剥', () => {
    for (const v of ['config.toml.', 'config.toml ', 'config.toml. .', 'config.toml::$DATA', 'CONFIG.TOML:evil', `con${FI}g.toml.`]) {
      expect(foldPathSegment(v, 'win32'), v).toBe('config.toml');
    }
    expect(foldPathSegment('config.toml.', 'linux')).toBe('config.toml.'); // posix 上尾点是另一个文件名
    expect(foldPathSegment('HARNE\u00DF.md', 'darwin')).toBe('harness.md');
    expect(foldPath('C:\\Users\\A\\.tangu\\agents\\Other\\config.toml::$DATA', 'win32'))
      .toBe('c:\\users\\a\\.tangu\\agents\\other\\config.toml');
    expect(foldPath('/Users/A/agent\u017F/x', 'darwin')).toBe('/users/a/agents/x');
  });
});
