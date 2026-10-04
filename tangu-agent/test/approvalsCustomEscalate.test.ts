/**
 * H3 custom allow × 越界写升级(审批档重设计 2026-09-25 §3.4):从前 custom 的 allow 在越界升级**之前**就返回,
 * 裸 `allow: ["write_file"]` = 工作区外任意位置的写入一律静默放行。现在先算越界,allow 只有在规则带**绝对路径前缀**、
 * 且**全部**写目标经真实路径归一后都落在前缀之内时才能豁免升级;否则照问(reason=escalate)。deny / ask 语义不动。
 * 归一两侧同规(canonicalFuturePath = fsPolicy.realResolve 同一算法):tmpdir 在 macOS 是 /var → /private/var 的软链,
 * 规则写字面 /var 路径也得认;`../` 与前缀里指向外面的软链都逃不出去。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configureTangu } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { subscribe } from '../src/services/eventBus.js';
import { allowRuleCoversWrites, gateToolCall, resolveApproval } from '../src/services/approvals.js';

let home: string;
let ws: string;
let notes: string;
let other: string;

beforeEach(async () => {
  home = mkdtempSync(join(tmpdir(), 'tangu-h3-')); // 故意用字面 tmpdir(macOS 下是软链):两侧归一不对称就会假红
  process.env.TANGU_HOME = home;
  ws = join(home, 'ws');
  notes = join(home, 'notes');
  other = join(home, 'other');
  for (const d of [ws, notes, other]) mkdirSync(d, { recursive: true });
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'x', userId: 'u1' });
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: {} as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});

afterEach(() => {
  delete process.env.TANGU_HOME;
  try { rmSync(home, { recursive: true, force: true }); } catch { /* ignore */ }
});

const rules = (r: Record<string, unknown>): void =>
  writeFileSync(join(home, 'config.json'), JSON.stringify({ approval: { base: 'auto-edit', ...r } }));
const write = (p: string): any => ({ id: 'w', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: p, content: 'x' }) } });
const patch = (...files: string[]): any => ({
  id: 'p', type: 'function',
  function: { name: 'apply_patch', arguments: JSON.stringify({ patch: `*** Begin Patch\n${files.map((f) => `*** Add File: ${f}\n+x\n`).join('')}*** End Patch` }) },
});

let seq = 0;
async function gate(c: any, approvalMode: any = 'custom'): Promise<{ d: any; asked: any[] }> {
  const runId = `H3-${++seq}`;
  const asked: any[] = [];
  const off = subscribe(runId, (ev) => {
    if (ev.type !== 'approval_request') return;
    asked.push(ev.payload);
    resolveApproval(ev.payload.approvalId, { action: 'reject' });
  });
  try {
    return { d: await gateToolCall(runId, c, { sessionId: `s-${seq}`, execMode: 'host', approvalMode, cwd: ws }), asked };
  } finally { off(); }
}

describe('custom allow 不再静默豁免越界写', () => {
  it('裸 allow write_file + 工作区外写 → 照问(越界升级);从前直接放行', async () => {
    rules({ allow: ['write_file'] });
    const { d, asked } = await gate(write(join(notes, 'a.txt')));
    expect(asked.map((x) => x.reason)).toEqual([{ kind: 'escalate', mode: 'auto-edit' }]);
    // preview 也是 Muse 代批判官的输入(模型面)→ 英文;本地化的越界标签由客户端按 reason.kind 渲染(评审 #6)
    expect(asked[0].preview).toMatch(/^⚠ Write outside the workspace · /);
    expect(asked[0].preview).not.toMatch(/[一-鿿]/);
    expect(d).toEqual({ action: 'reject' });
  });

  it('对照:裸 allow + 工作区内写 → 照旧直接放(不问)', async () => {
    rules({ allow: ['write_file'], });
    expect(await gate(write(join(ws, 'a.txt')))).toEqual({ d: { action: 'approve' }, asked: [] });
    expect(await gate(write('sub/b.txt'))).toEqual({ d: { action: 'approve' }, asked: [] });
  });

  it('带绝对路径前缀的 allow + 目标在前缀内 → 豁免升级、不问(规则写字面 tmpdir 路径,两侧归一)', async () => {
    rules({ allow: [`write_file:${notes}/`] });
    expect(await gate(write(join(notes, 'a.txt')))).toEqual({ d: { action: 'approve' }, asked: [] });
    expect(await gate(write(join(notes, 'deep', 'new', 'b.txt')))).toEqual({ d: { action: 'approve' }, asked: [] }); // 尚不存在的子目录
  });

  it('`../` 字面上以前缀开头、实际逃出前缀 → 照问', async () => {
    rules({ allow: [`write_file:${notes}/`] });
    const { asked } = await gate(write(`${notes}/../other/x.txt`));
    expect(asked.map((x) => x.reason?.kind)).toEqual(['escalate']);
  });

  it('前缀里的软链指向外面 → 按真实路径判,照问', async () => {
    symlinkSync(other, join(notes, 'link'));
    rules({ allow: [`write_file:${notes}/`] });
    const { asked } = await gate(write(join(notes, 'link', 'x.txt')));
    expect(asked.map((x) => x.reason?.kind)).toEqual(['escalate']);
  });

  it('多目标 apply_patch:规则按首个目标命中,但只要有一个目标在前缀外就照问;全在内才放', async () => {
    rules({ allow: [`apply_patch:${notes}/`] });
    const mixed = await gate(patch(join(notes, 'a.txt'), join(other, 'b.txt')));
    expect(mixed.asked.map((x) => x.reason?.kind)).toEqual(['escalate']);
    expect(await gate(patch(join(notes, 'a.txt'), join(notes, 'b.txt')))).toEqual({ d: { action: 'approve' }, asked: [] });
  });

  it('前缀不是绝对路径 → 不豁免', async () => {
    rules({ allow: ['write_file:../notes/'] });
    const { asked } = await gate(write('../notes/a.txt'));
    expect(asked.map((x) => x.reason?.kind)).toEqual(['escalate']);
  });

  it('前缀按目录边界比,不按字符串前缀:notes 不覆盖 notes-evil', async () => {
    mkdirSync(`${notes}-evil`);
    rules({ allow: [`write_file:${notes}`] }); // 无尾斜杠:字面 startsWith 会命中 notes-evil
    const { asked } = await gate(write(`${notes}-evil/x.txt`));
    expect(asked.map((x) => x.reason?.kind)).toEqual(['escalate']);
  });

  it('deny / ask 语义不变;base=full-auto 本就不升级 → 裸 allow 照放', async () => {
    rules({ deny: [`write_file:${notes}/`] });
    expect((await gate(write(join(notes, 'a.txt')))).d).toEqual({ action: 'reject', rejectReason: `Denied by approval rule: write_file:${notes}/` });
    rules({ ask: [`write_file:${notes}/`] });
    expect((await gate(write(join(notes, 'a.txt')))).asked.map((x) => x.reason)).toEqual([{ kind: 'custom-ask', rule: `write_file:${notes}/`, mode: 'auto-edit' }]);
    rules({ base: 'full-auto', allow: ['write_file'] });
    expect(await gate(write(join(other, 'a.txt')))).toEqual({ d: { action: 'approve' }, asked: [] });
  });

  it('allowRuleCoversWrites:非写工具 / 无前缀 → false', () => {
    expect(allowRuleCoversWrites('run_bash:/usr/', { id: 'b', type: 'function', function: { name: 'run_bash', arguments: '{"command":"ls"}' } } as any, ws)).toBe(false);
    expect(allowRuleCoversWrites('write_file', write(join(notes, 'a.txt')), ws)).toBe(false);
    expect(allowRuleCoversWrites(`write_file:${notes}`, write(join(notes, 'a.txt')), ws)).toBe(true);
  });
});
