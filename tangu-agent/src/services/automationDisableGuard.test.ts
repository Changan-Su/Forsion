/**
 * 「谁能松开停用刹车」的回归(H1/H2,第三轮加的加固 —— 第四轮补齐断言)。
 *
 * 背景:第三轮加了 `disabledBy` + `actor`,但引擎侧**一条断言都没有**(全仓 grep `disabledBy` / `actor:` 零命中),
 * 「1274 用例全绿」对它们不构成任何证据;而验证者用探针实证了两个真洞:
 *   · 升级前被引擎停用的存量规则(disabledReason 有值、disabledBy 缺席)被插件 ensure 的幂等重放开回来(P1-2)。
 *   · 缺 actor 的调用默认放行 —— 那是**刻意**的(见 UpsertActor 注释),但从前没有用例把这个默认钉住。
 * 落盘走真 TANGU_HOME(upsertTrigger / disableTriggers 都是整文件读-改-写,mock 掉就等于不测)。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MuseTrigger, ValidatedTrigger } from './museTriggers.js';

let home = '';
beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-disable-guard-'));
  process.env.TANGU_HOME = home;
});
afterAll(async () => {
  await fs.rm(home, { recursive: true, force: true });
  delete process.env.TANGU_HOME;
});

const mod = () => import('./museTriggers.js');

/** 直接写 triggers.json 造存量形状 —— 存量数据本来就不是通过今天的写入口产生的,用写入口造等于造不出来。 */
async function seed(list: MuseTrigger[]): Promise<void> {
  const { triggersFile } = await mod();
  await fs.mkdir(path.dirname(triggersFile()), { recursive: true });
  await fs.writeFile(triggersFile(), JSON.stringify(list, null, 2), 'utf8');
}
async function read(id: string): Promise<MuseTrigger | undefined> {
  const { loadTriggers } = await mod();
  return (await loadTriggers()).find((t) => t.id === id);
}
const base = (over: Partial<MuseTrigger> = {}): MuseTrigger => ({
  id: 'plugin:erp:ring', desc: '出库联动', cond: { type: 'event_seen', match: 'x' },
  cooldownHours: 0, lastFiredAt: null, enabled: true, createdAt: '2026-08-01T00:00:00.000Z',
  actions: [{ type: 'notify', title: 'n' }], ...over,
});
/** 插件 ensure 每次 setup 重发的那份 payload(逐字同 buildPluginTriggerUpsert:永远 enabled:true)。 */
const ensurePayload = (): ValidatedTrigger => ({
  desc: '出库联动', cond: { type: 'event_seen', match: 'x' }, prompt: undefined,
  cooldownHours: 0, agentSlug: undefined, enabled: true,
  actions: [{ type: 'notify', title: 'n' }],
});

beforeEach(async () => { await fs.rm(path.join(home, 'agents'), { recursive: true, force: true }); });

describe('H1 blockedEnable:插件 ensure 的幂等重放不许松开引擎/用户拉下的刹车', () => {
  const ID = 'plugin:erp:ring';

  it('★ P1-2 存量形状(disabledReason 有值、disabledBy 缺席 = 升级前引擎停用)不许被重放开回来', async () => {
    const { upsertTrigger } = await mod();
    await seed([base({ enabled: false, disabledReason: '自动化环:20 轮内持续有 db 写入,已停用规则 …' })]);
    const r = await upsertTrigger(ensurePayload(), ID, { allowPluginCreate: true, actor: 'plugin-ensure' });
    expect(r.ok).toBe(true);
    const cur = (await read(ID))!;
    expect(cur.enabled).toBe(false);                       // ★ 刹车还在
    expect(cur.disabledReason).toContain('自动化环');       // ★ 证据没被抹掉
  });

  it('disabledBy=engine / user 同样挡住;desc 等配置照常更新(挡的是「开回来」,不是「改规则」)', async () => {
    const { upsertTrigger } = await mod();
    for (const by of ['engine', 'user'] as const) {
      await seed([base({ enabled: false, disabledBy: by, disabledReason: `${by} 关的` })]);
      await upsertTrigger({ ...ensurePayload(), desc: '改过的描述' }, ID, { allowPluginCreate: true, actor: 'plugin-ensure' });
      const cur = (await read(ID))!;
      expect([by, cur.enabled, cur.disabledBy, cur.desc]).toEqual([by, false, by, '改过的描述']);
    }
  });

  it('「没人认领」(disabledBy 与 disabledReason 都缺席 = pluginStore 禁用插件时逐条关的)照旧被重放开回来', async () => {
    const { upsertTrigger } = await mod();
    await seed([base({ enabled: false })]);
    await upsertTrigger(ensurePayload(), ID, { allowPluginCreate: true, actor: 'plugin-ensure' });
    expect((await read(ID))!.enabled).toBe(true); // 这条生命周期不能断:用户重新启用插件 → setup 再 ensure → 规则复活
  });

  it('actor=user(面板/构建器/manage_automation 的显式启用)能松开 engine 刹车,并把原因与来源一并作废', async () => {
    const { upsertTrigger } = await mod();
    await seed([base({ enabled: false, disabledBy: 'engine', disabledReason: '自动化环 …' })]);
    await upsertTrigger(ensurePayload(), ID, { actor: 'user' });
    const cur = (await read(ID))!;
    expect([cur.enabled, cur.disabledReason, cur.disabledBy]).toEqual([true, undefined, undefined]);
  });

  it('缺 actor(老客户端)**刻意默认放行** —— 这个默认值本身要被钉住:默认冻死会断掉插件复活那条生命周期', async () => {
    const { upsertTrigger } = await mod();
    await seed([base({ enabled: false, disabledBy: 'engine', disabledReason: '自动化环 …' })]);
    await upsertTrigger(ensurePayload(), ID, {});
    expect((await read(ID))!.enabled).toBe(true);
  });

  it('disabledBy 的写入/保留:引擎停用写 engine;用户显式停用写 user;已停用规则被整量重存不许把 engine 降级成「没人认领」', async () => {
    const { upsertTrigger, disableTriggers, disableTriggersWithReasons } = await mod();
    await seed([base()]);
    await disableTriggers([ID], '自动化环 …');
    expect((await read(ID))!.disabledBy).toBe('engine');
    // 已停用 + 整量重存(构建器保存 editing.enabled=false,actor=user)→ wasEnabled 为假 → 不覆盖来源
    await upsertTrigger({ ...ensurePayload(), enabled: false }, ID, { actor: 'user' });
    expect((await read(ID))!.disabledBy).toBe('engine');
    // 真的从启用翻成停用才记来源
    await upsertTrigger(ensurePayload(), ID, { actor: 'user' });                     // 先开
    await upsertTrigger({ ...ensurePayload(), enabled: false }, ID, { actor: 'user' }); // 再关
    expect((await read(ID))!.disabledBy).toBe('user');
    // 配置错误那条入口同样写 engine
    await upsertTrigger(ensurePayload(), ID, { actor: 'user' });
    expect(await disableTriggersWithReasons({ [ID]: '监听列已被删除' })).toEqual([ID]);
    const cur = (await read(ID))!;
    expect([cur.disabledBy, cur.disabledReason]).toEqual(['engine', '监听列已被删除']);
  });

  it('effectiveDisabledBy:disabledReason 是引擎独有的签名,单源判据不许被绕开', async () => {
    const { effectiveDisabledBy } = await mod();
    expect(effectiveDisabledBy({})).toBeUndefined();
    expect(effectiveDisabledBy({ disabledReason: '自动化环 …' })).toBe('engine'); // ★ 存量形状
    expect(effectiveDisabledBy({ disabledBy: 'user' })).toBe('user');
    expect(effectiveDisabledBy({ disabledBy: 'user', disabledReason: '自动化环 …' })).toBe('user'); // 显式来源优先
  });
});

describe('H2 监听列预检只挂在「让规则更活跃」的路上', () => {
  it('★ 关规则永远不被预检挡住;新建 / cond 实质变化 / 置为启用仍要过预检', async () => {
    const { needsWatchColPrecheck } = await mod();
    const cond = { type: 'db_changed', path: 't.db', vault: '/v', event: 'cell_changed', columnId: 'st' } as const;
    const on = { cond, enabled: true };
    const off = { cond, enabled: false };
    expect(needsWatchColPrecheck(undefined, on)).toBe(true);                 // 新建即拒仍在
    expect(needsWatchColPrecheck(undefined, off)).toBe(true);                // 新建(即便建成停用的)也要预检
    expect(needsWatchColPrecheck({ cond, enabled: true }, off)).toBe(false); // ★ 关掉:不许被挡
    expect(needsWatchColPrecheck({ cond, enabled: false }, off)).toBe(false);// ★ 已停用的整量重存(pluginStore 逐条关):不许被挡
    expect(needsWatchColPrecheck({ cond, enabled: false }, on)).toBe(true);  // 停用 → 启用
    expect(needsWatchColPrecheck({ cond, enabled: true }, on)).toBe(false);  // 原样重存已启用的:不预检
    // cond 实质变化(换列)即便是关着的也要预检 —— 换的是触发语义
    const other = { ...cond, columnId: 'other' } as const;
    expect(needsWatchColPrecheck({ cond, enabled: false }, { cond: other, enabled: false })).toBe(true);
  });
});
