/**
 * P1 · G5 评审(P1):远程污点 run 开头引擎自己收集 git 现场(agentLoop → collectGitState → runGit)也要套写保护。
 * 攻击链:一次被批准的远程命令在工作区仓库摆 clean filter(`git config filter.x.clean 'sh payload.sh'` + `.gitattributes`,
 * 写保护刻意不拒 .git);下一次远程 run 开头引擎跑 `git status`,filter 以用户身份执行 → 清空 / 改写 config.json(远程上限档)。
 *
 * 真 agentLoop(内存 SQLite、fake brain 抓 wire)× 真 git × 真 sandbox-exec,只在 darwin 上跑(别的平台没有这层,是方案 C)。
 *   ① 远程 run:git 现场照常注入(证明 collectGitState 真跑了、filter 真被调用),config.json 字节不变;
 *   ② 本机 run:方案 B 起同样套(runGit 每一条都 writeProtectShell)—— git 现场照常注入、config.json 不变。
 *      原先这里是「本机不套、config.json 被清空」的残余钉,方案 B 落地时翻转(docs/remote-bash-protected-paths.md「方案 B」)。
 *   ③ 本机 run 里模型免审批跑的 `git status`(known-safe):闸门给 writeProtect,执行套同一个 profile。filter 定义放在全局配置
 *      (分类器只看仓库级配置,全局那份照 git-lfs 的惯例放行),仓库里只有 .gitattributes —— 于是它仍是 known-safe、不弹卡,
 *      能改动 config.json 的只剩执行这一层。
 * 负对照:把 agentLoop 里 collectGitState 的 ctx 去掉 `remote, runId` → ①红(P1-G5);runGit 去掉 writeProtectShell → ①②红;
 *   agentLoop.runApprovedCall 不传 writeProtect → ③红(方案 B 交付报告)。
 * 跑:cd tangu-agent && npx vitest run test/remoteGitStateSeatbelt.test.ts
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, realpathSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { query } from '../src/core/db.js';
import { createRun, getRun } from '../src/services/runStore.js';
import { enqueueRun } from '../src/services/agentLoop.js';
import { hostSandboxBackend } from '../src/sandbox/hostSandbox.js';
import { configFile } from '../src/core/tanguHome.js';
import { repoConfigRisks, trustRepo } from '../src/services/gitTrust.js';

const USER = 'u1';
const REMOTE = { via: 'tunnel', marked: true };
const seatbelt = process.platform === 'darwin' && hostSandboxBackend().available;
const ENV_KEYS = ['TANGU_HOME', 'GIT_CONFIG_GLOBAL', 'GIT_CONFIG_NOSYSTEM'] as const;
const prevEnv: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {};
const CFG0 = JSON.stringify({ remote: { maxApprovalMode: 'auto-edit' } });
const q = (p: string): string => `'${p.replace(/'/g, `'\\''`)}'`;

let base: string;
let repo: string;
let cfgPath: string;
let llmPayloads: any[];
let nextToolCalls: any[] | null = null; // ③:第一轮让模型调一次工具

beforeAll(async () => {
  for (const k of ENV_KEYS) prevEnv[k] = process.env[k];
  base = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-g5-gitstate-')));
  repo = join(base, 'ws');
  mkdirSync(join(base, 'home'), { recursive: true });
  mkdirSync(repo, { recursive: true });
  process.env.TANGU_HOME = join(base, 'home');
  process.env.GIT_CONFIG_GLOBAL = '/dev/null';
  process.env.GIT_CONFIG_NOSYSTEM = '1';
  cfgPath = configFile();
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: USER });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const fakeBrain: any = {
    llm: {
      resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
      buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })) }),
      streamProviderCompletion: async (o: any) => {
        llmPayloads.push(o.payload);
        const calls = nextToolCalls;
        nextToolCalls = null;
        if (calls) return { content: '', reasoning: '', toolCalls: calls, usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'tool_calls' };
        return { content: 'ok', reasoning: '', toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 5 }, finishReason: 'stop' };
      },
    },
    users: { getUserById: async () => ({ id: USER, username: 'u' }) },
    memory: { getMemory: async () => ({ content: '' }) },
    models: { hasDirectModel: () => false },
  };
  const fakeBilling: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({ host, brain: fakeBrain, billing: fakeBilling, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
  // 远程命令摆好的现场(摆放那一步在写保护之内本就能成,见 remoteShellSeatbelt.test.ts 的残余用例):仓库 + clean filter + payload。
  const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo });
  git('init', '-q');
  writeFileSync(join(repo, 'f.txt'), 'a');
  git('add', 'f.txt');
  git('commit', '-qm', 'i');
  // 合并 main 后:未信任的仓 main 的 gitTrust 根本不读工作区(见 src/services/gitTrust.test.ts)。这里钉的是另一半 —— 用户早先信任过这个仓
  // (信任按目录身份绑定、不看配置内容),之后被远程命令摆进 filter:引擎照常读工作区,写保护是最后一道。
  await trustRepo((await repoConfigRisks(repo))!.commonDir);
  writeFileSync(join(repo, 'payload.sh'), `cp /dev/null ${q(cfgPath)}; cat\n`);
  git('config', 'filter.x.clean', `sh ${join(repo, 'payload.sh')}`);
  writeFileSync(join(repo, '.gitattributes'), '* filter=x\n');
});
afterAll(() => {
  for (const k of ENV_KEYS) { if (prevEnv[k] === undefined) delete process.env[k]; else process.env[k] = prevEnv[k]; }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* ignore */ }
});
beforeEach(() => {
  llmPayloads = [];
  writeFileSync(cfgPath, CFG0);
  // 同尺寸改内容 + 挪开 mtime:git status 必须重新 hash f.txt → 必走 clean filter(不靠 racy-git 的时序碰运气)。
  writeFileSync(join(repo, 'f.txt'), 'b');
  const t = new Date(Date.now() - 60_000 - Math.floor(Math.random() * 60_000));
  utimesSync(join(repo, 'f.txt'), t, t);
});

let seq = 0;
async function runToSettled(extra: Record<string, unknown>, cwd = repo): Promise<any> {
  const sid = `G5-GIT-${++seq}`;
  const id = `R-${sid}`;
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [sid, USER]);
  await createRun({
    id, sessionId: sid, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`,
    input: { message: 'hi', userMessageId: `U-${id}`, attachments: [], agentConfig: { execMode: 'host', cwd }, origin: 'client', ...extra },
  });
  enqueueRun(sid, id);
  const t0 = Date.now();
  for (;;) {
    const r = await getRun(id);
    if (r && ['done', 'failed', 'aborted'].includes(String(r.status))) return r;
    if (Date.now() - t0 > 20_000) throw new Error(`run 未结束(status=${r?.status})`);
    await new Promise((res) => setTimeout(res, 25));
  }
}
const textOf = (m: any): string => (typeof m?.content === 'string' ? m.content : JSON.stringify(m?.content ?? ''));
const lastUser = (payload: any): string => textOf([...(payload.messages as any[])].reverse().find((m) => m.role === 'user'));

describe.skipIf(!seatbelt)('远程污点 run 的 git 现场收集套写保护(macOS,宿主沙箱关)', { timeout: 30_000 }, () => {
  it('① 远程 run:git 现场照常注入,仓库里摆的 clean filter 改不动 config.json', async () => {
    const run = await runToSettled({ remote: REMOTE });
    expect(run.status).toBe('done');
    const user = lastUser(llmPayloads[0]);
    expect(user).toContain('[Git state]'); // 现场真收集了(不是因为没跑才没改)
    expect(user).toContain('f.txt');
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
  });

  it('② 本机 run(方案 B):git 现场照常注入,同一个 filter 也改不动 config.json(原残余钉,已翻转)', async () => {
    const run = await runToSettled({});
    expect(run.status).toBe('done');
    const user = lastUser(llmPayloads[0]);
    expect(user).toContain('[Git state]');
    expect(user).toContain('f.txt');
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
  });

  it('③ 本机 run 里免审批的 `git status`(known-safe):不弹卡、照常出结果,执行套写保护,全局配置里的 filter 改不动 config.json', async () => {
    // 仓库级配置干净(分类器照旧放行);filter 定义在全局配置里,仓库只有 .gitattributes —— 能挡住它的只剩执行那一层
    const repo2 = join(base, 'ws2');
    mkdirSync(repo2, { recursive: true });
    const git = (...a: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd: repo2 });
    git('init', '-q');
    writeFileSync(join(repo2, 'g.txt'), 'a');
    git('add', 'g.txt');
    git('commit', '-qm', 'i');
    writeFileSync(join(repo2, '.gitattributes'), '* filter=g\n');
    const globalCfg = join(base, 'global.gitconfig');
    writeFileSync(globalCfg, `[filter "g"]\n\tclean = sh ${join(repo, 'payload.sh')}\n`);
    writeFileSync(join(repo2, 'g.txt'), 'b');
    const t = new Date(Date.now() - 60_000);
    utimesSync(join(repo2, 'g.txt'), t, t);
    // 对照:不套时这条链是真的(git status 执行全局 filter → config.json 被清空)
    execFileSync('git', ['status', '--porcelain'], { cwd: repo2, env: { ...process.env, GIT_CONFIG_GLOBAL: globalCfg } });
    expect(readFileSync(cfgPath, 'utf8')).toBe('');
    writeFileSync(cfgPath, CFG0);
    writeFileSync(join(repo2, 'g.txt'), 'c');
    utimesSync(join(repo2, 'g.txt'), t, t);
    process.env.GIT_CONFIG_GLOBAL = globalCfg;
    try {
      nextToolCalls = [{ id: 'gs1', type: 'function', function: { name: 'run_bash', arguments: JSON.stringify({ command: 'git status --porcelain' }) } }];
      const run = await runToSettled({}, repo2); // 缺省 auto-edit:不是 known-safe 就会停在审批卡上等人,这里 20 s 超时即红
      expect(run.status).toBe('done');
      const toolMsg = textOf([...(llmPayloads[1]?.messages as any[] ?? [])].reverse().find((m) => m.role === 'tool'));
      expect(toolMsg).toMatch(/g\.txt/);
      expect(toolMsg).toMatch(/exit_code: 0/);
      expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
    } finally { process.env.GIT_CONFIG_GLOBAL = '/dev/null'; nextToolCalls = null; }
  });
});
