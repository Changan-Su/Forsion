import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { amadeusProvider, amadeusVaultPath } from './amadeus.js';
import { configureTangu } from '../../seams/runtime.js';
import { createTanguProfile } from '../../profiles/index.js';
import { AmadeusConflictError, AmadeusNotFoundError, HumanCalendarConflictError, type AmadeusBrain } from '../../seams/cloudBrain.js';
import { humanDir } from '../../core/tanguHome.js';

const tools = Object.fromEntries(amadeusProvider.tools().map((t) => [t.name, t]));
// host 路径(本地磁盘 vault):双后端化后工具按 ctx.execMode 选后端,host 测试显式给 'host'。
const run = (name: string, args: Record<string, any> = {}): Promise<string> =>
  Promise.resolve(tools[name].execute(args, { execMode: 'host' } as any));

let vault: string;
let home: string;
const prevHome = process.env.TANGU_HOME;
beforeAll(async () => {
  vault = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-test-'));
  home = await fs.mkdtemp(path.join(os.tmpdir(), 'amadeus-test-home-'));
  process.env.FORSION_AMADEUS_VAULT = vault;
  process.env.TANGU_HOME = home; // 日历工具会读写 human/CALENDAR.db,不能碰到本机真的家目录
  process.env.TANGU_LANG = 'en';
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
  await fs.rm(home, { recursive: true, force: true });
  delete process.env.FORSION_AMADEUS_VAULT;
  delete process.env.TANGU_LANG;
  if (prevHome === undefined) delete process.env.TANGU_HOME; else process.env.TANGU_HOME = prevHome;
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
  it('list_calendars puts the default calendar first, then calendars in the vault', async () => {
    const out = JSON.parse(await run('amadeus_list_calendars'));
    expect(out.map((c: any) => c.path)).toEqual(['human://CALENDAR.db', 'Calendar.db']);
    expect(out[1].name).toBe('我的日历');
    expect(out[1].events).toBe(1);
  });

  it('a new user has no calendar file: the first event creates human/CALENDAR.db, the vault stays as it was', async () => {
    const file = path.join(humanDir(), 'CALENDAR.db');
    const before = await fs.readFile(path.join(vault, 'Calendar.db'), 'utf8');
    await expect(fs.access(file)).rejects.toThrow();
    const created = await run('amadeus_create_event', { title: 'Dentist', start: '2026-07-10T09:00' });
    expect(created).toContain('in "My calendar"');
    const db = JSON.parse(await fs.readFile(file, 'utf8'));
    expect(db.columns.map((c: any) => c.id)).toEqual(['name', 'date', 'done']); // 和桌面 emptyCalendar 一致,见 humanCalendarIo
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].cells).toMatchObject({ name: 'Dentist', date: '2026-07-10T09:00' });
    expect(await fs.readFile(path.join(vault, 'Calendar.db'), 'utf8')).toBe(before);
    const id = /id=(\w+)/.exec(created)![1];
    await run('amadeus_edit_event', { calendar: 'human://CALENDAR.db', eventId: id, title: 'Dentist moved' });
    expect(JSON.parse(await run('amadeus_list_events')).find((e: any) => e.id === id).title).toBe('Dentist moved');
    expect(await run('amadeus_delete_event', { calendar: 'My calendar', eventId: id })).toContain('Deleted');
    expect(JSON.parse(await fs.readFile(file, 'utf8')).rows).toEqual([]);
  }, 30_000); // 写完动态 import 镜像模块,高负载时单这一步就过 5 秒

  it('a corrupt human/CALENDAR.db is left alone: skipped when listing, never replaced by a new one', async () => {
    const file = path.join(humanDir(), 'CALENDAR.db');
    const good = await fs.readFile(file, 'utf8');
    await fs.writeFile(file, '{not json');
    try {
      expect(JSON.parse(await run('amadeus_list_calendars')).map((c: any) => c.path)).toEqual(['Calendar.db']);
      await run('amadeus_create_event', { title: 'Falls back to the vault', start: '2026-07-11', allDay: true });
      expect(await fs.readFile(file, 'utf8')).toBe('{not json');
    } finally {
      await fs.writeFile(file, good);
    }
  });

  it('the legacy mirror of the default calendar is not listed as a second calendar', async () => {
    process.env.FORSION_DEFAULT_CALENDAR = path.join(vault, 'Calendar.db');
    try {
      expect(JSON.parse(await run('amadeus_list_calendars')).map((c: any) => c.path)).toEqual(['human://CALENDAR.db']);
      // human/ 读不出来时库里这份就是唯一能用的,不能跟着藏掉
      const file = path.join(humanDir(), 'CALENDAR.db');
      const good = await fs.readFile(file, 'utf8');
      await fs.writeFile(file, '{not json');
      try {
        expect(JSON.parse(await run('amadeus_list_calendars')).map((c: any) => c.path)).toEqual(['Calendar.db']);
      } finally {
        await fs.writeFile(file, good);
      }
    } finally {
      delete process.env.FORSION_DEFAULT_CALENDAR;
    }
  });

  it('create → list → edit → delete round-trips + git-diffable serialization', async () => {
    const created = await run('amadeus_create_event', { calendar: 'Calendar.db', title: '新会议', start: '2026-07-09T10:00', end: '2026-07-09T10:30' });
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
    await run('amadeus_create_event', { calendar: 'Calendar.db', title: '全天', start: '2026-08-01', allDay: true });
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

  it('isEnabledFor: 非 host 看 facet,host 看 hostExec;云端专用的两个笔记工具 host 下隐藏', () => {
    const t = tools['amadeus_read_note']; // 云端专用
    expect(t.isEnabledFor!({ capabilities: { hostExec: false } } as any, { execMode: 'sandbox' } as any)).toBe(true);
    expect(t.isEnabledFor!({ capabilities: { hostExec: false } } as any, { execMode: 'host' } as any)).toBe(false);
    // ⚠️host 下即便有 hostExec 也不给 —— 本机 vault 是真目录,笔记走通用文件工具;
    // 暴露出来再拒绝既与提示词矛盾,又会被 registry 记成 isError:false 的「成功」(codex)。
    expect(t.isEnabledFor!({ capabilities: { hostExec: true } } as any, { execMode: 'host' } as any)).toBe(false);
    // 非云端专用的工具(日历/列表)照旧跟 hostExec
    const cal = tools['amadeus_list_calendars'];
    expect(cal.isEnabledFor!({ capabilities: { hostExec: true } } as any, { execMode: 'host' } as any)).toBe(true);
    expect(cal.isEnabledFor!({ capabilities: { hostExec: false } } as any, { execMode: 'host' } as any)).toBe(false);
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

  it('cloud note reads expose explicit page Instructions scoped to that note only', async () => {
    store.set('Guided.md', { content: '---\ntags: []\n---\n<!-- a 1 -->\n```forsion-instructions\nCite sources.\n```\n\nBody.', seq: 1 });
    const out = await runCloud('amadeus_read_note', { path: 'Guided.md' });
    expect(out).toContain('Page maintenance instructions for "Guided.md"');
    expect(out).toContain('Instruction text (JSON string): "Cite sources."');
    expect(out).not.toContain('tags: []');
    store.set('Unguided.md', { content: '# Agent Instructions\nOrdinary heading.', seq: 1 });
    expect(await runCloud('amadeus_read_note', { path: 'Unguided.md' })).not.toContain('Page maintenance instructions');
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

  // ── 画布覆盖闸(codex 2026-08-17:P1 fail-open + P3 正则越界)────────────────────
  // 画布笔记就是普通 `.md`,几何全在 frontmatter 的 `amadeus_canvas` 单行 JSON 里。
  // 整篇覆盖 = 几何没了,所以 write_note 前要读一眼现状。这三条钉住那道闸的边界。

  it('画布笔记拒绝整篇覆盖', async () => {
    store.set('Board.md', { content: "---\namadeus_canvas: '{\"v\":1}'\n---\n正文", seq: 1 });
    await expect(runCloud('amadeus_write_note', { path: 'Board.md', content: '覆盖' })).rejects.toThrow(/canvas note/);
    expect(store.get('Board.md')!.content).toContain('amadeus_canvas'); // 一个字节都没动
  });

  // D-01:带文件头 BOM 的画布笔记。修前 FRONTMATTER_RE 认不出 fm → 闸放行 → 整篇覆盖抹掉画布几何。
  it('read_note:带 BOM 的 fm 同样剥掉(口径=desktop split.ts)', async () => {
    store.set('BomNote.md', { content: '\uFEFF---\ntags: [a]\n---\n正文一段', seq: 1 });
    expect(await runCloud('amadeus_read_note', { path: 'BomNote.md' })).toBe('正文一段');
  });

  it('带 BOM 的画布笔记同样拒绝整篇覆盖', async () => {
    store.set('BomBoard.md', { content: "\uFEFF---\namadeus_canvas: '{\"v\":1}'\n---\n正文", seq: 1 });
    await expect(runCloud('amadeus_write_note', { path: 'BomBoard.md', content: '覆盖' })).rejects.toThrow(/canvas note/);
    expect(store.get('BomBoard.md')!.content).toContain('amadeus_canvas');
  });

  // Codex g2#1:覆盖闸自己的 FRONTMATTER_RE 与共享层(desktop split.ts stripFrontmatter)口径不一 —— 收尾 `---`
  // 后带空格 / 制表符共享层认、这里不认 → 闸放行 → 整篇覆盖抹掉画布几何;反过来它还会越过这种栅栏一路懒匹配到
  // 正文里下一个 `---`,把正文里的 `amadeus_canvas:` 算进 fm。现与 read_note 共用同一条口径正则(FM_RE)。
  // 负对照(实跑过):换回旧 FRONTMATTER_RE → 下面两条红。
  it('收尾栅栏后带空格 / 制表符(含 BOM、CRLF)的画布笔记同样拒绝整篇覆盖', async () => {
    store.set('SpaceFence.md', { content: "\uFEFF---\namadeus_canvas: '{\"v\":1}'\n---   \n正文", seq: 1 });
    await expect(runCloud('amadeus_write_note', { path: 'SpaceFence.md', content: '覆盖' })).rejects.toThrow(/canvas note/);
    expect(store.get('SpaceFence.md')!.content).toContain('amadeus_canvas');
    store.set('CrlfTab.md', { content: "---\r\namadeus_canvas: '{\"v\":1}'\r\n---\t\r\n正文\r\n", seq: 1 });
    await expect(runCloud('amadeus_write_note', { path: 'CrlfTab.md', content: '覆盖' })).rejects.toThrow(/canvas note/);
    expect(store.get('CrlfTab.md')!.content).toContain('amadeus_canvas');
  });

  it('fm 在带尾随空白的收尾栅栏处就结束:正文里的 `amadeus_canvas:` 不算(不许越过栅栏懒匹配到正文的 ---)', async () => {
    store.set('Overrun.md', { content: '---\ntitle: x\n---  \n正文\namadeus_canvas: 是正文\n---\n', seq: 1 });
    expect(await runCloud('amadeus_write_note', { path: 'Overrun.md', content: '改过' })).toContain('Saved note');
    expect(store.get('Overrun.md')!.content).toBe('改过');
  });

  it('⚠️读失败**不是**「文件不存在」时必须抬错,不许放行覆盖(fail-closed)', async () => {
    store.set('Flaky.md', { content: "---\namadeus_canvas: '{\"v\":1}'\n---\n正文", seq: 1 });
    const orig = facet.read;
    (facet as any).read = async () => { throw new Error('ETIMEDOUT'); };
    try {
      // 原来是 `.catch(() => '')`:网络抖一下就被当成新建 → force 覆盖 → 画布几何当场没了。
      await expect(runCloud('amadeus_write_note', { path: 'Flaky.md', content: '覆盖' })).rejects.toThrow(/ETIMEDOUT/);
      expect(store.get('Flaky.md')!.content).toContain('amadeus_canvas');
    } finally {
      (facet as any).read = orig;
    }
  });

  it('不存在的文件照常新建(NotFound 才等于新建)', async () => {
    expect(await runCloud('amadeus_write_note', { path: 'Brand.md', content: '新笔记' })).toContain('Saved note');
    expect(store.get('Brand.md')!.content).toBe('新笔记');
  });

  it('⚠️正文里出现 `amadeus_canvas:` 的普通笔记**不算**画布(正则不许越过 --- 栅栏)', async () => {
    store.set('Doc.md', { content: '---\ntitle: 文档\n---\n讲一下这个键:\namadeus_canvas: 是画布几何\n', seq: 1 });
    expect(await runCloud('amadeus_write_note', { path: 'Doc.md', content: '改过的正文' })).toContain('Saved note');
    expect(store.get('Doc.md')!.content).toBe('改过的正文');
  });

  it('无 frontmatter 的笔记也不会被正文误判', async () => {
    store.set('Plain.md', { content: 'amadeus_canvas: 只是正文第一行\n', seq: 1 });
    expect(await runCloud('amadeus_write_note', { path: 'Plain.md', content: 'x' })).toContain('Saved note');
  });
});

describe('note tools', () => {
  // 07-26 起:host 侧退役 —— 本机 vault 是真目录,笔记必须用通用文件工具读写。
  // 这两个工具**剥 frontmatter 与块标记 / 覆盖时重置布局**,对 .mindmap.md 这类结构化文件就是毁档,
  // 只保留给云端(云端 vault 走远端 brain API,没有任何文件工具够得着)。
  it('⚠️host 模式抛错拒绝(不是返回字符串:registry 只有 throw 才记 isError)', async () => {
    await expect(run('amadeus_write_note', { path: 'Notes/hello.md', content: '# Hello' })).rejects.toThrow(
      /cloud vaults only/,
    );
    await expect(run('amadeus_read_note', { path: 'Notes/hello.md' })).rejects.toThrow(/ordinary file tools/);
    expect(await run('amadeus_list_notes')).not.toContain('Notes/hello.md'); // 拒绝 = 什么都没写
  });

  it('⚠️结构化文件(.mindmap.md/.excalidraw.md/.db)在实现层硬拒,云端也拒 —— 没有无损 API 时宁可失败', async () => {
    const tool = tools['amadeus_write_note'];
    await expect(
      Promise.resolve(tool.execute({ path: 'a.mindmap.md', content: '# 覆盖' }, { execMode: 'sandbox' } as any)),
    ).rejects.toThrow(/structured Amadeus file/);
    await expect(
      Promise.resolve(tools['amadeus_read_note'].execute({ path: 'b.excalidraw.md' }, { execMode: 'sandbox' } as any)),
    ).rejects.toThrow(/structured Amadeus file/);
  });

  it('查找仍然可用(list 不受影响,它给的是路径)', async () => {
    await fs.writeFile(path.join(vault, 'x.md'), '# 标题\n正文');
    expect(await run('amadeus_list_notes')).toContain('x.md');
  });

  // 云端路径已由上面「cloud backend」那组覆盖(write_note force 覆盖 + read_note 剥标记)。
});

describe('cloud default calendar (brain.amadeus → /agent/human/CALENDAR.db)', () => {
  const cloudCal = (rows: unknown[] = []) => ({
    version: 1,
    name: 'Work',
    columns: [{ id: 'n', name: 'Name', type: 'text' }, { id: 'd', name: 'Date', type: 'calendarDate' }],
    rows,
  });
  let vault: Map<string, { content: string; seq: number }>;
  let human: { data: any; version: string | null; legacy: string | null } | null;
  let readError: Error | null;
  let writes: Array<{ data: any; version: string | null }>;
  /** 每次写之前跑一次,模拟别处抢先写;抛 HumanCalendarConflictError = 这次写 409。 */
  let beforeWrite: () => void;
  const facet: AmadeusBrain = {
    list: async () => [...vault.entries()].map(([p, v]) => ({ path: p, size: v.content.length })),
    read: async (p) => {
      const f = vault.get(p);
      if (!f) throw new AmadeusNotFoundError(p);
      return { ...f };
    },
    write: async (p, content) => {
      const seq = (vault.get(p)?.seq ?? 0) + 1;
      vault.set(p, { content, seq });
      return { seq };
    },
    readHumanCalendar: async () => {
      if (readError) throw readError;
      return human && structuredClone(human);
    },
    writeHumanCalendar: async (data, version) => {
      writes.push({ data: structuredClone(data), version });
      beforeWrite();
      if (version !== human!.version) throw new HumanCalendarConflictError();
      human = { ...human!, data: structuredClone(data), version: `v${writes.length}` };
    },
  };
  const runCloud = (name: string, args: Record<string, any> = {}, ctx: Record<string, unknown> = {}): Promise<string> =>
    Promise.resolve(tools[name].execute(args, { execMode: 'sandbox', ...ctx } as any));
  const calendarsListed = async (): Promise<string[]> => JSON.parse(await runCloud('amadeus_list_calendars')).map((c: any) => c.path);

  beforeEach(() => {
    vault = new Map();
    human = { data: null, version: null, legacy: null };
    readError = null;
    writes = [];
    beforeWrite = () => {};
    configureTangu({ host: {} as any, brain: { amadeus: facet } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'docker' }) });
  });

  it('a new user has no calendar file: the first event creates it with the fixed column ids, the vault stays empty', async () => {
    expect(await calendarsListed()).toEqual(['human://CALENDAR.db']);
    expect(writes).toEqual([]);
    const created = await runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03T10:00' });
    expect(created).toContain('in "My calendar"');
    expect(writes).toHaveLength(1);
    expect(writes[0].version).toBeNull();
    expect(writes[0].data.columns.map((c: any) => c.id)).toEqual(['name', 'date', 'done']);
    expect(writes[0].data.rows[0].cells).toMatchObject({ name: 'Dentist', date: '2026-12-03T10:00' });
    expect(vault.size).toBe(0);
  });

  it('the name of a new calendar follows the language the client reported, not the worker', async () => {
    await runCloud('amadeus_create_event', { title: '看牙', start: '2026-12-03' }, { uiSettings: { locale: { value: 'zh' } } });
    expect(human!.data.name).toBe('我的日历');
    expect(human!.data.columns.map((c: any) => c.name)).toEqual(['名称', '日期', '完成']);
  });

  it('edit and delete go through the version check, by name or by ref', async () => {
    const id = /id=(\w+)/.exec(await runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03' }))![1];
    await runCloud('amadeus_edit_event', { calendar: 'human://CALENDAR.db', eventId: id, title: 'Dentist moved' });
    expect(writes[1].version).toBe('v1');
    expect(JSON.parse(await runCloud('amadeus_list_events'))[0]).toMatchObject({ id, title: 'Dentist moved', path: 'human://CALENDAR.db' });
    expect(await runCloud('amadeus_delete_event', { calendar: 'My calendar', eventId: id })).toContain('Deleted');
    expect(human!.data.rows).toEqual([]);
    const before = writes.length;
    expect(await runCloud('amadeus_delete_event', { calendar: 'My calendar', eventId: 'nope' })).toContain('not found');
    expect(writes).toHaveLength(before); // ok:false 不写
  });

  it('409: rereads and replays once, keeping what the other writer added', async () => {
    human = { data: cloudCal(), version: 'v0', legacy: null };
    beforeWrite = () => {
      beforeWrite = () => {};
      human = { ...human!, data: cloudCal([{ id: 'other', cells: { n: 'From the web', d: '2026-12-01' } }]), version: 'other-1' };
    };
    expect(await runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03' })).toContain('Created event');
    expect(writes.map((w) => w.version)).toEqual(['v0', 'other-1']);
    expect(human!.data.rows.map((r: any) => r.cells.n)).toEqual(['From the web', 'Dentist']);
  });

  it('two people creating the file at once: the second replays onto the first one\'s file', async () => {
    beforeWrite = () => {
      beforeWrite = () => {};
      human = { ...human!, data: cloudCal([{ id: 'first', cells: { n: 'First', d: '2026-12-01' } }]), version: 'first-1' };
    };
    await runCloud('amadeus_create_event', { title: 'Second', start: '2026-12-03' });
    expect(writes.map((w) => w.version)).toEqual([null, 'first-1']);
    expect(human!.data.rows).toHaveLength(2);
  });

  it('a second 409 surfaces instead of looping', async () => {
    human = { data: cloudCal(), version: 'v0', legacy: null };
    beforeWrite = () => { throw new HumanCalendarConflictError(); };
    await expect(runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03' })).rejects.toThrow(HumanCalendarConflictError);
    expect(writes).toHaveLength(2);
    expect(human!.data.rows).toEqual([]);
  });

  // 没动过的云端种子:日期固定在 2026-07,不算用户数据
  const seedFile = () => `${JSON.stringify({
    version: 1,
    name: '我的日历',
    columns: [{ id: 'n', name: '名称', type: 'text' }, { id: 'd', name: '日期', type: 'calendarDate' }, { id: 't', name: '完成', type: 'todo' }],
    rows: [
      { id: 's1', cells: { n: '欢迎使用 Calendar Space', d: '2026-07-06T10:00/2026-07-06T11:00', t: true } },
      { id: 's2', cells: { n: '整理本周任务', d: '2026-07-07' } },
      { id: 's3', cells: { n: '项目评审', d: '2026-07-08T14:00/2026-07-08T15:30' } },
    ],
  }, null, 2)}\n`;
  const legacy = 'cloud://vault-1/Calendar.db';

  it('an untouched seed at the old location is hidden and left alone; a same-named file in a folder is not hidden', async () => {
    vault.set('Calendar.db', { content: seedFile(), seq: 1 });
    vault.set('Archive/Calendar.db', { content: seedFile(), seq: 1 });
    vault.set('Work.db', { content: JSON.stringify(cloudCal()), seq: 1 });
    human = { data: null, version: null, legacy };
    expect(await calendarsListed()).toEqual(['human://CALENDAR.db', 'Archive/Calendar.db', 'Work.db']);
    await runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03' });
    expect(vault.get('Calendar.db')!.content).toBe(seedFile()); // 老云库的文件不动
  });

  it('the old location is hidden while the default calendar holds all of its rows', async () => {
    const row = { id: 'a', cells: { n: 'Adopted', d: '2026-12-01' } };
    vault.set('Calendar.db', { content: JSON.stringify(cloudCal([row])), seq: 1 });
    human = { data: cloudCal([row, { id: 'b', cells: { n: 'Newer', d: '2026-12-02' } }]), version: 'v0', legacy };
    expect(await calendarsListed()).toEqual(['human://CALENDAR.db']);
  });

  it('a row only the old location has keeps it listed: nothing disappears from the agent, and copied rows are not doubled', async () => {
    const copied = { id: 'a', cells: { n: 'Moved on the web', d: '2026-12-09' } };
    const before = { id: 'a', cells: { n: 'Adopted', d: '2026-12-01' } };
    const mine = { id: 'late', cells: { n: 'Written by an old worker', d: '2026-12-02' } };
    const content = JSON.stringify(cloudCal([before, mine]));
    vault.set('Calendar.db', { content, seq: 1 });
    human = { data: cloudCal([copied]), version: 'v0', legacy };
    expect(await calendarsListed()).toEqual(['human://CALENDAR.db', 'Calendar.db']);
    const events = JSON.parse(await runCloud('amadeus_list_events'));
    expect(events.map((e: any) => [e.id, e.title, e.path])).toEqual([
      ['late', 'Written by an old worker', 'Calendar.db'],
      ['a', 'Moved on the web', 'human://CALENDAR.db'],
    ]);
    expect(await runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03' })).toContain('in "Work"'); // 新事件仍进默认日历
    expect(human!.data.rows).toHaveLength(2);
    expect(vault.get('Calendar.db')!.content).toBe(content);
  });

  it('old cloud or corrupt file (null): falls back to the calendars in the vault, nothing is hidden', async () => {
    vault.set('Calendar.db', { content: JSON.stringify(cloudCal()), seq: 1 });
    human = null;
    expect(await calendarsListed()).toEqual(['Calendar.db']);
    await runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03' });
    expect(JSON.parse(vault.get('Calendar.db')!.content).rows).toHaveLength(1);
    expect(writes).toEqual([]);
  });

  it('a cloud without the facet methods behaves as before', async () => {
    const { readHumanCalendar: _r, writeHumanCalendar: _w, ...old } = facet;
    configureTangu({ host: {} as any, brain: { amadeus: old } as any, billing: {} as any, profile: createTanguProfile({ sandboxMode: 'docker' }) });
    vault.set('Calendar.db', { content: JSON.stringify(cloudCal()), seq: 1 });
    expect(await calendarsListed()).toEqual(['Calendar.db']);
  });

  it('a failed read is not an empty calendar: the tool errors and nothing lands in the vault', async () => {
    vault.set('Work.db', { content: JSON.stringify(cloudCal()), seq: 1 });
    readError = new Error('human calendar read 503');
    await expect(runCloud('amadeus_list_calendars')).rejects.toThrow('503');
    await expect(runCloud('amadeus_create_event', { title: 'Dentist', start: '2026-12-03' })).rejects.toThrow('503');
    expect(JSON.parse(vault.get('Work.db')!.content).rows).toEqual([]);
    expect(writes).toEqual([]);
  });
});
