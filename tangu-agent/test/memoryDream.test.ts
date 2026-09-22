import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as realDelay } from 'node:timers/promises';
import { createMemoryRepository } from '../src/services/memoryRepository.js';
import { appendCandidates, readCandidates } from '../src/services/memoryCandidates.js';
import { getMemoryDream, startMemoryDream, configureMemoryDream, cancelMemoryDream, validateDreamProposal, resetMemoryDreamForTests } from '../src/services/memoryDream.js';
import { currentAgentSlug } from '../src/seams/runContext.js';
import { configureTangu } from '../src/seams/runtime.js';
import { deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';

let home: string;
let oldHome: string | undefined;
let db: ReturnType<typeof createSqliteHost>['db'];
let calls: any[];
let provider: (payload: any, signal: AbortSignal) => Promise<any>;
const repo = (slug = 'alpha') => createMemoryRepository(join(home, 'agents', slug));
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const result = (content: unknown) => ({ content: JSON.stringify(content), toolCalls: [], usage: { prompt_tokens: 10, completion_tokens: 10 } });
const proposal = (sources: any[]) => ({ groups: sources.map((s) => ({ fact: s.fact, sourceIds: [s.id] })), discarded: [] });
async function settle(slug = 'alpha') {
  for (let i = 0; i < 400 && getMemoryDream(slug).status.running; i++) await realDelay(5);
  expect(getMemoryDream(slug).status.running).toBe(false);
  return getMemoryDream(slug).status;
}
function seedCandidate(slug = 'alpha', fact = '用户偏好中文回复', sid = `session-${slug}`) {
  db.prepare('INSERT OR IGNORE INTO chat_sessions (id,user_id,app_id,title,agent_config) VALUES (?,?,?,?,?)').run(sid, 'u', 'tangu', 'test', JSON.stringify({ agentSlug: slug }));
  db.prepare('INSERT OR REPLACE INTO chat_messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)').run(`m-${sid}`, sid, 'user', fact, 1);
  appendCandidates(slug, sid, [fact], { anchorMessageId: `m-${sid}` });
}

beforeEach(() => {
  oldHome = process.env.TANGU_HOME;
  home = mkdtempSync(join(tmpdir(), 'tangu-dream-regression-'));
  process.env.TANGU_HOME = home;
  const sqlite = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u' });
  db = sqlite.db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  calls = [];
  provider = async (payload) => payload.messages[0].content.startsWith('Consolidate')
    ? result(proposal(JSON.parse(payload.messages[1].content))) : result({ ok: true });
  configureTangu({ host: sqlite.host, profile: createTanguProfile({ sandboxMode: 'none' }), billing: { calculateCost: async () => 0, logApiUsage: async () => {} } as any,
    brain: { memory: {
      getMemorySnapshot: async () => repo(currentAgentSlug()).snapshot(),
      commitMemory: async (_u: string, input: any) => repo(currentAgentSlug()).commit(input),
    }, llm: {
      resolveModelAndKey: async () => ({ model: { name: 'test', provider: 'test' }, apiKey: 'test', baseUrl: '', apiModelId: 'test' }),
      buildProviderPayload: async (p: any) => p,
      streamProviderCompletion: async (p: any) => { calls.push(p); return provider(p.payload, p.signal); },
    } } as any });
  configureMemoryDream('alpha', { modelId: 'test-model' });
  configureMemoryDream('beta', { modelId: 'test-model' });
});
afterEach(() => {
  resetMemoryDreamForTests(); vi.useRealTimers(); db.close();
  if (oldHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = oldHome;
  rmSync(home, { recursive: true, force: true });
});

describe('Agent-private, bounded Dream memory', () => {
  it('is on by default: an automatic run consolidates without anyone opting in', async () => {
    repo().add('已有事实'); seedCandidate();
    expect(getMemoryDream('alpha').config.enabled).toBe(true);
    expect(startMemoryDream('u', 'alpha', { automatic: true }).running).toBe(true);
    expect((await settle()).state).toBe('completed');
    expect(readCandidates('alpha')).toHaveLength(0);
  });
  it('an explicit opt-out sticks: automatic mode does no provider work', async () => {
    repo().add('已有事实'); seedCandidate();
    configureMemoryDream('alpha', { enabled: false });
    expect(startMemoryDream('u', 'alpha', { automatic: true }).running).toBe(false);
    await tick(); expect(calls).toHaveLength(0); expect(readCandidates('alpha')).toHaveLength(1);
    expect(getMemoryDream('alpha').config.enabled).toBe(false); // survives re-reads: the file now carries v: 2
  });
  it('a pre-default-on file reads as enabled: its `enabled: false` was the old default written as a side effect, never a choice', async () => {
    writeFileSync(join(home, 'agents', 'alpha', '.memory-dream.json'), JSON.stringify({ config: { enabled: false, modelId: 'test-model', timeoutMs: 60000, maxOutputTokens: 4096, intervalHours: 6 }, last: { state: 'cancelled', running: false } }));
    expect(getMemoryDream('alpha').config.enabled).toBe(true);
    configureMemoryDream('alpha', { enabled: false }); // the first explicit choice after the upgrade is kept
    expect(getMemoryDream('alpha').config.enabled).toBe(false);
  });
  it('an automatic run with no new candidate and an unchanged memory version does no provider work', async () => {
    repo().add('已有事实'); seedCandidate();
    startMemoryDream('u', 'alpha', { automatic: true }); expect((await settle()).state).toBe('completed');
    const spent = calls.length;
    configureMemoryDream('alpha', { intervalHours: 1 });
    vi.useFakeTimers({ now: Date.now() + 2 * 3_600_000, toFake: ['Date'] });
    startMemoryDream('u', 'alpha', { automatic: true });
    const status = await settle();
    expect(status.state).toBe('skipped'); expect(calls).toHaveLength(spent);
    // 手动整理不受这道闸管:用户点「立即整理」就是要它跑。
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed'); expect(calls.length).toBeGreaterThan(spent);
  });
  it('verifies complete source coverage, commits a revision and consumes only its Agent inbox', async () => {
    const old = repo().add('已有事实'); seedCandidate(); seedCandidate('beta', 'Beta 私有秘密');
    startMemoryDream('u', 'alpha');
    expect((await settle()).state).toBe('completed');
    const next = repo().snapshot();
    expect(next.content).toContain('已有事实'); expect(next.content).toContain('用户偏好中文回复');
    expect(next.version).not.toBe(old.version); expect(next.entries.find((e) => e.content.includes('中文'))?.evidenceIds[0]).toMatch(/^candidate:/);
    expect(readCandidates('alpha')).toHaveLength(0); expect(readCandidates('beta')).toHaveLength(1);
    expect(JSON.stringify(calls)).not.toContain('Beta 私有秘密'); expect(calls).toHaveLength(2);
    expect(calls.reduce((n, c) => n + c.payload.maxTokens, 0)).toBe(4096);
  });
  it('rejects source omission, alien IDs, duplicate coverage, canonical deletion and unsupported candidate promotion', () => {
    const sources: any[] = [{ id: 'a', kind: 'memory', fact: 'A' }, { id: 'c', kind: 'candidate', fact: 'C' }];
    for (const p of [
      { groups: [{ fact: 'A', sourceIds: ['a'] }], discarded: [] },
      { groups: [{ fact: 'A', sourceIds: ['other-agent'] }], discarded: [] },
      { groups: [{ fact: 'A', sourceIds: ['a','a'] }], discarded: [] },
      { groups: [], discarded: [{ sourceId: 'a', reason: 'delete' }, { sourceId: 'c', reason: 'noise' }] },
      proposal(sources),
    ]) expect(() => validateDreamProposal(p, sources)).toThrow();
  });
  it('retains original memory and raw candidates on verifier rejection', async () => {
    const old = repo().add('一个必须保留的旧事实'); seedCandidate();
    provider = async (p) => p.messages[0].content.startsWith('Consolidate') ? result(proposal(JSON.parse(p.messages[1].content))) : result({ ok: false, reason: 'unsupported assertion' });
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('failed');
    expect(repo().snapshot()).toEqual(old); expect(readCandidates('alpha')).toHaveLength(1);
  });
  it('refuses normal-stop oversized output instead of silently slicing away durable tail facts', async () => {
    repo().add('DURABLE_TAIL_FACT'); seedCandidate();
    const old = repo().snapshot();
    provider = async (p) => {
      const sources = JSON.parse(p.messages[1].content);
      return result({ groups: sources.map((s: any) => ({ fact: '长'.repeat(22_000), sourceIds: [s.id] })), discarded: [] });
    };
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('failed');
    expect(repo().snapshot()).toEqual(old); expect(readCandidates('alpha')).toHaveLength(1); expect(calls).toHaveLength(1);
  });
  it('rejects token-truncated JSON even if it otherwise parses', async () => {
    repo().add('旧事实'); seedCandidate();
    provider = async (p) => ({ ...result(proposal(JSON.parse(p.messages[1].content))), finishReason: 'length' });
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('failed');
    expect(readCandidates('alpha')).toHaveLength(1);
  });
  it('uses version CAS so a concurrent explicit correction survives', async () => {
    const old = repo().add('旧事实'); seedCandidate();
    provider = async (p) => {
      if (p.messages[0].content.startsWith('Consolidate')) return result(proposal(JSON.parse(p.messages[1].content)));
      repo().update(old.entries[0].id, '用户刚刚纠正的新事实');
      return result({ ok: true });
    };
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('failed');
    expect(repo().snapshot().content).toContain('用户刚刚纠正的新事实'); expect(repo().snapshot().content).not.toContain('旧事实');
    expect(readCandidates('alpha')).toHaveLength(1);
  });
  it('cancels without late writes and does not start another same-Agent provider while cancellation is pending', async () => {
    repo().add('旧事实'); seedCandidate(); const old = repo().snapshot();
    let release!: (value: any) => void;
    provider = () => new Promise((resolve) => { release = resolve; });
    startMemoryDream('u', 'alpha');
    for (let i = 0; i < 20 && !release; i++) await tick();
    cancelMemoryDream('alpha'); expect(getMemoryDream('alpha').status.running).toBe(true);
    startMemoryDream('u', 'alpha'); expect(calls).toHaveLength(1);
    release(result({ groups: [], discarded: [] }));
    expect((await settle()).state).toBe('cancelled'); expect(repo().snapshot()).toEqual(old); expect(readCandidates('alpha')).toHaveLength(1);
  });
  it('aborts the actual provider signal at the overall deadline and retains data', async () => {
    repo().add('旧事实'); seedCandidate(); configureMemoryDream('alpha', { timeoutMs: 5000 });
    vi.useFakeTimers({ toFake: ['setTimeout','clearTimeout','Date'] });
    let observed: AbortSignal | undefined;
    provider = (_p, signal) => new Promise((_resolve, reject) => { observed = signal; signal.addEventListener('abort', () => reject(signal.reason), { once: true }); });
    startMemoryDream('u', 'alpha');
    for (let i = 0; i < 20 && !observed; i++) await tick();
    await vi.advanceTimersByTimeAsync(5001);
    expect(observed?.aborted).toBe(true); expect((await settle()).state).toBe('cancelled'); expect(readCandidates('alpha')).toHaveLength(1);
  });
  it('does not accept a candidate whose referenced session belongs to another Agent', async () => {
    repo().add('Alpha 事实'); seedCandidate('beta', 'Beta 私有秘密');
    appendCandidates('alpha', 'session-beta', ['Beta 私有秘密']);
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    const sources = JSON.parse(calls[0].payload.messages[1].content);
    expect(sources.some((s: any) => s.kind === 'candidate')).toBe(false);
    expect(JSON.stringify(calls)).not.toContain('Beta 私有秘密');
    expect(getMemoryDream('alpha').status.detail).toContain('pending source review');
    expect(repo().snapshot().content).not.toContain('Beta'); expect(readCandidates('alpha')).toHaveLength(1);
  });
  it('retains new candidates appended while the verified batch is in flight', async () => {
    repo().add('已有事实'); seedCandidate();
    provider = async (p) => {
      if (p.messages[0].content.startsWith('Consolidate')) return result(proposal(JSON.parse(p.messages[1].content)));
      appendCandidates('alpha', 'session-alpha', ['期间追加的新事实']); return result({ ok: true });
    };
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    expect(readCandidates('alpha').map((c) => c.text)).toEqual(['期间追加的新事实']);
  });
  it('reports a durable commit as completed even when cancellation arrives in the commit response gap', async () => {
    repo().add('已有事实'); seedCandidate();
    const original = deps().brain.memory.commitMemory!;
    deps().brain.memory.commitMemory = async (...args) => {
      const committed = await original(...args); cancelMemoryDream('alpha'); return committed;
    };
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    expect(repo().snapshot().content).toContain('用户偏好中文回复'); expect(readCandidates('alpha')).toHaveLength(0);
  });
  it('recovers already-committed candidate cleanup before proposing another batch, including discarded candidates', async () => {
    repo().add('已有事实'); seedCandidate();
    const candidateId = readCandidates('alpha')[0].id;
    const snapshot = repo().snapshot();
    repo().commit({ expectedVersion: snapshot.version, content: snapshot.content, source: { kind: 'dream' }, consumedCandidateIds: [candidateId] });
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    expect(readCandidates('alpha')).toHaveLength(0);
    expect(JSON.parse(calls[0].payload.messages[1].content).every((s: any) => s.kind === 'memory')).toBe(true);
  });
  it('an explicitly forgotten raw fact cannot be rephrased back into memory by a fresh Dream', async () => {
    const existing = repo().add('用户偏好中文回复'); seedCandidate();
    repo().forget(existing.entries[0].id);
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('skipped');
    expect(repo().snapshot().content).toBe('');
    expect(readCandidates('alpha')).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  it('keeps the collection-time source window after the original statement scrolls out of recent messages', async () => {
    const original = '长期偏好：无糖绿茶，而且晚间不喝咖啡';
    seedCandidate('alpha', original);
    for (let n = 0; n < 40; n++) db.prepare('INSERT INTO chat_messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)').run(`later-${n}`, 'session-alpha', 'user', `later unrelated chat ${n}`, n + 2);
    expect(readCandidates('alpha')[0].anchorMessageId).toBe('m-session-alpha');
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    const sources = JSON.parse(calls[0].payload.messages[1].content);
    expect(sources[0].evidence).toContain(original);
    expect(sources[0].evidence).not.toContain('later unrelated chat');
    const entry = repo().snapshot().entries.find(e => e.content.includes('无糖绿茶'))!;
    expect(entry.evidenceIds).toEqual(expect.arrayContaining(['source:session:session-alpha', 'source:message:m-session-alpha']));
    expect(readCandidates('alpha')).toHaveLength(0);
  });

  it('retains candidates whose anchor is missing or belongs to another session without exposing or consuming them', async () => {
    seedCandidate('beta', 'Do not read this other Agent private content');
    db.prepare('INSERT INTO chat_sessions (id,user_id,app_id,title,agent_config) VALUES (?,?,?,?,?)').run('session-alpha', 'u', 'tangu', 'fixture', JSON.stringify({ agentSlug: 'alpha' }));
    appendCandidates('alpha', 'session-alpha', ['needs source verification'], { anchorMessageId: 'm-session-beta' });
    appendCandidates('alpha', 'session-alpha', ['source was deleted'], { anchorMessageId: 'deleted-message' });
    startMemoryDream('u', 'alpha'); const status = await settle();
    expect(status.state).toBe('skipped'); expect(status.detail).toContain('retained for source review');
    expect(calls).toHaveLength(0); expect(repo().snapshot().entries).toEqual([]); expect(readCandidates('alpha')).toHaveLength(2);
  });

  it('keeps unchanged facts by id: the proposal carries only what changed, kept facts stay first in stored order', async () => {
    repo().add('事实甲'); repo().add('事实乙'); seedCandidate();
    provider = async (p) => {
      if (!p.messages[0].content.startsWith('Consolidate')) return result({ ok: true });
      const sources = JSON.parse(p.messages[1].content);
      return result({ keep: sources.filter((s: any) => s.kind === 'memory').map((s: any) => s.id), groups: sources.filter((s: any) => s.kind === 'candidate').map((s: any) => ({ fact: s.fact, sourceIds: [s.id] })), discarded: [] });
    };
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    expect(repo().snapshot().content).toBe('- 事实甲\n- 事实乙\n- 用户偏好中文回复');
    expect(calls[0].payload.messages[0].content).toContain('"keep"');
    // 模型看到的是短别名(UUID 一个 ~25 token,几百个 keep 就撑爆输出预算);核验只拿 keep 的 id + 改动组,原文不重复灌一遍。
    expect(JSON.parse(calls[0].payload.messages[1].content).map((s: any) => s.id)).toEqual(['m1', 'm2', 'c1']);
    const verify = JSON.parse(calls[1].payload.messages[1].content);
    expect(verify.proposal).toEqual({ keep: ['m1', 'm2'], groups: [{ fact: '用户偏好中文回复', sourceIds: ['c1'] }], discarded: [] });
    expect((calls[1].payload.messages[1].content.match(/事实甲/g) || []).length).toBe(1);
    expect(calls[1].payload.messages[0].content).toContain('preserved verbatim');
    expect(readCandidates('alpha')).toHaveLength(0);
  });
  it('rejects keeping a candidate, or keeping and re-emitting the same fact', () => {
    const sources: any[] = [{ id: 'a', kind: 'memory', fact: 'A' }, { id: 'c', kind: 'candidate', fact: 'C', evidence: 'user: C' }];
    expect(() => validateDreamProposal({ keep: ['c'], groups: [{ fact: 'A', sourceIds: ['a'] }], discarded: [] }, sources)).toThrow(/kept verbatim/);
    expect(() => validateDreamProposal({ keep: ['a'], groups: [{ fact: 'A', sourceIds: ['a'] }, { fact: 'C', sourceIds: ['c'] }], discarded: [] }, sources)).toThrow();
    expect(validateDreamProposal({ keep: ['a'], groups: [{ fact: 'C', sourceIds: ['c'] }], discarded: [] }, sources).groups).toEqual([{ fact: 'A', sourceIds: ['a'] }, { fact: 'C', sourceIds: ['c'] }]);
  });
  const bigMemory = (lines: number, width = 950) => {
    const snap = repo().snapshot();
    repo().commit({ expectedVersion: snap.version, content: Array.from({ length: lines }, (_, i) => `- ${String(i).padStart(3, '0')}${'长'.repeat(width)}`).join('\n'), source: { kind: 'sync' } });
  };
  const seedWindow = (sid: string, fact: string) => {
    db.prepare('INSERT OR IGNORE INTO chat_sessions (id,user_id,app_id,title,agent_config) VALUES (?,?,?,?,?)').run(sid, 'u', 'tangu', 'test', JSON.stringify({ agentSlug: 'alpha' }));
    // 填充要像自然语言:redactSecrets 会把长串字母数字当密钥打成 [REDACTED],证据就缩没了。
    for (let n = 0; n < 20; n++) db.prepare('INSERT INTO chat_messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)').run(`${sid}-fill-${n}`, sid, 'user', `filler ${n} ${'lorem ipsum dolor sit amet '.repeat(22)}`, n + 1);
    db.prepare('INSERT INTO chat_messages (id,session_id,role,content,timestamp) VALUES (?,?,?,?,?)').run(`${sid}-anchor`, sid, 'user', fact, 100);
    appendCandidates('alpha', sid, [fact], { anchorMessageId: `${sid}-anchor` });
  };
  it('fits candidate evidence to the input budget instead of failing: the 09-22 export shape (17k memory + several 8k windows)', async () => {
    // 从前 12 条 × 8k 证据不看余量:21k 记忆 + 3 × 8k = 45k → failed/calls 0,每 6 小时原样重演、收件箱永不排空。
    bigMemory(58, 295);
    seedWindow('sess-one', '长期偏好：无糖绿茶'); seedWindow('sess-two', '长期偏好：晚间不喝咖啡'); seedWindow('sess-three', '长期偏好：周三不开会');
    startMemoryDream('u', 'alpha'); const status = await settle();
    const input = calls[0].payload.messages[1].content;
    expect(status.state).toBe('completed'); expect(status.detail).toContain('1 deferred by the input budget');
    expect(input.length).toBeLessThanOrEqual(32_000);
    const cands = JSON.parse(input).filter((s: any) => s.kind === 'candidate');
    expect(cands.map((c: any) => c.fact)).toEqual(['长期偏好：无糖绿茶', '长期偏好：晚间不喝咖啡']);
    expect(cands[0].evidence.length).toBe(8_000); // 第一条余量充足,原窗照发
    expect(cands[1].evidence.length).toBeLessThan(8_000); expect(cands[1].evidence.length).toBeGreaterThanOrEqual(1_000);
    expect(cands[1].evidence).toContain('长期偏好：晚间不喝咖啡'); // 裁的是头:锚点消息在窗口末尾
    const content = repo().snapshot().content;
    expect(content).toContain('无糖绿茶'); expect(content).toContain('晚间不喝咖啡'); expect(content).not.toContain('周三不开会');
    expect(readCandidates('alpha').map((c) => c.text)).toEqual(['长期偏好：周三不开会']);
    expect(status.candidateCursor).toBe(readCandidates('alpha')[0].id); // 游标越过被推迟的第三条:它转到队尾,而不是每轮堵在最前
    // 下一轮轮转回到被推迟的那条
    calls = [];
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    expect(repo().snapshot().content).toContain('周三不开会'); expect(readCandidates('alpha')).toHaveLength(0);
  });
  it('a candidate that cannot fit even the evidence floor is skipped, not a wall: a shorter one behind it still lands', async () => {
    // Codex 评审 09-22:从前塞不下就 break,游标停在它前面,后面本来塞得下的短候选永远轮不到。
    bigMemory(385, 40); // 别名空间 JSON ≈ 31.6k → 余量只剩几百字
    seedWindow('sess-big', '长期偏好：无糖绿茶'); seedCandidate();
    const ids = readCandidates('alpha').map((c) => c.id);
    // 385 条既有事实靠 keep 引用(逐条重发会撞校验器 250 组上限——真模型按提示词也该这么答)。
    provider = async (p) => {
      if (!p.messages[0].content.startsWith('Consolidate')) return result({ ok: true });
      const sources = JSON.parse(p.messages[1].content);
      return result({ keep: sources.filter((s: any) => s.kind === 'memory').map((s: any) => s.id), groups: sources.filter((s: any) => s.kind === 'candidate').map((s: any) => ({ fact: s.fact, sourceIds: [s.id] })), discarded: [] });
    };
    startMemoryDream('u', 'alpha'); const status = await settle();
    expect(status.state).toBe('completed'); expect(status.detail).toContain('1 deferred by the input budget');
    const input = calls[0].payload.messages[1].content;
    expect(input.length).toBeLessThanOrEqual(32_000);
    expect(JSON.parse(input).filter((s: any) => s.kind === 'candidate').map((s: any) => s.fact)).toEqual(['用户偏好中文回复']);
    expect(repo().snapshot().content).toContain('用户偏好中文回复');
    expect(readCandidates('alpha').map((c) => c.text)).toEqual(['长期偏好：无糖绿茶']);
    expect(status.candidateCursor).toBe(ids[1]);
  });
  it('treats a candidate whose source lookup throws as unverifiable: the run goes on and the cursor moves past it', async () => {
    // 旧代码游标在循环前就越过整批,抛错的候选下一轮不再排头;按余量裁证据后游标只越过已处理的,抛错若不吞就会让同一条毒候选每轮排第一、Dream 永远 failed。
    repo().add('已有事实');
    db.prepare('INSERT INTO chat_sessions (id,user_id,app_id,title,agent_config) VALUES (?,?,?,?,?)').run('session-poison', 'u', 'tangu', 'poison', 'not json');
    appendCandidates('alpha', 'session-poison', ['poison candidate'], { anchorMessageId: 'm-none' });
    seedCandidate();
    const ids = readCandidates('alpha').map((c) => c.id);
    startMemoryDream('u', 'alpha'); const status = await settle();
    expect(status.state).toBe('completed'); expect(status.detail).toContain('pending source review');
    expect(repo().snapshot().content).toContain('用户偏好中文回复');
    expect(readCandidates('alpha').map((c) => c.text)).toEqual(['poison candidate']);
    expect(status.candidateCursor).toBe(ids[1]);
  });
  it('fails fast with a clear detail when existing memory alone exceeds the input budget', async () => {
    bigMemory(40); seedCandidate();
    startMemoryDream('u', 'alpha'); const status = await settle();
    expect(status.state).toBe('failed'); expect(status.detail).toContain('input budget');
    expect(calls).toHaveLength(0); expect(readCandidates('alpha')).toHaveLength(1);
  });

  it('rotates the bounded source window so an unverifiable head does not starve later valid facts', async () => {
    appendCandidates('alpha', 'missing-session', Array.from({ length: 12 }, (_, n) => `unverifiable pending ${n}`));
    seedCandidate('alpha', 'valid fact behind pending candidates');
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('skipped');
    expect(calls).toHaveLength(0);
    startMemoryDream('u', 'alpha'); expect((await settle()).state).toBe('completed');
    expect(repo().snapshot().content).toContain('valid fact behind pending candidates');
    expect(readCandidates('alpha')).toHaveLength(12);
    expect(calls).toHaveLength(2);
  });
});
