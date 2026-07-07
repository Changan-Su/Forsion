import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { amadeusProvider, amadeusVaultPath } from './amadeus.js';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';
import { AmadeusConflictError, AmadeusNotFoundError, type AmadeusBrain } from '../../seams/cloudBrain.js';

const tools = Object.fromEntries(amadeusProvider.tools().map((t) => [t.name, t]));
// host 路径(本地磁盘 vault):双后端化后工具按 ctx.execMode 选后端,host 测试显式给 'host'。
const run = (name: string, args: Record<string, any> = {}): Promise<string> =>
  Promise.resolve(tools[name].execute(args, { execMode: 'host' } as any));

let vault: string;
beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-test-'));
  process.env.FORSION_AMADEUS_VAULT = vault;
  const db = {
    version: 1,
    name: '我的日历',
    columns: [
      { id: 'c1', name: '名称', type: 'text' },
      { id: 'c2', name: '日期', type: 'calendarDate' },
      { id: 'c3', name: '完成', type: 'todo' },
    ],
    rows: [{ id: 'r1', cells: { c1: '既有会议', c2: '2026-07-08T14:00/2026-07-08T15:00' } }],
  };
  await fs.writeFile(path.join(vault, 'Calendar.db'), `${JSON.stringify(db, null, 2)}\n`);
});
afterAll(async () => {
  await fs.rm(vault, { recursive: true, force: true });
  delete process.env.FORSION_AMADEUS_VAULT;
});

describe('amadeus vault path', () => {
  it('honors FORSION_AMADEUS_VAULT', () => {
    expect(amadeusVaultPath()).toBe(vault);
  });

  it('reads lastVault live from FORSION_AMADEUS_CONFIG when no explicit env (the real-vault fix)', async () => {
    const cfg = path.join(vault, 'amadeus-config.json');
    await fs.writeFile(cfg, JSON.stringify({ lastVault: '/some/custom/AmadeusTest', lastPage: 'a.md' }));
    const saved = process.env.FORSION_AMADEUS_VAULT;
    delete process.env.FORSION_AMADEUS_VAULT; // 显式覆盖缺席 → 走配置
    process.env.FORSION_AMADEUS_CONFIG = cfg;
    try {
      expect(amadeusVaultPath()).toBe('/some/custom/AmadeusTest');
      // 显式 env 存在时优先于配置
      process.env.FORSION_AMADEUS_VAULT = '/explicit';
      expect(amadeusVaultPath()).toBe('/explicit');
    } finally {
      delete process.env.FORSION_AMADEUS_CONFIG;
      if (saved !== undefined) process.env.FORSION_AMADEUS_VAULT = saved;
    }
  });
});

describe('calendar tools', () => {
  it('list_calendars finds the seeded calendar', async () => {
    const out = JSON.parse(await run('amadeus_list_calendars'));
    expect(out).toHaveLength(1);
    expect(out[0].name).toBe('我的日历');
    expect(out[0].events).toBe(1);
  });

  it('create → list → edit → delete round-trips + git-diffable serialization', async () => {
    const created = await run('amadeus_create_event', { title: '新会议', start: '2026-07-09T10:00', end: '2026-07-09T10:30' });
    const id = /id=(\w+)/.exec(created)?.[1];
    expect(id).toBeTruthy();

    let events = JSON.parse(await run('amadeus_list_events'));
    const ev = events.find((e: any) => e.id === id);
    expect(ev.title).toBe('新会议');
    expect(ev.start).toBe('2026-07-09T10:00');
    expect(ev.end).toBe('2026-07-09T10:30');
    expect(ev.allDay).toBe(false);

    const raw = await fs.readFile(path.join(vault, 'Calendar.db'), 'utf8');
    expect(raw.endsWith('\n')).toBe(true); // 尾换行 = 与 desktop serializeDb 同款
    expect(raw).toContain('\n  "version": 1'); // 2 空格缩进

    await run('amadeus_edit_event', { calendar: '我的日历', eventId: id, start: '2026-07-09T11:00' });
    events = JSON.parse(await run('amadeus_list_events'));
    expect(events.find((e: any) => e.id === id).start).toBe('2026-07-09T11:00');
    expect(events.find((e: any) => e.id === id).end).toBe('2026-07-09T10:30'); // 只改 start,end 保留

    expect(await run('amadeus_delete_event', { calendar: '我的日历', eventId: id })).toContain('Deleted');
    events = JSON.parse(await run('amadeus_list_events'));
    expect(events.find((e: any) => e.id === id)).toBeUndefined();
  });

  it('all-day event + date-range filter', async () => {
    await run('amadeus_create_event', { title: '全天', start: '2026-08-01', allDay: true });
    const aug = JSON.parse(await run('amadeus_list_events', { from: '2026-08-01', to: '2026-08-31' }));
    expect(aug.some((e: any) => e.title === '全天' && e.allDay === true)).toBe(true);
    const jul = JSON.parse(await run('amadeus_list_events', { from: '2026-07-01', to: '2026-07-31' }));
    expect(jul.some((e: any) => e.title === '全天')).toBe(false);
  });

  it('rejects invalid date format (executeTool 会把 throw 收成 "Error:")', async () => {
    await expect(run('amadeus_create_event', { title: 'x', start: 'tomorrow' })).rejects.toThrow(/invalid/i);
  });
});

describe('cloud backend (execMode≠host → deps().brain.amadeus)', () => {
  // 内存版云 vault:seq 单调递增,baseSeq 不符 → 409 同款 AmadeusConflictError(带最新 seq+content)。
  const store = new Map<string, { content: string; seq: number }>();
  let conflictOnce = false; // 下一次非 force 写强制冲突一次(模拟并发写)
  const facet: AmadeusBrain = {
    list: async () => [...store.entries()].map(([p, v]) => ({ path: p, size: v.content.length })),
    read: async (p) => {
      const f = store.get(p);
      if (!f) throw new AmadeusNotFoundError(p);
      return { ...f };
    },
    write: async (p, content, opts) => {
      const cur = store.get(p);
      if (!opts?.force) {
        if (conflictOnce && cur) {
          conflictOnce = false;
          throw new AmadeusConflictError(cur.seq, cur.content);
        }
        if (cur && opts?.baseSeq !== cur.seq) throw new AmadeusConflictError(cur.seq, cur.content);
      }
      const seq = (cur?.seq ?? 0) + 1;
      store.set(p, { content, seq });
      return { seq };
    },
  };
  const runCloud = (name: string, args: Record<string, any> = {}): Promise<string> =>
    Promise.resolve(tools[name].execute(args, { execMode: 'sandbox' } as any));

  beforeAll(() => {
    configureTangu({
      host: {} as any,
      brain: { amadeus: facet } as any,
      billing: {} as any,
      profile: createTanguProfile({ sandboxMode: 'docker' }),
    });
    store.set('Cloud.db', {
      content: `${JSON.stringify(
        {
          version: 1,
          name: 'CloudCal',
          columns: [
            { id: 'c1', name: '名称', type: 'text' },
            { id: 'c2', name: '日期', type: 'calendarDate' },
          ],
          rows: [],
        },
        null,
        2,
      )}\n`,
      seq: 3,
    });
  });

  it('isEnabledFor: 非 host 看 facet,host 看 hostExec', () => {
    const t = tools['amadeus_read_note'];
    expect(t.isEnabledFor!({ capabilities: { hostExec: false } } as any, { execMode: 'sandbox' } as any)).toBe(true);
    expect(t.isEnabledFor!({ capabilities: { hostExec: false } } as any, { execMode: 'host' } as any)).toBe(false);
    expect(t.isEnabledFor!({ capabilities: { hostExec: true } } as any, { execMode: 'host' } as any)).toBe(true);
  });

  it('write_note 走 force 覆盖 + read_note 剥标记;host ctx 仍走本地 vault(后端切换)', async () => {
    await runCloud('amadeus_write_note', { path: 'Cloud/idea', content: '<!-- a 1 -->\n云端内容' });
    expect(store.has('Cloud/idea.md')).toBe(true);
    expect(await runCloud('amadeus_read_note', { path: 'Cloud/idea.md' })).toBe('云端内容');
    // 再写一遍(store 里 seq 已前进,force 语义 = 不带 baseSeq 也不冲突)
    await runCloud('amadeus_write_note', { path: 'Cloud/idea', content: '第二版' });
    expect(store.get('Cloud/idea.md')!.content).toBe('第二版');
    // 后端切换:host ctx 列的是本地磁盘 vault(有 Notes/hello.md),云 ctx 列的是云 vault
    expect(await run('amadeus_list_notes')).not.toContain('Cloud/idea.md');
    expect(await runCloud('amadeus_list_notes')).toContain('Cloud/idea.md');
  });

  it('日历读-改-写带 baseSeq;409 冲突用服务端回带内容重放一次', async () => {
    conflictOnce = true; // 第一次写必冲突(带回最新内容)→ 应重放并成功
    const created = await runCloud('amadeus_create_event', { title: '云会议', start: '2026-07-10T09:00' });
    expect(created).toContain('Created event "云会议"');
    expect(conflictOnce).toBe(false);
    const db = JSON.parse(store.get('Cloud.db')!.content);
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].cells.c2).toBe('2026-07-10T09:00');
    // 正常路径(无冲突):list/edit/delete round-trip
    const events = JSON.parse(await runCloud('amadeus_list_events'));
    expect(events[0].calendar).toBe('CloudCal');
    expect(await runCloud('amadeus_delete_event', { calendar: 'CloudCal', eventId: events[0].id })).toContain('Deleted');
    expect(JSON.parse(store.get('Cloud.db')!.content).rows).toHaveLength(0);
  });
});

describe('note tools', () => {
  it('write → list → read; read strips frontmatter + block markers', async () => {
    await run('amadeus_write_note', { path: 'Notes/hello.md', content: '# Hello\n\nworld' });
    expect(await run('amadeus_list_notes')).toContain('Notes/hello.md');
    const read = await run('amadeus_read_note', { path: 'Notes/hello.md' });
    expect(read).toContain('# Hello');
    expect(read).toContain('world');

    await fs.writeFile(
      path.join(vault, 'x.md'),
      '---\namadeus_page: 1\namadeus_layout: {}\n---\n<!-- a 1 -->\n内容一\n<!-- a 2 -->\n内容二',
    );
    const cleaned = await run('amadeus_read_note', { path: 'x.md' });
    expect(cleaned).not.toContain('amadeus_page');
    expect(cleaned).not.toContain('<!-- a');
    expect(cleaned).toContain('内容一');
    expect(cleaned).toContain('内容二');
  });
});
