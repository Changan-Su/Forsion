/**
 * P1 · G5 评审(P1):远程污点 run 开头引擎自己收集 git 现场(agentLoop → collectGitState → runGit)也要套写保护。
 * 攻击链:一次被批准的远程命令在工作区仓库摆 clean filter(`git config filter.x.clean 'sh payload.sh'` + `.gitattributes`,
 * 写保护刻意不拒 .git);下一次远程 run 开头引擎跑 `git status`,filter 以用户身份执行 → 清空 / 改写 config.json(远程上限档)。
 *
 * 真 agentLoop(内存 SQLite、fake brain 抓 wire)× 真 git × 真 sandbox-exec,只在 darwin 上跑(别的平台没有这层,是方案 C)。
 *   ① 远程 run:git 现场照常注入(证明 collectGitState 真跑了、filter 真被调用),config.json 字节不变;
 *   ② 本机 run:照旧不套(本机行为逐字不变)—— filter 被执行、config.json 被清空。这是**残余钉**:本机 / 项目详情面板那一半
 *      是待拍板项(docs/remote-bash-protected-paths.md「git filter 残余」),修了就该翻过来。
 * 负对照:把 agentLoop 里 collectGitState 的 ctx 去掉 `remote, runId` → ①红(实跑见 P1-G5 评审修复交付报告)。
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
async function runToSettled(extra: Record<string, unknown>): Promise<any> {
  const sid = `G5-GIT-${++seq}`;
  const id = `R-${sid}`;
  await query(`INSERT INTO chat_sessions (id, user_id, app_id, title, model_id, kind) VALUES (?, ?, 'tangu', 't', 'm1', 'user')`, [sid, USER]);
  await createRun({
    id, sessionId: sid, userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: `A-${id}`,
    input: { message: 'hi', userMessageId: `U-${id}`, attachments: [], agentConfig: { execMode: 'host', cwd: repo }, origin: 'client', ...extra },
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

describe.skipIf(!seatbelt)('远程污点 run 的 git 现场收集套写保护(macOS,宿主沙箱关)', () => {
  it('① 远程 run:git 现场照常注入,仓库里摆的 clean filter 改不动 config.json', async () => {
    const run = await runToSettled({ remote: REMOTE });
    expect(run.status).toBe('done');
    const user = lastUser(llmPayloads[0]);
    expect(user).toContain('[Git state]'); // 现场真收集了(不是因为没跑才没改)
    expect(user).toContain('f.txt');
    expect(readFileSync(cfgPath, 'utf8')).toBe(CFG0);
  });

  it('② 残余钉 —— 本机 run 不套(行为逐字不变):同一个 filter 被引擎执行,config.json 被清空', async () => {
    const run = await runToSettled({});
    expect(run.status).toBe('done');
    expect(lastUser(llmPayloads[0])).toContain('[Git state]');
    expect(readFileSync(cfgPath, 'utf8')).toBe('');
  });
});
