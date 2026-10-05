/**
 * 项目级记忆在团队 / 讨论 / 子 agent 的会话里(10-05)。
 * 钉的病理:项目归属只认会话行自己的 project_path。团队成员的工作会话(kind=teamwork)、讨论会话(kind=discussion)、
 * 子 agent 的记录会话(kind=delegate)建行时都不带这一列 —— 它们明明在项目里干活,提示里却没有项目记忆,
 * remember 也没有「项目级」这个选项(写了报「这个会话没有项目」)。
 *   ① 这三种行自己没有项目时,沿 parent_session_id 往上找(只认同一个用户、最多 4 层、别的种类不找);
 *   ② 成员会话里读得到、写得进同一份项目记忆;
 *   ③ 临时成员(一次性的人设)不给 remember / log_event —— 以前照给,它能往自己名下的记忆、日志乃至(这次起)项目记忆里写东西。
 *      只管写:组装提示时读记忆的那条路仍会建出空的 agents/<临时名>/ 目录,那是原有行为,不在这里;
 *   ④ 子 agent(与父会话同一个会话 id):remember 本来就带项目级、写得进(钉住现状);这次补的是它提示里的项目记忆段。
 * 建行的形状以引擎自己的 INSERT 为准:teamRuns.ts findOrCreateMemberSession、discussion.ts、delegateTranscript.ts
 * (各自的形状由 test/teamRuns.test.ts、test/delegateTranscript.test.ts 钉着)。
 */
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { createRun } from '../src/services/runStore.js';
import { runSubAgent } from '../src/services/subAgent.js';
import { memoryLogProvider } from '../src/tools/builtin/memoryLog.js';
import { getToolDefinitions, listDeferredTools } from '../src/tools/registry.js';
import { buildProjectMemoryContext, openProjectMemory, resolveProjectMemory } from '../src/services/projectMemory.js';

const USER = 'owner';
let home: string, work: string, database: any;
let subPayloads: any[] = [];
let script: Array<() => any> = [];
const previousHome = process.env.TANGU_HOME;
const profile = createTanguProfile({ sandboxMode: 'none' });
const tools = memoryLogProvider.tools();
const remember = tools.find((t) => t.name === 'remember')!;
const logEvent = tools.find((t) => t.name === 'log_event')!;
const ctxOf = (sessionId: string, extra: Record<string, unknown> = {}) => ({ userId: USER, sessionId, appId: 'tangu', execMode: 'host', runId: `run-${sessionId}`, profile, ...extra } as any);
const call = (sessionId: string, args: Record<string, unknown>, extra: Record<string, unknown> = {}, slug = 'xyra') =>
  runWithAgentSlug(slug, async () => String(await remember.execute(args, ctxOf(sessionId, extra))));
/** 一行会话。kind / parent 之外的列与引擎建这几种行时一样留空。 */
const row = (id: string, o: { kind?: string; parent?: string | null; project?: string | null; projectless?: boolean; user?: string } = {}) =>
  database.prepare('INSERT INTO chat_sessions (id, user_id, app_id, title, kind, parent_session_id, project_path, projectless) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(id, o.user ?? USER, 'tangu', id, o.kind ?? 'user', o.parent ?? null, o.project ?? null, o.projectless ? 1 : 0);
const dirOf = async (sessionId: string) => (await resolveProjectMemory(USER, sessionId))?.dir ?? null;
const offered = (ctx: any): Set<string> => new Set([
  ...getToolDefinitions({ ...ctx, unlockTools: () => {} }).map((t: any) => t.function?.name),
  ...listDeferredTools(ctx).map((d) => d.name),
]);

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-projscope-'))); process.env.TANGU_HOME = home;
  work = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-projscope-work-')));
  for (const p of ['alpha', 'beta']) mkdirSync(join(work, p));
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: USER }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  const llm: any = {
    resolveModelAndKey: async () => ({ model: { provider: 'test', name: 'test' }, apiKey: 'k', baseUrl: 'b', apiModelId: 'm' }),
    buildProviderPayload: async (o: any) => ({ messages: o.messages.map((m: any) => ({ ...m })), tools: o.tools }),
    streamProviderCompletion: async (o: any) => {
      subPayloads.push(o.payload);
      const step = script.shift();
      if (!step) throw new Error('script exhausted');
      return step();
    },
  };
  const billing: any = { canConsumeTokenPoints: async () => ({ ok: true }), consumeTokenPoints: async () => ({ ok: true }), calculateCost: async () => 0, logApiUsage: async () => {} };
  configureTangu({
    host, billing, profile,
    brain: { llm, memory: createLocalMemoryBrain({ deviceId: 'fixture' }), users: { getUserById: async () => ({ id: USER, username: 'u' }) }, models: { hasDirectModel: () => false } } as any,
  });
  await runMigration();
  const alpha = join(work, 'alpha');
  row('main', { project: alpha });                                  // 普通项目会话
  row('team', { project: alpha });                                  // 项目里的团队会话(就是一个带成员的项目会话)
  row('member', { kind: 'teamwork', parent: 'team' });              // 成员的工作会话
  row('disc', { kind: 'discussion', parent: 'main' });              // start_discussion 起的讨论
  row('disc-member', { kind: 'teamwork', parent: 'disc' });         // 讨论里的成员
  row('deleg', { kind: 'delegate', parent: 'member' });             // 成员派出去的子 agent 的记录会话
  row('solo-team', { projectless: true });                          // 不属于项目的团队
  row('solo-member', { kind: 'teamwork', parent: 'solo-team' });
  row('assist', { kind: 'discussion', parent: 'main', project: join(work, 'beta') }); // 行上自己带着项目(分支会话会抄过来)
  row('muse', { kind: 'muse', parent: 'main' });
  row('auto', { kind: 'automation', parent: 'main' });
  row('branch', { kind: 'user', parent: 'main' });                  // 普通会话带父链(分支):没抄项目就是没有项目
  row('theirs', { user: 'intruder', project: join(work, 'beta') });
  row('under-theirs', { kind: 'teamwork', parent: 'theirs' });      // 父会话是别人的
  row('theirs-mid', { user: 'intruder', kind: 'teamwork', parent: 'main' });
  row('via-theirs', { kind: 'teamwork', parent: 'theirs-mid' });    // 中间隔着一行别人的会话
  row('opted-out', { kind: 'teamwork', parent: 'main', projectless: true }); // 行上明说不属于项目
  row('loop-a', { kind: 'teamwork', parent: 'loop-b' });
  row('loop-b', { kind: 'teamwork', parent: 'loop-a' });
  row('gone-parent', { kind: 'teamwork', parent: 'no-such-session' });
  let up = 'main';
  for (let i = 1; i <= 6; i++) { row(`deep-${i}`, { kind: 'delegate', parent: up }); up = `deep-${i}`; }
  await createRun({ id: 'R1', sessionId: 'main', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A1', input: { message: 'go', userMessageId: 'U1', attachments: [], agentConfig: {} } });
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true }); rmSync(work, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('① 项目归属沿父会话往上找', () => {
  it('团队成员、讨论、讨论里的成员、成员派出去的子 agent → 都是父会话的那个项目', async () => {
    const main = await dirOf('main');
    expect(main).toBeTruthy();
    for (const id of ['team', 'member', 'disc', 'disc-member', 'deleg']) expect(await dirOf(id), id).toBe(main);
  });
  it('行上自己带着项目 → 用自己的,不往上找', async () => {
    expect((await resolveProjectMemory(USER, 'assist'))?.name).toBe('beta');
  });
  it('父会话不属于项目 → 成员也没有;行上明说不属于项目 → 不往上找', async () => {
    expect(await dirOf('solo-member')).toBeNull();
    expect(await dirOf('opted-out')).toBeNull();
  });
  it('别的种类不往上找:Muse、自动化、普通会话', async () => {
    for (const id of ['muse', 'auto', 'branch']) expect(await dirOf(id), id).toBeNull();
  });
  it('父会话是别人的 / 不存在 / 成环 / 太深 → 没有项目,而且停得下来', async () => {
    for (const id of ['under-theirs', 'via-theirs', 'gone-parent', 'loop-a', 'loop-b']) expect(await dirOf(id), id).toBeNull();
    expect(await dirOf('deep-4')).toBe(await dirOf('main')); // 4 层以内
    expect(await dirOf('deep-5')).toBeNull();                 // 再深不找
  });
});

describe('② 成员会话里的项目记忆', () => {
  it('成员写项目级 → 落在父会话那个项目的库里;同项目的别的会话、成员自己下一轮的提示里都有', async () => {
    const receipt = JSON.parse(await call('member', { action: 'add', scope: 'project', fact: 'Releases are cut from the release branch only.' }));
    expect(receipt).toMatchObject({ ok: true, scope: 'project', project: 'alpha', count: 1 });
    for (const id of ['main', 'member', 'disc-member', 'deleg']) {
      const block = await buildProjectMemoryContext(USER, id);
      expect(block, id).toContain('## Project Memory (alpha)');
      expect(block, id).toContain('Releases are cut from the release branch only.');
    }
    expect(await buildProjectMemoryContext(USER, 'solo-member')).toBe('');
  });
  it('不属于项目的团队成员:写项目级照旧报错', async () => {
    expect(await call('solo-member', { action: 'add', scope: 'project', fact: 'x'.repeat(20) })).toMatch(/^Error: this session has no project/);
  });
});

describe('③ 临时成员(没有自己的文件夹)', () => {
  it('不给 remember / log_event;具名成员照给', () => {
    const named = offered(ctxOf('member', { teamSessionId: 'team', inDiscussion: true, projectScoped: true }));
    const temp = offered(ctxOf('member', { teamSessionId: 'team', inDiscussion: true, projectScoped: true, ephemeral: true }));
    for (const n of ['remember', 'log_event']) { expect(named.has(n), `具名成员 ${n}`).toBe(true); expect(temp.has(n), `临时成员 ${n}`).toBe(false); }
    expect(temp.has('read_file')).toBe(true); // 别的工具不受影响
  });
  it('直接调也拒:两级记忆和日志都没写进去', async () => {
    const out = await call('member', { action: 'add', scope: 'agent', fact: 'A temporary persona should not leave memory behind.' }, { ephemeral: true }, 'temp-reviewer');
    expect(out).toMatch(/^Error: /);
    expect(await call('member', { action: 'add', scope: 'project', fact: 'A temporary persona should not write project memory.' }, { ephemeral: true }, 'temp-reviewer')).toMatch(/^Error: /);
    const logged = await runWithAgentSlug('temp-reviewer', async () => String(await logEvent.execute({ text: 'did a thing' }, ctxOf('member', { ephemeral: true }))));
    expect(logged).toMatch(/^Error: /);
    expect(existsSync(join(home, 'agents', 'temp-reviewer'))).toBe(false); // 工具这条路上连目录都没碰
    expect((await openProjectMemory((await resolveProjectMemory(USER, 'member'))!)).snapshot().entries.map((e) => e.content)).toEqual(['Releases are cut from the release branch only.']);
  });
});

describe('④ 子 agent(delegate,自有循环)', () => {
  const parent = (sessionId: string, extra: Record<string, unknown> = {}) => ({ userId: USER, sessionId, appId: 'tangu', runId: 'R1', profile, execMode: 'sandbox', thinkingLevel: 'medium', ...extra } as any);
  const sysOf = (payload: any): string => String((payload.messages as any[]).find((m) => m.role === 'system')?.content || '');
  const toolOf = (payload: any, name: string): any => ((payload.tools ?? []) as any[]).find((t) => t?.function?.name === name);
  const finish = () => ({ content: 'done', reasoning: '', toolCalls: [], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' });

  it('父会话在项目里:remember 带项目级、写得进同一个库(现状,钉住);提示里有项目记忆段(这次补的)', async () => {
    subPayloads = [];
    script = [
      () => ({ content: '', reasoning: '', toolCalls: [{ id: 'tc1', type: 'function', function: { name: 'remember', arguments: JSON.stringify({ action: 'add', scope: 'project', fact: 'Integration tests need the local database container running.' }) } }], usage: { prompt_tokens: 1, completion_tokens: 1 }, finishReason: 'stop' }),
      finish,
    ];
    await runWithAgentSlug('xyra', () => runSubAgent({ task: 'look around', parentCtx: parent('main', { projectScoped: true }), modelId: 'm1' }));
    expect(toolOf(subPayloads[0], 'remember')?.function.parameters.properties.scope, '子 agent 的 remember 应带 scope').toBeTruthy();
    const saved = (await openProjectMemory((await resolveProjectMemory(USER, 'main'))!)).snapshot().entries.map((e) => e.content);
    expect(saved).toContain('Integration tests need the local database container running.');
    const sys = sysOf(subPayloads[0]);
    expect(sys).toContain('## Project Memory (alpha)');
    expect(sys).toContain('Releases are cut from the release branch only.');
  }, 20_000);

  it('父会话不属于项目:提示里没有项目记忆段', async () => {
    subPayloads = []; script = [finish];
    await createRun({ id: 'R2', sessionId: 'solo-team', userId: USER, appId: 'tangu', modelId: 'm1', assistantMessageId: 'A2', input: { message: 'go', userMessageId: 'U2', attachments: [], agentConfig: {} } });
    await runWithAgentSlug('xyra', () => runSubAgent({ task: 'look around', parentCtx: parent('solo-team', { runId: 'R2' }), modelId: 'm1' }));
    expect(sysOf(subPayloads[0])).not.toContain('## Project Memory');
  }, 20_000);
});
