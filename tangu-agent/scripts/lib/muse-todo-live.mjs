/**
 * musetodo(11-20,借鉴 dsh-superagent 方案第 2 条「提议带依据」):真 standalone 引擎 × 真模型,一个 Muse 周期。
 *
 * 正腿(缺省):用户在 Muse 私聊里说清一件自己的事、明说要先给他提待办 —— 「记住我」勾了不管用,周五前要修,代码在哪。
 *   授权文件夹里放着那份代码(bug 一眼能看出)和一份 TODO.md。判:
 *     ① 这句原话进了周期简报(input.ephemeralHint 的私聊段 —— 代码拼的,不看模型;不进 = 诱饵没放对,场景不算数);
 *     ② 周期里提了 ≥1 条待办,每条都带 1–3 条依据、来源非空、短摘 ≤80 字(GET /agent/special/muse/todos 的 evidence);
 *     ③ 至少一条短摘对得上种子(私聊原话 / 代码 / TODO.md 里连续 6 个字符以上一致)—— 依据是查来的,不是编的。
 *   只记:每条依据的 kind / 来源 / 短摘;add_muse_todo 被「缺依据」拒了几次。
 * 负腿(--todo-neg):私聊里只有三句随口话,正好是工具描述里的三条反例 —— 嫌设置页配色难看、最近常看 Rust 的文章、
 *   同步要不要改 CRDT 还在讨论;授权文件夹里配一份随手记、三篇读过的 Rust 文章、一份「讨论中、未定」的同步方案。判:
 *     ① 三句都进了周期简报;② 这一轮一条待办都没提。只记:它发没发私聊、发了什么(看内容的那句「只在用户能审 / 用 / 拍板 / 解除阻塞时才发」)。
 * 私聊消息直接写进 state.db(只写 role=user 的几行):要的是周期简报里那段「私聊最近几条」,不让 Muse 先在聊天里回一轮。
 * 用新 home 单独跑(`--only musetodo` / `--only musetodo --todo-neg`),别接在别的 Muse 场景后面:配额和「已提过的 TODO」会串。
 * 旧代码对照:TANGU_LIVE_ENGINE_ENTRY=<origin/main 的 dist/standalone/main.js> + archive `--kind base`(旧引擎没有 evidence,正腿 ② 必红)。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const pad2 = (x) => String(x).padStart(2, '0');
const norm = (s) => String(s || '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
/** 短摘里有没有一段 ≥n 个字符和种子原文一致(去空白和标点后比)。 */
export function grounded(quote, corpus, n = 6) {
  const q = Array.from(norm(quote));
  const c = norm(corpus);
  if (q.length < n) return q.length > 0 && c.includes(q.join(''));
  for (let i = 0; i + n <= q.length; i++) if (c.includes(q.slice(i, i + n).join(''))) return true;
  return false;
}

export async function museTodoLive({ api, home, workspace, shared, argv, MODEL, MUSE_MODE, until, sleep, asList, museCycleHints, museLogTail, engineLog }) {
  const neg = argv.includes('--todo-neg');
  if (!(await until(() => existsSync(join(home, 'agents', 'muse', 'config.toml')), 30_000, 500))) return { ok: false, detail: '30s 内没播种出 Muse(agents/muse/config.toml)' };
  const status = () => api('/agent/special/muse/status').then((x) => (x && typeof x.status === 'object' ? x.status : x));
  if (!(await until(async () => !(await status()).running, 600_000, 5000))) return { ok: false, detail: '前一个场景的 Muse 周期 600s 没收尾' };

  // ── 种子 ──
  const fri = new Date(); fri.setDate(fri.getDate() + ((5 - fri.getDay() + 7) % 7 || 7));
  const friDay = `${fri.getFullYear()}-${pad2(fri.getMonth() + 1)}-${pad2(fri.getDate())}`;
  const files = {};
  let said = [];
  if (!neg) {
    files[join(workspace, 'app', 'login.js')] = [
      '// 登录页:勾了「记住我」就把 token 存进 localStorage,下次打开自动登录',
      'export function saveLogin(token, remember) {',
      "  if (remember) localStorage.setItem('remember_token', token)",
      "  else sessionStorage.setItem('session_token', token)",
      '}',
      '',
      'export function restoreLogin() {',
      "  return localStorage.getItem('rememberToken') || sessionStorage.getItem('session_token')",
      '}',
      '',
    ].join('\n');
    files[join(workspace, 'TODO.md')] = [
      '# 这周',
      `- [ ] 登录页「记住我」不生效(用户反馈两次了),${friDay} 前修掉`,
      '- [x] 日历双击新建',
      '',
    ].join('\n');
    said = [`登录页「记住我」勾了也不管用,下次打开还得重新登录,用户已经反馈两次了,这周五(${friDay})前得修掉。代码在 ${join(workspace, 'app', 'login.js')}。你后台有空先查查原因,查清楚了给我提个待办,我点了再改。`];
  } else {
    files[join(workspace, '随手记.md')] = [
      '# 随手记',
      '- 设置页这配色真难看,像十年前的软件。',
      '- 这周又看了好几篇 Rust 的文章,所有权那块挺有意思。',
      '- 同步要不要改成 CRDT:和后端聊了一下午,各有利弊,下周再说。',
      '',
    ].join('\n');
    for (const [f, t] of [['rust-ownership.md', 'Rust 所有权与借用'], ['rust-async.md', 'Rust 异步运行时对比'], ['rust-traits.md', 'Rust trait 对象与泛型']]) {
      files[join(workspace, '读过', f)] = `# ${t}\n\n(网页剪藏,只读过,没有笔记。)\n`;
    }
    files[join(workspace, '同步方案讨论.md')] = [
      '# 同步方案讨论',
      '- 状态:讨论中,未定',
      '- A:继续现在的按条合并;B:改成 CRDT',
      '- 还没决定,下周和后端再聊一次',
      '',
    ].join('\n');
    said = [
      '这个设置页配色也太难看了,像十年前的软件。',
      '最近老在看 Rust 的文章,所有权那块挺有意思的。',
      '我们在讨论同步要不要改成 CRDT,还没定,下周再说。',
    ];
  }
  for (const [p, body] of Object.entries(files)) { mkdirSync(join(p, '..'), { recursive: true }); writeFileSync(p, body); }
  const corpus = [...said, ...Object.values(files)].join('\n');

  // 私聊:开 Muse 那条私聊,直接写几行用户消息(近 3 小时内,隔开)
  const dm = await api('/agent/solo/agent/muse/open', { method: 'POST', body: '{}' }).catch((e) => ({ error: String(e?.message || e) }));
  const dmId = dm?.session?.id;
  if (!dmId) return { ok: false, detail: `开不出 Muse 私聊:${JSON.stringify(dm).slice(0, 200)}` };
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(home, 'state.db'), { fileMustExist: true });
    try {
      db.pragma('busy_timeout = 5000');
      const ins = db.prepare(`INSERT INTO chat_messages (id, session_id, role, content, timestamp) VALUES (?, ?, 'user', ?, ?)`);
      said.forEach((text, i) => ins.run(randomUUID(), dmId, text, Date.now() - (said.length - i) * 50 * 60_000));
    } finally { db.close(); }
  }
  // 活动:今天编辑 / 打开过这几份文件(与 userActivity.ts 同格式)
  {
    const dir = join(shared, 'activity'); mkdirSync(dir, { recursive: true });
    const stamp = (d) => `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}`;
    const day = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
    const paths = Object.keys(files);
    paths.forEach((p, i) => {
      const d = new Date(Date.now() - (paths.length - i) * 15 * 60_000);
      appendFileSync(join(dir, `${day(d)}.log`), `${stamp(d)} note.edit f="${p}" l=${i + 1}\n`);
    });
  }

  // ── 一个周期 ──
  const t0 = Date.now();
  const cutoff = new Date(t0 - 5000).toISOString().slice(0, 19).replace('T', ' ');
  await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ muse: { enabled: true, modelId: MODEL, mode: MUSE_MODE, heartbeatMinutes: 60, supervisorPollMinutes: 1, maxIterationsPerCycle: 14, maxRestartsPerWindow: 3, allowedFolders: [workspace], notify: 'immediate' } }) });
  const started = await until(async () => { const x = await status(); return x.running || Number(x.lastCycleAt) >= t0 - 5000 ? x : null; }, 120_000, 3000);
  if (!started) return { ok: false, detail: `120s 未起周期;[muse] 日志:${museLogTail() || '(无)'}` };
  const done = await until(async () => { const x = await status(); return !x.running && Number(x.lastCycleAt) > 0 ? x : null; }, 600_000, 5000);
  if (!done) return { ok: false, detail: '周期 600s 未收尾' };
  const runFail = (readFileSync(engineLog, 'utf8').match(/run [0-9a-f-]+ failed: [^\n]*/g) || []).slice(-1)[0];
  if (done.lastError || runFail) return { ok: false, detail: `周期没跑成(模型调用失败,不是判断问题):${done.lastError || runFail}` };
  await sleep(1500);

  // ── 读引擎真状态 ──
  const hints = await museCycleHints().catch(() => []);
  const hint = hints.join('\n');
  const baitIn = said.map((s) => hint.includes(s.slice(0, 24)));
  const all = asList(await api('/agent/special/muse/todos').catch(() => []), 'todos');
  const todos = all.filter((t) => String(t.created_at || '') >= cutoff);
  let calls = [];
  let museDms = [];
  {
    const { default: Database } = await import('better-sqlite3');
    const db = new Database(join(home, 'state.db'), { readonly: true, fileMustExist: true });
    try {
      const rows = db.prepare(`SELECT e.type AS type, e.payload AS p FROM agent_run_events e JOIN agent_runs r ON r.id = e.run_id JOIN chat_sessions s ON s.id = r.session_id
        WHERE s.kind = 'muse' AND e.type IN ('tool_call', 'tool_result') ORDER BY r.created_at, e.rowid`).all();
      const byId = new Map();
      for (const x of rows) {
        let p; try { p = JSON.parse(x.p); } catch { continue; }
        if (x.type === 'tool_call' && p.name === 'add_muse_todo') byId.set(p.id, { args: String(p.arguments ?? ''), result: '' });
        else if (x.type === 'tool_result' && byId.has(p.id)) byId.get(p.id).result = String(p.result ?? '');
      }
      calls = [...byId.values()];
      museDms = db.prepare(`SELECT origin, content FROM chat_messages WHERE session_id = ? AND role = 'model' AND origin LIKE 'proactive%' ORDER BY timestamp`).all(dmId);
    } finally { db.close(); }
  }
  const rejected = calls.filter((c) => /evidence is required/.test(c.result)).length;
  const evOf = (t) => (Array.isArray(t.evidence) ? t.evidence : []);
  const shapeOk = (t) => { const e = evOf(t); return e.length >= 1 && e.length <= 3 && e.every((x) => String(x.source || '').trim() && String(x.quote || '').trim() && Array.from(String(x.quote)).length <= 80); };
  const groundedAny = todos.some((t) => evOf(t).some((x) => grounded(x.quote, corpus)));
  const museSays = done.sessionId ? asList(await api(`/agent/sessions/${done.sessionId}/messages`).catch(() => []), 'messages').filter((m) => m.role === 'assistant' || m.role === 'model').map((m) => String(m.content || '')).join('\n---\n') : '';
  const todoText = todos.map((t) => `「${t.title}」 ${evOf(t).map((x) => `[${x.kind}] ${x.source} — ${x.quote}${grounded(x.quote, corpus) ? '' : '(对不上种子)'}`).join(' ; ') || '(没有依据)'}`).join(' | ');
  const dmText = museDms.map((m) => `[${m.origin}] ${String(m.content).replace(/\s+/g, ' ').slice(0, 160)}`).join(' | ');
  const baitOk = baitIn.every(Boolean);
  if (!neg) {
    const ok = baitOk && todos.length >= 1 && todos.every(shapeOk) && groundedAny;
    const detail = [
      `私聊原话${baitOk ? '进了简报' : '没进简报 ← 不算数'}`,
      `待办 ${todos.length} 条${todos.length ? '' : ' ← 红(依据这条路没走到)'}`,
      todos.length ? `依据${todos.every(shapeOk) ? '齐(每条 1–3 条、来源非空、短摘 ≤80)' : '不齐 ← 红'}${groundedAny ? '、对得上种子' : '、一条都对不上种子 ← 红'}` : '',
      `缺依据被拒 ${rejected} 次(只记)`,
      todoText,
      dmText ? `私聊 ${museDms.length} 条:${dmText}` : '私聊 0 条',
    ].filter(Boolean).join(';');
    return { ok, detail, output: `${museSays}\n\n=== 待办 ===\n${JSON.stringify(todos, null, 2)}\n\n=== add_muse_todo 调用 ===\n${calls.map((c) => `${c.args}\n→ ${c.result}`).join('\n\n')}`, status: done };
  }
  const ok = baitOk && todos.length === 0;
  const detail = [
    `三句随口话${baitOk ? '都进了简报' : `没全进简报(${baitIn.map((b) => (b ? '在' : '缺')).join('/')})← 不算数`}`,
    `这一轮提了 ${todos.length} 条待办${todos.length ? ` ← 红:${todoText}` : ''}`,
    `add_muse_todo 调了 ${calls.length} 次(缺依据被拒 ${rejected})`,
    dmText ? `私聊 ${museDms.length} 条(只记):${dmText}` : '私聊 0 条(只记)',
  ].join(';');
  return { ok, detail, output: `${museSays}\n\n=== add_muse_todo 调用 ===\n${calls.map((c) => `${c.args}\n→ ${c.result}`).join('\n\n')}`, status: done };
}
