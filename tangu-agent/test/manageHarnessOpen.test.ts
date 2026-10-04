/** manage_harness 放开写入(10-04 用户裁决):常驻、不审批、立即生效、回执可渲染撤销卡;收紧的几道闸照旧。 */
import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
vi.mock('../src/services/agentFileSync.js', () => ({ scheduleAgentFilesSync: vi.fn() }));
import { configureTangu, deps } from '../src/seams/runtime.js';
import { createTanguProfile } from '../src/profiles/index.js';
import { createSqliteHost } from '../src/adapters/standalone/sqliteHost.js';
import { createLocalMemoryBrain } from '../src/adapters/standalone/localMemoryBrain.js';
import { runWithAgentSlug } from '../src/seams/runContext.js';
import { toSqliteDDL } from '../src/core/dialectDDL.js';
import { STANDALONE_SCHEMA } from '../src/db/schemaStandalone.js';
import { runMigration } from '../src/db/migrate.js';
import { manageHarnessProvider } from '../src/tools/builtin/manageHarness.js';
import { getToolDefinitions, listDeferredTools } from '../src/tools/registry.js';
import { declaredApproval, listLoadoutTools } from '../src/tools/toolRegistry.js';
import { toolNeedsApproval } from '../src/services/approvals.js';
import { harnessPath, loadHarness, peekHarnessCandidates } from '../src/agents/harnessStore.js';
import { scheduleAgentFilesSync } from '../src/services/agentFileSync.js';

let home: string, database: { close(): void };
const previousHome = process.env.TANGU_HOME;
const tool = manageHarnessProvider.tools()[0];
const base = { userId: 'owner', sessionId: 's1', appId: 'tangu', execMode: 'host' as const };
const call = (args: Record<string, unknown>, extra: Record<string, unknown> = {}, slug = 'opener') =>
  runWithAgentSlug(slug, async () => String(await tool.execute(args, { ...base, ...extra } as any)));

beforeAll(async () => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'tangu-harness-open-'))); process.env.TANGU_HOME = home;
  const { host, db } = createSqliteHost({ dataDir: join(home, 'db'), localToken: 'fixture', userId: 'owner' }); database = db;
  db.exec(toSqliteDDL(STANDALONE_SCHEMA));
  configureTangu({ host, brain: { memory: createLocalMemoryBrain({ deviceId: 'fixture' }) } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'none' }) });
  await runMigration();
});
afterAll(() => {
  database?.close(); rmSync(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = previousHome;
});

describe('manage_harness 放开写入', () => {
  it('work 面常驻(不用先 load_tools);coding 面保持按需;云端 sandbox 不暴露', () => {
    const ctx = { ...base, profile: deps().profile };
    const visible = (extra = {}) => getToolDefinitions({ ...ctx, ...extra } as any).map((t) => t.function.name);
    const catalog = (extra = {}) => listDeferredTools({ ...ctx, ...extra } as any).map((t) => t.name);
    expect(visible()).toContain('manage_harness');
    expect(catalog()).not.toContain('manage_harness');
    expect(visible({ preset: 'coding' })).not.toContain('manage_harness');
    expect(catalog({ preset: 'coding' })).toContain('manage_harness');
    expect(visible({ execMode: 'sandbox' })).not.toContain('manage_harness');
  });

  it('收紧的闸照旧:临时成员 / 计划模式 / 子代理 / 用户按 agent 关掉 → 不可见', () => {
    const ctx = { ...base, profile: deps().profile };
    const visible = (extra = {}) => getToolDefinitions({ ...ctx, ...extra } as any).map((t) => t.function.name);
    for (const extra of [{ ephemeral: true }, { planMode: true }, { subAgentDepth: 1 }, { toolsMode: 'deny' as const, toolsList: ['manage_harness'] }, { toolsMode: 'allow' as const, toolsList: ['read_file'] }]) {
      expect(visible(extra), JSON.stringify(extra)).not.toContain('manage_harness');
    }
    // 父代理点名授予的子代理仍可用(既有的 grantTools 口子,不因加了门禁函数而关掉)
    expect(visible({ subAgentDepth: 1, subAgentGrants: new Set(['manage_harness']) })).toContain('manage_harness');
    // 加了 isEnabledFor 之后它成了「门禁工具」:必须仍在用户可勾选的工具名单里(LOADOUT_GATED),否则上面的 deny / allow 断言是假绿
    expect(listLoadoutTools().map((t) => t.name)).toContain('manage_harness');
  });

  it('任何审批档下都不再逐笔审批', () => {
    expect(declaredApproval('manage_harness')).toBeUndefined();
    for (const mode of ['readonly', 'auto-edit', 'full-auto'] as const) expect(toolNeedsApproval('manage_harness', mode)).toBe(false);
  });

  it('写入立即落盘,回执是可渲染撤销卡的 JSON(新建 / 修订 / 删除 / 回滚)', async () => {
    const created = JSON.parse(await call({ action: 'upsert', title: 'Run the tests first', body: 'Run the suite before saying a fix is done.', evidence: 'Corrected twice on 10-04.' }));
    expect(created.kind).toBe('harness_update');
    expect(created.change).toMatchObject({ agent: 'opener', action: 'create', kind: 'note', title: 'Run the tests first', version: 1 });
    expect(created.change.rev).toMatch(/^[0-9a-f-]{36}$/);
    expect(created.message).toMatch(/Applied immediately/);
    expect(readFileSync(harnessPath('opener'), 'utf8')).toContain('Run the suite before saying a fix is done.');
    expect(scheduleAgentFilesSync).toHaveBeenCalledWith('owner', 'opener'); // 不带 slug 的调用是空操作(Codex 10-04):同步按 agent 排队
    const id = created.change.entryId;

    const revised = JSON.parse(await call({ action: 'upsert', id, body: 'Run the suite and read the output before saying a fix is done.' }));
    expect(revised.change).toMatchObject({ entryId: id, action: 'revise', version: 2 });
    expect(revised.change.rev).not.toBe(created.change.rev);

    const deleted = JSON.parse(await call({ action: 'delete', id }));
    expect(deleted.change).toMatchObject({ entryId: id, action: 'delete', title: 'Run the tests first' }); // 条目已不在:卡片靠回执说明删的是什么
    expect(await loadHarness('opener')).toEqual([]);

    const restored = JSON.parse(await call({ action: 'rollback', id }));
    expect(restored.change).toMatchObject({ entryId: id, action: 'rollback', version: 2 });
    expect((await loadHarness('opener')).map((e) => e.id)).toEqual([id]);
  });

  it('校验不过 / 临时成员 / 远程写 → Error 开头的英文说明,不落盘', async () => {
    expect(await call({ action: 'upsert', title: 'T', body: 'B' }, {}, 'strict')).toMatch(/^Error: a new entry needs evidence/);
    expect(await call({ action: 'upsert', title: 'T', body: 'B', evidence: 'E' }, { ephemeral: true }, 'strict')).toMatch(/^Error:/);
    expect(await call({ action: 'upsert', title: 'T', body: 'B', evidence: 'E' }, { remote: { marked: true } }, 'strict')).toMatch(/^Error:/);
    expect(await call({ action: 'list' }, { remote: { marked: true } }, 'strict')).toBe('(working notes are empty)');
    // 给自己提名:指回 upsert(候选收件箱只在 /refine 时才被读,给自己提名等于什么都没做)
    expect(await call({ action: 'propose', agent: 'strict', candidates: ['shelve x'] }, {}, 'strict')).toMatch(/^Error: propose is for ANOTHER agent/);
    expect(await loadHarness('strict')).toEqual([]);
  });

  it('propose:一整条装备建议原样进对方候选收件箱(不截断);超长报错、不落半条', async () => {
    // 8 工具 + 8 技能带次数 ≈ 500 字。原先 300 字静默截断,正好切在技能名中间,对方复盘时以「信息不完整」为由一项没采纳。
    const names = Array.from({ length: 8 }, (_, i) => `tool_number_${i} (1.${i} KB)`).join(', ');
    const skills = Array.from({ length: 8 }, (_, i) => `local:some-long-skill-name-${i}`).join(', ');
    const line = `Usage review, 24 runs in 30 days: shelve never-called tools ${names}; never-loaded skills ${skills}.`;
    expect(line.length).toBeGreaterThan(300);
    expect(await call({ action: 'propose', agent: 'xyra', candidates: [line] })).toMatch(/^Proposed 1 candidate/);
    const inbox = await peekHarnessCandidates('xyra');
    expect(inbox).toHaveLength(1);
    expect(inbox[0].endsWith(`(proposed by opener) ${line}`)).toBe(true);
    expect(await call({ action: 'propose', agent: 'xyra', candidates: ['x'.repeat(1001)] })).toMatch(/^Error: a candidate is 1001 characters; keep each within 1000/);
    expect(await peekHarnessCandidates('xyra')).toHaveLength(1);
  });
});
