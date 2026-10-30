/** Opt-in live probe (`--only cloudcal`): on a cloud run the model must reach the default calendar (human/CALENDAR.db) through the
 *  real server routes, the way a thin worker does. A new user has no calendar file: the first event creates it, and nothing lands
 *  in the vault. An old user's vault Calendar.db stays where it is and is not offered as a second calendar.
 *
 *  Needs the real thing: TANGU_LIVE_CLOUD_URL / TANGU_LIVE_CLOUD_TOKEN from `server scripts/calendar-local.mts`, whose token is a
 *  dispatch token, so the dispatch allowlist is exercised too.
 *  Negative controls (run them when touching this): remove the /api/agent/human/CALENDAR.db line from server dispatchToken.ts →
 *  legs 1-3 go red (the worker falls back to the vault and finds no calendar); in amadeus.ts make cloudBackend's human() return
 *  null → same; drop the `isMirror` check in calendars() → leg 3 goes red (the stale seed is listed). */
const CLOUD = { execMode: 'sandbox', cwd: undefined };
const ZH = { ui: { locale: { value: 'zh', allowed: ['zh', 'en'] } } };
const called = (ev, name) => ev.toolCalls.includes(name) && ev.toolResults.some((r) => r.name === name && !r.isError && !/^Error/.test(r.full || ''));
// The bytes every cloud vault was seeded with before the server stopped seeding (dates fixed in 2026-07).
const STALE_SEED = {
  version: 1, name: '我的日历',
  columns: [{ id: 'n1', name: '名称', type: 'text' }, { id: 'd1', name: '日期', type: 'calendarDate' }, { id: 't1', name: '完成', type: 'todo' }],
  rows: [
    { id: 'r1', cells: { n1: '欢迎使用 Calendar Space', d1: '2026-07-06T10:00/2026-07-06T11:00', t1: true } },
    { id: 'r2', cells: { n1: '整理本周任务', d1: '2026-07-07' } },
    { id: 'r3', cells: { n1: '项目评审', d1: '2026-07-08T14:00/2026-07-08T15:30' } },
  ],
};

export async function cloudCalLive({ run, cloud, token }) {
  const legs = [];
  const leg = (name, ok, why, ev) => { legs.push({ name, ok, why, ev }); return ok; };
  const sid = (k) => `live-cloudcal-${k}-${Date.now()}`;
  const req = async (path, init) => {
    const r = await fetch(cloud + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const human = async () => (await req('/api/agent/human/CALENDAR.db')).json;
  const vaultFile = (name) => req(`/api/amadeus/vaults/default/file?path=${encodeURIComponent(name)}`);
  const treeFiles = async () => ((await req('/api/amadeus/vaults/default/tree')).json?.files || []).map((f) => f.path);

  const start = await human();
  if (start?.status !== 'missing') return { ok: false, detail: `这个场景要一个没有日历的新账号:开始时 ${JSON.stringify(start)?.slice(0, 120)}` };

  // 1. New user, nothing in the vault: the first event creates the default calendar, named in the language the client reported.
  {
    const ev = await run(sid('new'), '帮我在日历上加一个 2026 年 12 月 3 号上午 10 点看牙医的日程。', 240_000, CLOUD, undefined, undefined, undefined, undefined, ZH);
    const h = await human();
    const row = h.data?.rows?.find((r) => /牙/.test(String(r.cells?.name)));
    const columns = h.data?.columns?.map((c) => c.id).join(',');
    const files = await treeFiles();
    leg('新用户第一条日程:建出默认日历,库里没多文件', !ev.error && called(ev, 'amadeus_create_event') && String(row?.cells?.date).startsWith('2026-12-03T10:00') && columns === 'name,date,done' && h.data?.name === '我的日历' && !files.length,
      ev.error || `工具 ${ev.toolCalls.join('→') || '无'};状态 ${h.status};行 ${JSON.stringify(row?.cells) ?? '✗ 没有'};列 ${columns};名字 ${h.data?.name};库里文件 ${JSON.stringify(files)}`, ev);
  }
  // 2. A new session finds that event and edits it: the second write goes through the version check.
  {
    const before = (await human()).version;
    const ev = await run(sid('edit'), '把我日历上看牙医那个日程改到下午 3 点开始。', 240_000, CLOUD, undefined, undefined, undefined, undefined, ZH);
    const h = await human();
    const row = h.data?.rows?.find((r) => /牙/.test(String(r.cells?.name)));
    leg('新会话改同一条:按版本写回,没有多出第二条', !ev.error && called(ev, 'amadeus_edit_event') && String(row?.cells?.date).startsWith('2026-12-03T15:00') && h.data.rows.length === 1 && h.version !== before,
      ev.error || `工具 ${ev.toolCalls.join('→') || '无'};日期 ${row?.cells?.date};共 ${h.data?.rows?.length} 行;版本${h.version !== before ? '已变' : '✗ 没变'}`, ev);
  }
  // 3. An old vault still holds the stale seed: it stays untouched and is neither listed nor read back to the user.
  {
    const content = `${JSON.stringify(STALE_SEED, null, 2)}\n`;
    const put = await req('/api/amadeus/vaults/default/file', { method: 'PUT', body: JSON.stringify({ path: 'Calendar.db', content, baseSeq: 0 }) });
    const ev = await run(sid('old'), '我的日历都有哪些?列出来,再告诉我 2026 年 7 月和 12 月分别有什么日程。', 240_000, CLOUD, undefined, undefined, undefined, undefined, ZH);
    const listed = ev.toolResults.filter((r) => /^amadeus_list_/.test(r.name)).map((r) => r.full).join('\n');
    const after = await vaultFile('Calendar.db');
    const stale = /欢迎使用|整理本周任务|项目评审/;
    leg('老库里的种子:不动、不列、不念给用户,默认日历照常读到', put.status === 200 && !ev.error && !stale.test(listed) && !stale.test(ev.content) && /牙/.test(ev.content) && after.json?.content === content,
      ev.error || `写种子 ${put.status};工具 ${ev.toolCalls.join('→') || '无'};工具结果${stale.test(listed) ? '✗ 带出了种子' : '没带种子'};回复${stale.test(ev.content) ? '✗ 念了种子' : '没念种子'}${/牙/.test(ev.content) ? '' : ';✗ 没读到看牙医'};库里那份${after.json?.content === content ? '没动' : '✗ 变了'}`, ev);
  }

  const bad = legs.filter((l) => !l.ok);
  return {
    ok: !bad.length,
    detail: legs.map((l, i) => `${i + 1}${l.ok ? '✓' : '✗'} ${l.name}:${l.why}`).join(' ‖ '),
    output: legs.map((l, i) => `【${i + 1} ${l.name}】\n${l.ev.content}`).join('\n\n'),
    toolCalls: legs.flatMap((l) => l.ev.toolCalls),
    tokens: legs.reduce((a, l) => a + (l.ev.usages?.reduce((x, u) => x + (Number(u.prompt) || 0) + (Number(u.completion) || 0), 0) || 0), 0) || null,
    calendarLegs: legs.map((l) => ({ name: l.name, ok: l.ok, why: l.why, tools: l.ev.toolCalls })),
  };
}
