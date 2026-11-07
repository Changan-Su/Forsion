/**
 * 构建器保存的版本比对(D28):编辑期间 Muse 改了规则、或引擎自动停用,用户一保存不许悄悄盖回去。
 * 落盘走真 TANGU_HOME(upsertTrigger 是整文件读-改-写)。
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { MuseTrigger, ValidatedTrigger } from './museTriggers.js';

let home = '';
beforeAll(async () => { home = await fs.mkdtemp(path.join(os.tmpdir(), 'tangu-trigger-rev-')); process.env.TANGU_HOME = home; });
afterAll(async () => { await fs.rm(home, { recursive: true, force: true }); delete process.env.TANGU_HOME; });
beforeEach(async () => { await fs.rm(path.join(home, 'agents'), { recursive: true, force: true }); });

const mod = () => import('./museTriggers.js');
const rule: MuseTrigger = {
  id: 'w-abc123', desc: '早报', cond: { type: 'daily_at', time: '09:00' }, cooldownHours: 0,
  lastFiredAt: null, enabled: true, createdAt: '2026-11-01T00:00:00.000Z', actions: [{ type: 'notify', title: '早报' }],
};
const edit = (over: Partial<ValidatedTrigger> = {}): ValidatedTrigger => ({
  desc: '早报', cond: { type: 'daily_at', time: '10:00' }, prompt: undefined, cooldownHours: 0, agentSlug: undefined,
  enabled: true, actions: [{ type: 'notify', title: '早报' }], ...over,
});
async function seed(list: MuseTrigger[]): Promise<void> {
  const { triggersFile } = await mod();
  await fs.mkdir(path.dirname(triggersFile()), { recursive: true });
  await fs.writeFile(triggersFile(), JSON.stringify(list), 'utf8');
}

describe('triggerRev + expectedRev', () => {
  it('同一份内容版本不变;触发簿记变了不算改动', async () => {
    const { triggerRev } = await mod();
    expect(triggerRev({ ...rule, lastFiredAt: '2026-11-03T09:00:00.000Z' })).toBe(triggerRev(rule));
    // 键序不同(另一条写入口按别的顺序赋值)也是同一版
    expect(triggerRev({ actions: rule.actions, ...rule })).toBe(triggerRev(rule));
    expect(triggerRev({ ...rule, desc: '晚报' })).not.toBe(triggerRev(rule));
  });

  it('打开编辑器之后引擎自动停用了:带旧版本保存被拒,现状原样留着', async () => {
    const { triggerRev, upsertTrigger, loadTriggers } = await mod();
    const opened = triggerRev(rule);
    await seed([{ ...rule, enabled: false, disabledReason: '自动化环:已停用' }]);
    const r = await upsertTrigger(edit(), rule.id, { actor: 'user', expectedRev: opened });
    expect(r).toMatchObject({ ok: false, error: 'trigger:conflict' });
    expect(r.ok === false && r.conflict?.disabledReason).toBe('自动化环:已停用');
    expect((await loadTriggers())[0]).toMatchObject({ enabled: false, disabledReason: '自动化环:已停用', cond: { time: '09:00' } });
  });

  it('版本对得上照常保存;不带版本(旧客户端 / 「仍然保存」)不比对', async () => {
    const { triggerRev, upsertTrigger } = await mod();
    await seed([rule]);
    expect(await upsertTrigger(edit(), rule.id, { actor: 'user', expectedRev: triggerRev(rule) })).toMatchObject({ ok: true });
    expect(await upsertTrigger(edit({ desc: '改名' }), rule.id, { actor: 'user' })).toMatchObject({ ok: true });
  });
});
