/** 「当前模型那条线要 API key,而这台电脑上没有配」:走真 runAcpEngine(真子进程、真 SDK 连接),对面是照 DSH 的样子说话的假 agent。
 *  照的是 0.2.2-rc.3 实测到的两件事(真 DSH 的同一项在 scripts/dsh-engine.check.mjs 的 nokey):
 *   - 模型清单只列凭据探得到的那几条线的模型;当前模型不在清单里时,被单独塞进它那一组,名字就是模型 id;
 *   - 缺 key 的那一轮,session/prompt 回 -32603,只有 message(没有 data),这一轮什么更新都不发。
 *  只用账号登录时新会话的缺省模型正是要 key 的那条线,所以不选模型每一句都失败。 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { mapAcpConfigOptions, missingApiKeyRoute, modelNoApiKeyError, runAcpEngine } from './acpEngine.js';
import { createEngineManager } from './manager.js';
import type { EngineDef } from './config.js';
import type { EngineRunCtx } from './manager.js';
import { parseEngineModelNoApiKey } from '../contracts/engineModelError.js';

// 真 DSH 的原话(一字不差)
const DSH_RAW = 'Internal error: turn failed: llm-deepseek: no API key for provider route "deepseek-official"; store DEEPSEEK_API_KEY through the credentials service (the web Models page writes it), or export DEEPSEEK_API_KEY in the launching environment';
// 引擎换成的那句话。桌面那边的测试(desktop/frontend/src/views/chat2/runError.test.ts)拿同一句去拆,两边要一起改。
const WITH_OTHERS = 'engine_model_no_api_key: Fake Harness needs an API key for its current model ("deepseek-v4-flash") and none is set up. '
  + 'Pick another model in the model menu and send again. Other models it offers include: "DeepSeek-V4.1-Flash", "DeepSeek-V4-Pro". '
  + `[${DSH_RAW}]`;
const NO_OTHERS = 'engine_model_no_api_key: Fake Harness needs an API key for its current model ("deepseek-v4-flash") and none is set up. '
  + 'It offers no other model: sign in or add an API key in Fake Harness itself, then send again. '
  + `[${DSH_RAW}]`;

const OFFICIAL_PRO = '["deepseek-official","deepseek-v4-pro"]';
const ACCOUNT_FLASH = '["deepseek-account","deepseek-flash"]';

/** FAKE_KEY:有 API key。FAKE_ACCOUNT(或者 <store>.account 这个文件在):用账号登录了。FAKE_KEY_LISTED:清单里列着要 key 的那条线的模型,发的时候却没有 key
 *  (key 刚被删掉)。FAKE_PROMPT_ERROR:这一轮因为别的原因失败,报这句话。 */
const FAKE_AGENT = String.raw`
import { readFileSync, writeFileSync, existsSync, appendFileSync } from 'node:fs';
const store = process.env.FAKE_STORE;
const log = (m) => appendFileSync(store + '.log', m + '\n');
const load = () => (existsSync(store) ? JSON.parse(readFileSync(store, 'utf8')) : { sessions: {} });
const save = (s) => writeFileSync(store, JSON.stringify(s));
const OFFICIAL = 'deepseek-official', ACCOUNT = 'deepseek-account';
const val = (p, m) => JSON.stringify([p, m]);
const DEFAULT = val(OFFICIAL, 'deepseek-v4-flash');
const hasKey = !!process.env.FAKE_KEY, listsKeyed = hasKey || !!process.env.FAKE_KEY_LISTED, hasAccount = !!process.env.FAKE_ACCOUNT || existsSync(store + '.account');
const options = (s) => {
  const groups = [
    { group: OFFICIAL, name: 'DeepSeek', options: listsKeyed ? [{ value: val(OFFICIAL, 'deepseek-flash'), name: 'DeepSeek-V4.1-Flash' }, { value: val(OFFICIAL, 'deepseek-v4-pro'), name: 'DeepSeek-V4-Pro', description: 'Stronger.' }] : [] },
    { group: ACCOUNT, name: 'DeepSeek Account', options: hasAccount ? [{ value: val(ACCOUNT, 'deepseek-flash'), name: 'DeepSeek-V4.1-Flash' }, { value: val(ACCOUNT, 'deepseek-v4-pro'), name: 'DeepSeek-V4-Pro' }] : [] },
  ];
  if (!groups.some((g) => g.options.some((o) => o.value === s.model))) {
    const [p, m] = JSON.parse(s.model);
    groups.find((g) => g.group === p).options.unshift({ value: s.model, name: m });
  }
  return [
    { id: 'model', name: 'Model', category: 'model', type: 'select', currentValue: s.model, options: groups.filter((g) => g.options.length > 0) },
    { id: 'reasoning_effort', name: 'Reasoning effort', category: 'thought_level', type: 'select', currentValue: 'high', options: [{ value: 'off', name: 'Off' }, { value: 'high', name: 'High' }] },
  ];
};
const send = (o) => process.stdout.write(JSON.stringify(o) + '\n');
let buf = '';
process.stdin.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i); buf = buf.slice(i + 1); if (line.trim()) handle(JSON.parse(line)); } });
process.stdin.on('end', () => process.exit(0));
function handle(m) {
  if (!m.method) return;
  log(m.method);
  const ok = (result) => send({ jsonrpc: '2.0', id: m.id, result });
  const err = (code, message) => send({ jsonrpc: '2.0', id: m.id, error: { code, message } });
  const st = load(); const p = m.params || {};
  if (m.method === 'initialize') return ok({ protocolVersion: 1, agentInfo: { name: 'fake-dsh-agent', version: '0' }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {}, list: {} } } });
  if (m.method === 'session/new') { const id = 'sess-' + (Object.keys(st.sessions).length + 1); st.sessions[id] = { turns: 0, model: DEFAULT }; save(st); return ok({ sessionId: id, configOptions: options(st.sessions[id]) }); }
  if (m.method === 'session/resume') { const s = st.sessions[p.sessionId]; if (!s) return err(-32602, 'Invalid params: session is not resumable: ' + p.sessionId); return ok({ configOptions: options(s) }); }
  if (m.method === 'session/set_config_option') { const s = st.sessions[p.sessionId]; log('set ' + p.configId + '=' + p.value); if (p.configId === 'model') s.model = p.value; save(st); return ok({ configOptions: options(s) }); }
  if (m.method === 'session/close') return ok({});
  if (m.method === 'session/prompt') {
    const s = st.sessions[p.sessionId]; s.turns += 1; save(st); // 失败的那一轮,提问也记进了会话
    if (process.env.FAKE_PROMPT_ERROR) return err(-32603, process.env.FAKE_PROMPT_ERROR);
    if (JSON.parse(s.model)[0] === OFFICIAL && !hasKey) return err(-32603, ${JSON.stringify(DSH_RAW)});
    send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: p.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'turns=' + s.turns + ' model=' + s.model } } } });
    return ok({ stopReason: 'end_turn' });
  }
  if (m.id != null) return err(-32601, 'Method not found: ' + m.method);
}
`;

let dir = '';
let store = '';
let agentFile = '';
const def = (env: Record<string, string> = {}): EngineDef => ({ id: 'fake', name: 'Fake Harness', command: process.execPath, args: [agentFile], env: { FAKE_STORE: store, ...env } });
const lines = (): string[] => (existsSync(`${store}.log`) ? readFileSync(`${store}.log`, 'utf8').split('\n').filter(Boolean) : []);
const sets = (): string[] => lines().filter((l) => l.startsWith('set '));

function ctx(over: Partial<EngineRunCtx> = {}): EngineRunCtx & { seen: string[] } {
  const seen: string[] = [];
  return {
    engineId: 'fake', runId: 'r', sessionId: 's', userId: 'u', message: 'hi', cwd: dir,
    signal: new AbortController().signal,
    publish: () => {},
    requestApproval: async () => ({ action: 'reject' }),
    onSession: (info) => { seen.push(info.id); },
    seen,
    ...over,
  };
}
const failure = (p: Promise<unknown>): Promise<any> => p.then(() => null, (e) => e);

beforeAll(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'tangu-acp-credential-'));
  agentFile = path.join(dir, 'fake-agent.mjs');
  writeFileSync(agentFile, FAKE_AGENT);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
let n = 0;
beforeEach(() => { store = path.join(dir, `store-${++n}.json`); });

describe('runAcpEngine × 当前模型缺 API key', () => {
  it('只用账号登录、不选模型:失败原因点名当前模型和另一组的模型;之后选了账号那一组的,同一场会话接着就通', async () => {
    const c1 = ctx();
    const err = await failure(runAcpEngine(def({ FAKE_ACCOUNT: '1' }), c1));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(WITH_OTHERS);
    expect(err.engineModelNoApiKey).toBe(true);
    expect(err.externalSessionGone).toBeUndefined();
    expect(c1.seen).toEqual(['sess-1']); // 会话照常记下了:换了模型再发,接的是同一场
    expect(sets()).toEqual([]); // 没有替用户换模型

    const second = await runAcpEngine(def({ FAKE_ACCOUNT: '1' }), ctx({ resumeSessionId: 'sess-1', engineModelId: ACCOUNT_FLASH }));
    expect(second.content).toBe(`turns=2 model=${ACCOUNT_FLASH}`);
    expect(sets()).toEqual([`set model=${ACCOUNT_FLASH}`]);
    expect(lines().filter((l) => l === 'session/new')).toHaveLength(1);
  }, 30_000);

  it('什么凭据都没有:清单里只有当前模型自己 → 不叫人换模型,说去引擎那边登录或填 key', async () => {
    const err = await failure(runAcpEngine(def(), ctx()));
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe(NO_OTHERS);
    expect(err.engineModelNoApiKey).toBe(true);
  }, 20_000);

  it('选了的模型换上之后才缺 key:点名的是刚换上的那个;同一组的不算可以换的', async () => {
    const err = await failure(runAcpEngine(def({ FAKE_ACCOUNT: '1', FAKE_KEY_LISTED: '1' }), ctx({ engineModelId: OFFICIAL_PRO })));
    expect(sets()).toEqual([`set model=${OFFICIAL_PRO}`]);
    const info = parseEngineModelNoApiKey(err.message);
    expect(info?.model).toBe('DeepSeek-V4-Pro'); // 不是新会话缺省的那个 deepseek-v4-flash
    expect(info?.others).toEqual(['DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro']); // 账号那一组的两个;要 key 的那一组里另外两个不在内
    expect(info?.raw).toBe(DSH_RAW);
  }, 20_000);

  it('有 key:不选模型照常跑,不碰这条路', async () => {
    const res = await runAcpEngine(def({ FAKE_KEY: '1' }), ctx());
    expect(res.content).toBe('turns=1 model=["deepseek-official","deepseek-v4-flash"]');
  }, 20_000);

  it('这一轮因为别的原因失败:原样抛,不改写', async () => {
    const other = 'Internal error: turn failed: llm-deepseek: upstream returned 503';
    const err = await failure(runAcpEngine(def({ FAKE_ACCOUNT: '1', FAKE_PROMPT_ERROR: other }), ctx()));
    expect(err.message).toBe(other);
    expect(err.code).toBe(-32603);
    expect(err.engineModelNoApiKey).toBeUndefined();
  }, 20_000);
});

describe('引擎管理器 × 当前模型缺 API key', () => {
  const savedHome = process.env.TANGU_HOME;
  afterAll(() => { if (savedHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = savedHome; });

  it('这样失败一次之后,缓存着的模型清单作废:下次问能力清单重新探测,看得到失败之后才登录出来的模型', async () => {
    process.env.TANGU_HOME = path.join(dir, `home-${n}`);
    const cfg = path.join(dir, `engines-${n}.json`);
    writeFileSync(cfg, JSON.stringify({ engines: [def()] })); // 起初什么凭据都没有
    const mgr = createEngineManager(cfg);
    const cached = await mgr.capabilities('fake');
    expect(cached.models.map((m) => m.name)).toEqual(['deepseek-v4-flash']);
    expect(await mgr.capabilities('fake')).toBe(cached); // 没出事时一直用缓存

    const err = await failure(mgr.run(ctx()));
    expect(err.message).toBe(NO_OTHERS);
    writeFileSync(`${store}.account`, ''); // 用户照提示去引擎那边用账号登录了

    const probes = lines().filter((l) => l === 'initialize').length;
    const again = await mgr.capabilities('fake');
    expect(lines().filter((l) => l === 'initialize').length).toBe(probes + 1);
    expect(again.models.map((m) => m.name)).toEqual(['deepseek-v4-flash', 'DeepSeek-V4.1-Flash', 'DeepSeek-V4-Pro']);
    await mgr.dispose();
  }, 60_000);
});

describe('missingApiKeyRoute', () => {
  it('只认 DSH 那一句(SDK 原样抛出的对象、Error、真话在 data.details 里的,都认)', () => {
    expect(missingApiKeyRoute({ code: -32603, message: DSH_RAW })).toBe('deepseek-official');
    expect(missingApiKeyRoute(new Error(DSH_RAW))).toBe('deepseek-official');
    expect(missingApiKeyRoute({ code: -32603, message: 'Internal error', data: { details: 'turn failed: llm-x: no API key for provider route "x-official"; …' } })).toBe('x-official');
  });
  it('别的和 key 有关的失败不算:key 不对、过期、限流,换模型解决不了', () => {
    for (const text of ['401 Unauthorized: invalid api key', 'Your API key has expired', 'no API key', 'rate limit exceeded for this API key', 'Internal error']) {
      expect(missingApiKeyRoute({ code: -32603, message: text })).toBeNull();
    }
    expect(missingApiKeyRoute(undefined)).toBeNull();
  });
});

describe('modelNoApiKeyError × 引擎怎么分组', () => {
  const grouped = (current: string, groups: Array<[string, Array<[string, string]>]>) => mapAcpConfigOptions([{
    id: 'model', category: 'model', type: 'select', currentValue: current,
    options: groups.map(([group, options]) => ({ group, name: group.toUpperCase(), options: options.map(([value, name]) => ({ value, name })) })),
  }]);
  const others = (e: Error): string[] | undefined => parseEngineModelNoApiKey(e.message)?.others;

  it('mapAcpConfigOptions 记下每个模型在哪一组;模型条目本身不多字段', () => {
    const sel = grouped('a1', [['a', [['a1', 'A1']]], ['b', [['b1', 'B1']]]]);
    expect(sel.modelGroups).toEqual({ a1: 'a', b1: 'b' });
    expect(sel.models).toEqual([{ id: 'a1', name: 'A1', description: 'A' }, { id: 'b1', name: 'B1', description: 'B' }]);
  });
  it('当前模型的那一组整组不算可以换的', () => {
    const sel = grouped('a1', [['a', [['a1', 'A1'], ['a2', 'A2']]], ['b', [['b1', 'B1']]]]);
    expect(others(modelNoApiKeyError('E', sel, 'a', 'raw'))).toEqual(['B1']);
  });
  it('当前模型不在清单里:拿报错里那条线的名字去对组', () => {
    const sel = grouped('gone', [['a', [['a1', 'A1']]], ['b', [['b1', 'B1']]]]);
    expect(others(modelNoApiKeyError('E', sel, 'a', 'raw'))).toEqual(['B1']);
    expect(parseEngineModelNoApiKey(modelNoApiKeyError('E', sel, 'a', 'raw').message)?.model).toBeUndefined();
  });
  it('引擎不分组:分不出谁和它走同一条线,除当前模型外都列', () => {
    const sel = mapAcpConfigOptions([{ id: 'model', category: 'model', type: 'select', currentValue: 'a', options: [{ value: 'a', name: 'A' }, { value: 'b', name: 'B' }] }]);
    expect(others(modelNoApiKeyError('E', sel, 'whatever', 'raw'))).toEqual(['B']);
  });
  it('引擎根本没报模型选项:照样给出一句话,不叫人换模型', () => {
    const e = modelNoApiKeyError('E', mapAcpConfigOptions(undefined), 'r', 'raw');
    expect(e.message).toBe('engine_model_no_api_key: E needs an API key for its current model and none is set up. It offers no other model: sign in or add an API key in E itself, then send again. [raw]');
  });
});
