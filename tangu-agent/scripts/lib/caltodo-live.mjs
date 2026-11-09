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
 *  Negative control (run it when touching this): the engine before 11-07 (start required, undated rows skipped by list) — leg 1 goes red.
 *
 *  Local engine only, two more legs (11-09). In a real session the agent was asked for a to-do "later today": it took the to-do Space it saw
 *  in the interface commands for a data store and said it could not write to it, then picked one of three calendars that was not the default
 *  one, with a start time that had already passed.
 *   4. later — two more calendars (both with a checkbox column) are put in the vault for this leg only, and the run is a desktop client with a
 *              `set-active-space` command whose state lists a to-do Space. 「帮我加一条待办：今天晚一点给房东回个电话。」: one new row in the
 *              default calendar, the other calendars untouched, no file / note / "cannot do it", and a start that is not before the moment the
 *              leg began (a date without a time must be today or later; no date at all is reported, not red).
 *              "Later today" at ten in the morning passes with any guessed evening time, so live-harness pins the engine's clock to the evening
 *              (`--later-hour`, default 22). `--caltodo-later-only` runs this leg alone; `--later-msg "…"` tries another wording (keep 房东 / 电话 in it).
 *   5. named — same setup, 「帮我加个日程：今天 N 点给物业打个电话。」 with N two hours before the engine's clock. Adding it is fine (it may be
 *              a record), asking first is fine; red = the past time is written and the reply says nothing about it having passed, or nothing
 *              is written and nothing is said. Skipped before 03:00 on the engine's clock.
 *  Negative control for legs 4–5: the same legs on the engine without the default-calendar mark / past-start note (`--kind base`). On
 *  2026-11-09 leg 4 was green there too with GPT 6 Luna (it writes today's date without a time). */
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';

const ADD = '帮我添加两条待办：开发票；完成 Curve Wallet 的身份验证（邮件在 Gmail）';
const LIST = '我现在还有哪些待办？';
const TICK = '开发票那条我已经弄完了，帮我勾掉。';
const MAX_STEPS = 6;
/** Wrong destinations for a to-do: a file / note, or the session's own checklist. */
const WRONG_TOOLS = ['write_file', 'edit_file', 'multi_edit', 'apply_patch', 'amadeus_write_note', 'todo_write'];
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
const LATER = '帮我加一条待办：今天晚一点给房东回个电话。';
const MAX_STEPS_LATER = 8;
const CANNOT = /做不到|无法(添加|写入|创建)|没有办法|不支持(添加|写入)|没有(可用的)?(写入|添加)[^。，,\n]{0,6}(接口|工具|命令)|can(no|')t (add|write|create)/i;
/** Two more calendars, the way a vault with a few of them looks; both could hold a to-do, neither is the default one. */
const decoyCalendars = () => ({
  '工作日程.db': {
    version: 2, name: '工作日程',
    columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }],
    rows: [{ id: 'work-review', cells: { name: '季度复盘', date: `${day(3)}T15:00/${day(3)}T16:00` } }, { id: 'work-report', cells: { name: '交周报' } }],
  },
  '家庭.db': {
    version: 2, name: '家庭日历',
    columns: [{ id: 'name', name: '名称', type: 'text' }, { id: 'date', name: '日期', type: 'calendarDate' }, { id: 'done', name: '完成', type: 'checkbox' }],
    rows: [{ id: 'home-birthday', cells: { name: '妈妈生日', date: day(12) } }],
  },
});
/** What a desktop client reports for switching Space (description as in desktop bootstrapEngine); the state lists a to-do Space. */
const SPACE_COMMAND = {
  id: 'set-active-space',
  description: 'Switch the window the user is talking to you from to another Space (workspace layout). Only ids listed in `state` exist on this device — Spaces differ per device and per install.',
  params: { type: 'object', properties: { id: { type: 'string', description: "Space id, one of the ids listed in this entry's state." } }, required: ['id'] },
  state: 'active=chat; available=home,chat,amadeus,forsion-calendar,forsion-todo,muse',
};
/** The engine's wall clock as YYYY-MM-DDTHH:mm (the format of a start), from its offset to UTC. */
const wallClock = (offsetMin) => new Date(Date.now() + offsetMin * 60_000).toISOString().slice(0, 16);
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
export async function calTodoLive({ run, rounds = 1, home, workspace, vault, cloud, token, skill, tzOffsetMin = 0, laterOnly = false, laterMsg = LATER }) {
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

    if (cloud || !laterOnly) {
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

    // 4. "later today", with three calendars and the interface commands in view (local engine only)
    if (!cloud) {
      const decoys = Object.entries(decoyCalendars()).map(([file, db]) => ({ file: join(vault, file), text: `${JSON.stringify(db, null, 2)}\n` }));
      for (const d of decoys) writeFileSync(d.file, d.text);
      try {
        const calBefore = await readCal();
        const notesBefore4 = await notes();
        const t0 = wallClock(tzOffsetMin);
        const later = await run(sid('later'), laterMsg, 300_000, cfg, 'desktop/live-harness', undefined, undefined, undefined, { ...ZH, uiCommands: [SPACE_COMMAND] });
        const calAfter = await readCal();
        const added4 = (calAfter?.rows || []).filter((r) => !calBefore.rows.some((s) => s.id === r.id));
        const row = added4.find((r) => /房东|电话/.test(String(r.cells?.name)));
        const start = typeof row?.cells?.date === 'string' && row.cells.date ? row.cells.date.split('/')[0] : null;
        const past = !!start && (start.includes('T') ? start < t0 : start < t0.slice(0, 10));
        const restIntact = calBefore.rows.every((s) => same(calAfter?.rows?.find((r) => r.id === s.id), s));
        const strayed = decoys.filter((d) => !existsSync(d.file) || readFileSync(d.file, 'utf8') !== d.text).map((d) => relative(vault, d.file));
        const wrong4 = WRONG_TOOLS.filter((n) => okCalls(later, n));
        const newNotes4 = (await notes()).filter((p) => !notesBefore4.includes(p));
        const gaveUp = DENIES.test(later.content || '') || (!row && CANNOT.test(later.content || '')); // 写进去了还说一句「做不到提醒」不算放弃
        const warned = later.toolResults.filter((r) => /^amadeus_(create|edit)_event$/.test(r.name) && /in the past/i.test(r.full || '')).length;
        const asked = (n) => later.toolCalls.filter((t) => t === n).length;
        leg(`${tag}「今天晚一点」进缺省日历、时间没过`,
          !later.error && added4.length === 1 && !!row && row.cells.done !== true && !past && restIntact && !strayed.length
            && later.toolCalls.length <= MAX_STEPS_LATER && !wrong4.length && !newNotes4.length && !gaveUp,
          later.error || `引擎时钟 ${t0};${later.toolCalls.length} 步(${later.toolCalls.join('→') || '无'})${later.toolCalls.length > MAX_STEPS_LATER ? ` ✗ 超过 ${MAX_STEPS_LATER}` : ''}`
            + `;缺省日历新行 ${added4.length}:${added4.map((r) => JSON.stringify(r.cells)).join(' / ') || '✗ 没有'}${added4.length === 1 && !row ? ';✗ 标题对不上' : ''}`
            + `${row ? (start ? (past ? `;✗ 开始时间 ${start} 早于现在` : `;开始时间 ${start} 没过`) : ';没带日期(不计红)') : ''}${row?.cells?.done === true ? ';✗ 勾上了' : ''}`
            + `${strayed.length ? `;✗ 写进了别的日历 ${strayed.join(',')}` : ''}${restIntact ? '' : ';✗ 原有行被改'}${wrong4.length ? `;✗ 写到了 ${wrong4.join('/')}` : ''}`
            + `${newNotes4.length ? `;✗ 新笔记 ${newNotes4.join(',')}` : ''}${gaveUp ? ';✗ 说做不到' : ''}`
            + `;过去时间提醒 ${warned} 次,get_datetime ${asked('get_datetime')} 次,list_ui_commands ${asked('list_ui_commands')} 次,run_ui_command ${asked('run_ui_command')} 次`
            + `${WRONG_TOOLS.some(asked) ? `;试过 ${WRONG_TOOLS.filter(asked).join('/')}(没写成的不计红,参数见 todoLegs)` : ''}`,
          later);

        // 5. the user names an hour that has already passed today: writing it is fine, saying nothing about it is not
        const t5 = wallClock(tzOffsetMin);
        const hour = Number(t5.slice(11, 13)) - 2;
        if (hour >= 1) {
          const cal5 = await readCal();
          const notesBefore5 = await notes();
          const named = await run(sid('named'), `帮我加个日程：今天 ${hour} 点给物业打个电话。`, 300_000, cfg, 'desktop/live-harness', undefined, undefined, undefined, { ...ZH, uiCommands: [SPACE_COMMAND] });
          const cal5After = await readCal();
          const added5 = (cal5After?.rows || []).filter((r) => !cal5.rows.some((s) => s.id === r.id));
          const row5 = added5.find((r) => /物业/.test(String(r.cells?.name)));
          const start5 = typeof row5?.cells?.date === 'string' && row5.cells.date ? row5.cells.date.split('/')[0] : null;
          const past5 = !!start5 && (start5.includes('T') ? start5 < t5 : start5 < t5.slice(0, 10));
          const said = /已经?过|过去|已过|过了|早于(现在|当前)|passed|in the past/i.test(named.content || '');
          const calls5 = (n) => named.toolCalls.filter((t) => t === n).length;
          const silent = !!row5 && past5 && !said; // 悄悄写了一个已经过去的时刻
          const nothing = !row5 && !said && !calls5('ask_user'); // 没写,也没说为什么、没问
          const rest5 = cal5.rows.every((s) => same(cal5After?.rows?.find((r) => r.id === s.id), s));
          const strayed5 = decoys.filter((d) => !existsSync(d.file) || readFileSync(d.file, 'utf8') !== d.text).map((d) => relative(vault, d.file));
          const wrong5 = WRONG_TOOLS.filter((n) => okCalls(named, n));
          const newNotes5 = (await notes()).filter((p) => !notesBefore5.includes(p));
          const warned5 = named.toolResults.filter((r) => /^amadeus_(create|edit)_event$/.test(r.name) && /in the past/i.test(r.full || '')).length;
          leg(`${tag}点名的时刻已经过去:不悄悄写`,
            !named.error && !silent && !nothing && added5.length <= 1 && (added5.length === 0 || !!row5) && rest5 && !strayed5.length
              && named.toolCalls.length <= MAX_STEPS_LATER && !wrong5.length && !newNotes5.length,
            named.error || `引擎时钟 ${t5},点名今天 ${hour} 点;${named.toolCalls.length} 步(${named.toolCalls.join('→') || '无'})${named.toolCalls.length > MAX_STEPS_LATER ? ` ✗ 超过 ${MAX_STEPS_LATER}` : ''}`
              + `;缺省日历新行 ${added5.length}:${added5.map((r) => JSON.stringify(r.cells)).join(' / ') || '没写'}${added5.length && !row5 ? ';✗ 标题对不上' : ''}`
              + `;回复${said ? '说了时间已过' : '没提时间已过'}${calls5('ask_user') ? ',问了用户' : ''}${silent ? ';✗ 悄悄写了已经过去的时刻' : ''}${nothing ? ';✗ 没写也没说' : ''}`
              + `${strayed5.length ? `;✗ 写进了别的日历 ${strayed5.join(',')}` : ''}${rest5 ? '' : ';✗ 原有行被改'}${wrong5.length ? `;✗ 写到了 ${wrong5.join('/')}` : ''}${newNotes5.length ? `;✗ 新笔记 ${newNotes5.join(',')}` : ''}`
              + `;过去时间提醒 ${warned5} 次,get_datetime ${calls5('get_datetime')} 次`,
            named);
        }
      } finally {
        for (const d of decoys) rmSync(d.file, { force: true });
      }
    }
  }

  const bad = legs.filter((l) => !l.ok);
  return {
    ok: !bad.length,
    detail: `${cloud ? '云端' : `本机${skill ? '(带 calendar-todos 技能)' : '(没有技能)'}`};加待办步数 ${steps.join('/')} ‖ `
      + legs.map((l, i) => `${i + 1}${l.ok ? '✓' : '✗'} ${l.name}:${l.why}`).join(' ‖ '),
    output: legs.map((l, i) => `【${i + 1} ${l.name}】\n${l.ev.content}`).join('\n\n'),
    toolCalls: legs.flatMap((l) => l.ev.toolCalls),
    tokens: legs.reduce((a, l) => a + usage(l.ev), 0) || null,
    todoLegs: legs.map((l) => ({ name: l.name, ok: l.ok, why: l.why, tools: l.ev.toolCalls, args: l.ev.toolArgs.filter((t) => t.name.startsWith('amadeus_') || t.name === 'run_ui_command' || WRONG_TOOLS.includes(t.name)).map((t) => `${t.name} ${t.arguments}`) })),
  };
}
