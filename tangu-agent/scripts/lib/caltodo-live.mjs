/** Opt-in live probe for the user's to-dos (11-07). On a phone the agent was asked for two to-dos without dates, went round for
 *  17 steps and wrote a note with bare `- [ ]` lines that never reached the to-do list, then said there was no to-do tool.
 *  The to-do list is the rows of calendars that have a checkbox column (default human/CALENDAR.db), dated or not.
 *
 *   --only caltodo    local engine (host): the default calendar is <isolated home>/human/CALENDAR.db. `--calendar-plugin <dir>` plants that
 *                     Calendar plugin checkout's manifest.json + skills/ under <shared>/plugins/forsion-calendar (the desktop shape with the
 *                     calendar-todos skill); without it the run sees the tool definitions only.
 *   --only cloudtodo  cloud run (execMode sandbox) through the real server routes, like cloudcal: TANGU_LIVE_CLOUD_URL / TANGU_LIVE_CLOUD_TOKEN
 *                     from `server scripts/calendar-local.mts`. Cloud sessions load no plugin skills: this is the phone shape.
 *   --rounds n        repeat all three legs n times, each on a freshly seeded calendar (default 1).
 *
 *  Each round seeds the default calendar the way a real one looks (a dated event, two undated to-dos, a ticked one), then:
 *   1. add   — 「帮我添加两条待办：开发票；完成 Curve Wallet 的身份验证（邮件在 Gmail）」: within 6 tool calls both rows are in the default
 *              calendar with no date and not ticked, the seeded rows are untouched, nothing is written to a file / note / the session's
 *              own todo list, no new .md appears, and the reply doesn't claim there is no to-do tool.
 *   2. list  — new session 「我现在还有哪些待办？」: amadeus_list_events, and the reply names the two new and the two seeded undated to-dos.
 *   3. tick  — same session 「开发票那条我已经弄完了，帮我勾掉。」: amadeus_edit_event ticks that row (still no date); nothing else changes.
 *  Negative control (run it when touching this): the engine before 11-07 (start required, undated rows skipped by list) — leg 1 goes red. */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ADD = '帮我添加两条待办：开发票；完成 Curve Wallet 的身份验证（邮件在 Gmail）';
const LIST = '我现在还有哪些待办？';
const TICK = '开发票那条我已经弄完了，帮我勾掉。';
const MAX_STEPS = 6;
/** Wrong destinations for a to-do: a file / note, or the session's own checklist. */
const WRONG_TOOLS = ['write_file', 'edit_file', 'apply_patch', 'amadeus_write_note', 'todo_write'];
const DENIES = /没有[^。，,\n]{0,8}(待办|to-?do)[^。，,\n]{0,6}(接口|工具|功能)|(待办|to-?do)[^。，,\n]{0,6}(接口|工具)[^。，,\n]{0,4}(不存在|没有)|no (to-?do|task) (tool|api)/i;
const ZH = { ui: { locale: { value: 'zh', allowed: ['zh', 'en'] } } };

const day = (plus) => { const d = new Date(Date.now() + plus * 86_400_000); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };
/** A real default calendar: the desktop's column ids, a dated event, two undated to-dos, one ticked. */
const seedCalendar = () => ({
  version: 2, name: '我的日历',
  columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }],
  rows: [
    { id: 'seed-dentist', cells: { name: '牙医复诊', date: `${day(5)}T10:00/${day(5)}T11:00` } },
    { id: 'seed-passport', cells: { name: '续签护照' } },
    { id: 'seed-photos', cells: { name: '整理相册' } },
    { id: 'seed-rent', cells: { name: '交房租', date: day(-2), done: true } },
  ],
});
const okCalls = (ev, name) => ev.toolResults.filter((r) => r.name === name && !r.isError && !/^Error/.test(r.full || '')).length;
const usage = (ev) => ev.usages?.reduce((x, u) => x + (Number(u.prompt) || 0) + (Number(u.completion) || 0), 0) || 0;
const mdFiles = (root) => {
  const out = [];
  const walk = (dir) => { for (const n of existsSync(dir) ? readdirSync(dir) : []) { const p = join(dir, n); if (statSync(p).isDirectory()) walk(p); else if (/\.md$/i.test(n)) out.push(relative(root, p)); } };
  walk(root);
  return out.sort();
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Plant the Calendar plugin's manifest + skills where the engine's bundle scan looks (real dirs: bundleDirs refuses symlinks). */
export function plantCalendarSkill({ src, shared }) {
  if (!src) return null;
  if (!existsSync(join(src, 'manifest.json')) || !existsSync(join(src, 'skills'))) throw new Error(`--calendar-plugin ${src}: no manifest.json + skills/ there`);
  const dir = join(shared, 'plugins', 'forsion-calendar');
  mkdirSync(dir, { recursive: true });
  cpSync(join(src, 'manifest.json'), join(dir, 'manifest.json'));
  cpSync(join(src, 'skills'), join(dir, 'skills'), { recursive: true, dereference: true });
  return dir;
}

/**
 * cloud = undefined → local engine (host); otherwise the calendar-local server URL. `skill` = path of the planted plugin (host only).
 */
export async function calTodoLive({ run, rounds = 1, home, workspace, vault, cloud, token, skill }) {
  const cfg = cloud ? { execMode: 'sandbox', cwd: undefined } : { execMode: 'host', cwd: workspace };
  const req = async (path, init) => {
    const r = await fetch(cloud + path, { ...init, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const calFile = home && join(home, 'human', 'CALENDAR.db');
  const readCal = async () => {
    if (!cloud) return existsSync(calFile) ? JSON.parse(readFileSync(calFile, 'utf8')) : null;
    const h = (await req('/api/agent/human/CALENDAR.db')).json;
    return h?.status === 'ok' ? h.data : null;
  };
  const seed = async () => {
    const data = seedCalendar();
    if (!cloud) { mkdirSync(join(home, 'human'), { recursive: true }); writeFileSync(calFile, `${JSON.stringify(data, null, 2)}\n`); return data; }
    const cur = (await req('/api/agent/human/CALENDAR.db')).json;
    const put = await req('/api/agent/human/CALENDAR.db', { method: 'PUT', body: JSON.stringify({ data, version: cur?.status === 'ok' ? cur.version : null }) });
    if (put.status !== 200) throw new Error(`seeding the cloud calendar: ${put.status} ${JSON.stringify(put.json)}`);
    return data;
  };
  const notes = async () => {
    if (!cloud) return [...mdFiles(vault).map((p) => `vault/${p}`), ...mdFiles(workspace).map((p) => `workspace/${p}`)];
    return ((await req('/api/amadeus/vaults/default/tree')).json?.files || []).map((f) => f.path).filter((p) => /\.md$/i.test(p)).sort();
  };
  const run1 = (sid, msg) => run(sid, msg, 300_000, cfg, undefined, undefined, undefined, undefined, ZH);

  const legs = [];
  const leg = (name, ok, why, ev) => { legs.push({ name, ok, why, ev }); return ok; };
  const steps = [];
  for (let i = 1; i <= rounds; i++) {
    const tag = rounds > 1 ? `R${i} ` : '';
    const seeded = await seed();
    const notesBefore = await notes();
    const sid = (k) => `live-${cloud ? 'cloudtodo' : 'caltodo'}-${k}-${i}-${Date.now()}`;

    // 1. add two undated to-dos
    const add = await run1(sid('add'), ADD);
    let cal = await readCal();
    const added = (cal?.rows || []).filter((r) => !seeded.rows.some((s) => s.id === r.id));
    const invoice = added.find((r) => /发票/.test(String(r.cells?.name)));
    const curve = added.find((r) => /curve/i.test(String(r.cells?.name)));
    const undated = (r) => !!r && (r.cells.date === undefined || r.cells.date === '');
    const seedIntact = seeded.rows.every((s) => same(cal?.rows?.find((r) => r.id === s.id), s));
    const wrong = WRONG_TOOLS.filter((n) => okCalls(add, n));
    const newNotes = (await notes()).filter((p) => !notesBefore.includes(p));
    const denies = DENIES.test(add.content || '');
    steps.push(add.toolCalls.length);
    leg(`${tag}加两条无日期待办`,
      !add.error && okCalls(add, 'amadeus_create_event') >= 2 && added.length === 2 && undated(invoice) && undated(curve) && invoice.cells.done !== true && curve.cells.done !== true
        && seedIntact && add.toolCalls.length <= MAX_STEPS && !wrong.length && !newNotes.length && !denies,
      add.error || `${add.toolCalls.length} 步(${add.toolCalls.join('→') || '无'})${add.toolCalls.length > MAX_STEPS ? ` ✗ 超过 ${MAX_STEPS}` : ''};新行 ${added.length}:${added.map((r) => JSON.stringify(r.cells)).join(' / ') || '✗ 没有'}`
        + `${invoice ? '' : ';✗ 没有开发票'}${curve ? '' : ';✗ 没有 Curve'}${(invoice && !undated(invoice)) || (curve && !undated(curve)) ? ';✗ 带了日期' : ''}`
        + `${seedIntact ? '' : ';✗ 原有行被改'}${wrong.length ? `;✗ 写到了 ${wrong.join('/')}` : ''}${newNotes.length ? `;✗ 新笔记 ${newNotes.join(',')}` : ''}${denies ? ';✗ 说没有待办工具' : ''}`
        + `${skill ? `;技能${add.toolCalls.includes('use_skill') ? '装载了' : '没装载(不计红)'}` : ''}`,
      add);

    // 2. a new session lists the to-dos
    const lsid = sid('list');
    const list = await run1(lsid, LIST);
    const named = ['发票', 'Curve', '续签护照', '整理相册'].filter((w) => !new RegExp(w, 'i').test(list.content || ''));
    leg(`${tag}新会话列出待办(含无日期的)`, !list.error && okCalls(list, 'amadeus_list_events') >= 1 && !named.length,
      list.error || `工具 ${list.toolCalls.join('→') || '无'};回复${named.length ? `✗ 没提 ${named.join('、')}` : '提到了新加的两条和原有的两条无日期待办'}`, list);

    // 3. tick one off in the same session
    const before = await readCal();
    const tick = await run1(lsid, TICK);
    cal = await readCal();
    const inv = cal?.rows?.find((r) => r.id === invoice?.id);
    const others = (before?.rows || []).filter((r) => r.id !== invoice?.id).every((r) => same(cal?.rows?.find((x) => x.id === r.id), r));
    leg(`${tag}勾掉「开发票」`, !tick.error && okCalls(tick, 'amadeus_edit_event') >= 1 && inv?.cells?.done === true && undated(inv) && others && (cal?.rows?.length === before?.rows?.length),
      tick.error || `工具 ${tick.toolCalls.join('→') || '无'};开发票 ${inv ? JSON.stringify(inv.cells) : '✗ 找不到'}${others ? '' : ';✗ 别的行也变了'}${cal?.rows?.length === before?.rows?.length ? '' : ';✗ 行数变了'}`, tick);
  }

  const bad = legs.filter((l) => !l.ok);
  return {
    ok: !bad.length,
    detail: `${cloud ? '云端' : `本机${skill ? '(带 calendar-todos 技能)' : '(没有技能)'}`};加待办步数 ${steps.join('/')} ‖ `
      + legs.map((l, i) => `${i + 1}${l.ok ? '✓' : '✗'} ${l.name}:${l.why}`).join(' ‖ '),
    output: legs.map((l, i) => `【${i + 1} ${l.name}】\n${l.ev.content}`).join('\n\n'),
    toolCalls: legs.flatMap((l) => l.ev.toolCalls),
    tokens: legs.reduce((a, l) => a + usage(l.ev), 0) || null,
    todoLegs: legs.map((l) => ({ name: l.name, ok: l.ok, why: l.why, tools: l.ev.toolCalls, args: l.ev.toolArgs.filter((t) => t.name.startsWith('amadeus_') || WRONG_TOOLS.includes(t.name)).map((t) => `${t.name} ${t.arguments}`) })),
  };
}
