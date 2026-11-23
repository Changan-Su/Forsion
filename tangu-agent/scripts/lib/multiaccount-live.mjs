/**
 * multiaccount(2026-11-23,多账号模式第二步):一台多账号引擎(TANGU_MULTI_ACCOUNT=1)上两个账号,真模型。
 *
 *  自己起一台引擎(独立隔离 home,主台架那台不参与),带一个夹具插件包(技能 word-stats,脚本 scripts/stats.py)。三条腿:
 *   ① 文件与搜索:alice 在自己的工作目录建 notes/plan.md(内容带一串只有 alice 那边有的随机码),再用搜索工具找回它;
 *      bob 去搜同一个前缀、再试着读 alice 那份文件的绝对路径。
 *   ② 插件脚本:alice 用 word-stats 技能统计 notes/plan.md,把脚本输出的 digest 说出来(digest 由台架独立算,模型不跑脚本猜不到)。
 *   ③ 自己写的脚本:bob 写一个 hello.py(运行时会在工作目录里写 ran-by-bob.txt),再试着用 run_plugin_script 跑它。
 *
 * 判据(只看磁盘和账号库,不信模型自述):
 *   - plan.md 落在 alice 的账号文件夹里;alice 的搜索工具调用成功、结果里有 plan.md;
 *   - bob 的任何工具结果和回答里都没有 alice 的随机码;bob 的账号文件夹里也没有;
 *   - alice 的 run_plugin_script 调用退出码 0,stats.json 落在 alice 的工作目录里,回答里有正确的 digest;
 *   - ran-by-bob.txt 不存在(bob 自己写的脚本没跑起来),bob 那次 run_plugin_script 回的是错误;
 *   - 所有 run 都跑到 done。
 * 凭证:多账号模式只认 env / 命令行 / --providers-file 给的直连 provider。从 provider-auth.json 的 Codex 订阅登录拼一份
 *       providers 文件(不带 oauth 标记 = 引擎不续期,台架跑完前 token 不过期即可),放在系统临时目录,不进归档,跑完删掉。
 * 负对照:`--multiaccount-off-script` 让夹具技能的 SKILL.md 不提脚本、只写「自己算」→ ② 的 digest 须对不上(模型没有别的办法算出来)。
 */
import { spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TERMINAL = new Set(['done', 'failed', 'aborted', 'interrupted']);

const STATS_PY = `import hashlib, json, os, sys

if len(sys.argv) < 2:
    print("usage: stats.py <file>", file=sys.stderr)
    sys.exit(2)
src = sys.argv[1]
with open(src, "rb") as f:
    data = f.read()
text = data.decode("utf-8", "replace")
digest = hashlib.sha256(data).hexdigest()[:12]
out = {"file": os.path.basename(src), "lines": len(text.splitlines()), "words": len(text.split()), "digest": digest}
with open("stats.json", "w") as f:
    json.dump(out, f)
print(json.dumps(out))
`;

function skillMd(offScript) {
  const head = '---\nname: word-stats\ndescription: Count lines and words of a text file and give its content digest.\n---\n\n';
  if (offScript) return `${head}# Word stats\n\nRead the file and count lines and words yourself. Report a digest of the content as well.\n`;
  return `${head}# Word stats\n\nThis skill ships a script that does the work: \`scripts/stats.py <file>\`. It prints one JSON line with \`lines\`, \`words\` and \`digest\`, and writes \`stats.json\` in the working directory.\n\n`
    + '- With the `run_plugin_script` tool: `run_plugin_script({ "skill": "word-stats", "script": "scripts/stats.py", "args": ["<file>"] })`.\n'
    + '- Without it: run `python3 <this skill folder>/scripts/stats.py <file>` in a shell.\n\n'
    + 'Always run the script; never estimate the digest yourself. Report the digest exactly as printed.\n';
}

/** 递归找某个名字的文件(判据用)。 */
function findNamed(dir, name) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p); else if (e.name === name) hits.push(p);
    }
  };
  walk(dir);
  return hits;
}

/** 递归找含某串的文件(只看小文本文件;判据用)。 */
function grepTree(dir, needle, max = 2_000_000) {
  const hits = [];
  const walk = (d) => {
    let ents = [];
    try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = join(d, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.isFile()) continue;
      try { if (statSync(p).size > max) continue; if (readFileSync(p).includes(needle)) hits.push(p); } catch { /* 读不到 */ }
    }
  };
  walk(dir);
  return hits;
}

export async function multiAccountLive({ entry, AUTH, MODEL, OUT, argv = [] }) {
  const offScript = argv.includes('--multiaccount-off-script');
  const Database = createRequire(import.meta.url)('better-sqlite3');
  const [providerId, ...rest] = String(MODEL).split('/');
  const modelName = rest.join('/');
  if (providerId !== 'codex' || !modelName) throw new Error(`multiaccount 只接 codex/<模型>(这次是 ${MODEL}):凭证从 Codex 订阅登录拼`);

  const root = join(OUT, 'multiaccount-home');
  const home = join(root, 'engine');
  const bundle = join(root, 'bundles', 'word-stats-plugin');
  const ev = join(OUT, 'multiaccount-evidence');
  mkdirSync(home, { recursive: true }); mkdirSync(ev, { recursive: true });
  mkdirSync(join(bundle, 'skills', 'word-stats', 'scripts'), { recursive: true });
  writeFileSync(join(bundle, 'manifest.json'), JSON.stringify({ id: 'word-stats-plugin', name: 'Word stats', version: '1.0.0' }));
  writeFileSync(join(bundle, 'skills', 'word-stats', 'SKILL.md'), skillMd(offScript));
  writeFileSync(join(bundle, 'skills', 'word-stats', 'scripts', 'stats.py'), STATS_PY);

  // 凭证:系统临时目录里的 providers 文件(0600),不进 OUT
  const credDir = mkdtempSync(join(tmpdir(), 'tangu-ma-live-'));
  const providersFile = join(credDir, 'providers.json');
  const auth = JSON.parse(readFileSync(AUTH, 'utf8'));
  const c = auth?.codex;
  if (!c?.access_token || !c?.account_id) { rmSync(credDir, { recursive: true, force: true }); throw new Error('provider-auth.json 里没有 Codex 订阅登录'); }
  writeFileSync(providersFile, JSON.stringify([{
    providerId: 'codex', baseUrl: c.baseUrl || 'https://chatgpt.com/backend-api/codex', protocol: 'openai-responses',
    apiKey: c.access_token, accountId: c.account_id, modelIds: [modelName],
  }]), { mode: 0o600 });
  chmodSync(providersFile, 0o600);

  const TOKEN = randomUUID();
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('TANGU_') && k !== 'DATABASE_URL'));
  Object.assign(env, {
    TANGU_MULTI_ACCOUNT: '1', TANGU_HOME: home, TANGU_LOCAL_TOKEN: TOKEN, TANGU_HOST: '127.0.0.1', TANGU_PORT: '0',
    TANGU_SANDBOX: 'none', TANGU_BROWSER_CDP: 'off', TANGU_BROWSER_EXTENSION: '0',
    TANGU_PROVIDERS_FILE: providersFile, TANGU_BUNDLE_DIRS: JSON.stringify([bundle]),
    FORSION_DESKTOP_CONFIG: join(root, 'userData', 'tangu-desktop-config.json'),
  });
  const log = join(ev, 'engine.log');
  const child = spawn(process.execPath, [entry], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  child.stdout.on('data', (d) => appendFileSync(log, d));
  child.stderr.on('data', (d) => appendFileSync(log, d));
  const exited = new Promise((r) => child.once('exit', r));

  const accounts = { alice: `alice-${randomUUID().slice(0, 6)}`, bob: `bob-${randomUUID().slice(0, 6)}` };
  const acctHome = (who) => join(home, 'accounts', accounts[who]);
  const db = (who, fn) => { const d = new Database(join(acctHome(who), 'state.db'), { readonly: true, fileMustExist: true }); try { d.pragma('busy_timeout = 5000'); return fn(d); } finally { d.close(); } };
  const parse = (s) => { try { return JSON.parse(s || 'null'); } catch { return null; } };

  try {
    const port = await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`多账号引擎 60s 内没就绪:${existsSync(log) ? readFileSync(log, 'utf8').slice(-800) : ''}`)), 60_000);
      child.on('message', (m) => { if (m?.type === 'tangu:ready') { clearTimeout(t); resolve(m.port); } });
      child.once('exit', (code) => { clearTimeout(t); reject(new Error(`多账号引擎退出(code ${code}):${existsSync(log) ? readFileSync(log, 'utf8').slice(-800) : ''}`)); });
    });
    const base = `http://127.0.0.1:${port}`;
    const H = (who) => ({ Authorization: `Bearer ${TOKEN}`, 'X-Forsion-User': accounts[who], 'Content-Type': 'application/json' });
    const health = await fetch(`${base}/health`).then((r) => r.json()).catch(() => null);

    // 模型目录里有目标模型(凭证装上了)
    for (let i = 0; ; i++) {
      const cat = await fetch(`${base}/agent/models`, { headers: H('alice') }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      const list = Array.isArray(cat) ? cat : cat?.models || [];
      if (list.some((m) => m.id === MODEL)) break;
      if (i > 60) throw new Error(`30s 内模型目录里没有 ${MODEL}`);
      await sleep(500);
    }

    /** 一轮:建 run、等它到终态,收工具调用 / 结果和回答。 */
    async function turn(who, message, sessionId = randomUUID()) {
      const r = await fetch(`${base}/agent/runs`, {
        method: 'POST', headers: H(who),
        body: JSON.stringify({ session_id: sessionId, model_id: MODEL, message, agent_config: { approvalMode: 'full-auto' } }),
      });
      const created = await r.json().catch(() => null);
      const runId = created?.runId || created?.run_id;
      if (!r.ok || !runId) throw new Error(`${who} 建 run 失败(${r.status}):${JSON.stringify(created).slice(0, 200)}`);
      let row;
      for (let t = 0; ; t += 1000) {
        row = db(who, (d) => d.prepare('SELECT status, error FROM agent_runs WHERE id = ?').get(runId));
        if (TERMINAL.has(row?.status)) break;
        if (t > 600_000) throw new Error(`${who} 的 run 600s 没结束`);
        await sleep(1000);
      }
      const events = db(who, (d) => d.prepare(`SELECT type, payload FROM agent_run_events WHERE run_id = ? AND type IN ('tool_call','tool_result') ORDER BY created_at, rowid`).all(runId))
        .map((x) => ({ type: x.type, p: parse(x.payload) || {} }));
      const calls = events.filter((e) => e.type === 'tool_call').map((e) => ({ name: e.p.name, args: typeof e.p.arguments === 'string' ? e.p.arguments : JSON.stringify(e.p.arguments ?? '') }));
      const results = events.filter((e) => e.type === 'tool_result').map((e) => ({ name: e.p.name, isError: !!e.p.isError, result: String(e.p.result ?? '') }));
      const answer = db(who, (d) => d.prepare(`SELECT content FROM chat_messages WHERE session_id = ? AND role <> 'user' ORDER BY timestamp DESC LIMIT 1`).get(sessionId))?.content || '';
      return { who, runId, sessionId, status: row?.status, error: row?.error || null, calls, results, answer };
    }
    const brief = (t) => `[${t.who} ${t.status}${t.error ? ` ${t.error}` : ''}] 调用:${t.calls.map((c) => c.name).join(', ') || '无'}`;

    // ── ① 文件与搜索 ──
    const secret = `ALICE-SECRET-${randomUUID().slice(0, 8).toUpperCase()}`;
    const a1 = await turn('alice', `请在当前工作目录里新建文件 notes/plan.md,内容三行:\n# Plan\n${secret}\nship the beta on Friday\n`
      + '写好以后,用搜索文件内容的工具在工作目录里搜「ALICE-SECRET-」,告诉我它在哪个文件里。');
    const planHits = grepTree(acctHome('alice'), secret).filter((p) => p.endsWith('plan.md'));
    const planPath = planHits[0] || null;
    const aliceSearch = a1.results.filter((r) => /search_files|glob_files/.test(r.name));
    const b1 = await turn('bob', '用搜索文件内容的工具在你的工作目录里搜「ALICE-SECRET-」,把搜到的整行原样告诉我。'
      + (planPath ? `然后试着读一下这个文件:${planPath},把内容原样告诉我。` : ''));
    const bobSaw = [b1.answer, ...b1.results.map((r) => r.result)].some((s) => s.includes(secret));
    const bobDisk = grepTree(acctHome('bob'), secret);

    // ── ② 插件脚本 ──
    const planBytes = planPath ? readFileSync(planPath) : null;
    const expectDigest = planBytes ? createHash('sha256').update(planBytes).digest('hex').slice(0, 12) : null;
    const a2 = await turn('alice', '用 word-stats 技能统计一下工作目录里 notes/plan.md 的行数和字数,并把它给出的 digest 原样告诉我。', a1.sessionId);
    const scriptCalls = a2.results.filter((r) => r.name === 'run_plugin_script');
    const scriptOk = scriptCalls.some((r) => !r.isError && /exit code: 0/.test(r.result));
    const statsHits = grepTree(acctHome('alice'), '"digest"').filter((p) => p.endsWith('stats.json'));
    const digestSaid = !!expectDigest && a2.answer.includes(expectDigest);

    // ── ③ 自己写的脚本 ──
    const b2 = await turn('bob', '请在当前工作目录写一个 hello.py,内容是:\nopen("ran-by-bob.txt", "w").write("hi")\nprint("hello")\n'
      + '然后用 run_plugin_script 工具运行这个 hello.py(skill 随便填,script 填它的绝对路径),告诉我结果。');
    const bobRan = findNamed(join(home, 'accounts'), 'ran-by-bob.txt').length > 0;
    const bobScriptCalls = b2.results.filter((r) => r.name === 'run_plugin_script');
    const bobRefused = bobScriptCalls.length > 0 && bobScriptCalls.every((r) => r.isError || /^Error:/.test(r.result));

    const turns = [a1, b1, a2, b2];
    const checks = {
      allDone: turns.every((t) => t.status === 'done'),
      planInAlice: !!planPath && relative(acctHome('alice'), planPath).split(/[\\/]/)[0] !== '..',
      aliceSearchFound: aliceSearch.some((r) => !r.isError && r.result.includes('plan.md')),
      bobSawNothing: !bobSaw,
      bobDiskClean: bobDisk.length === 0,
      ...(offScript ? {} : { scriptRanOk: scriptOk, statsJsonInAlice: statsHits.length > 0 }),
      digestCorrect: digestSaid,
      bobScriptNotRun: !bobRan,
      bobScriptRefused: bobRefused || bobScriptCalls.length === 0,
    };
    const ok = Object.values(checks).every(Boolean);
    writeFileSync(join(OUT, 'multiaccount-evidence.json'), JSON.stringify({
      offScript, health, accounts, secret, planPath, expectDigest, statsHits, bobDisk, checks,
      turns: turns.map((t) => ({ ...t, results: t.results.map((r) => ({ ...r, result: r.result.slice(0, 2000) })) })),
    }, null, 2));
    const detail = `${offScript ? '负对照(技能不提脚本)' : '正式'}:${turns.map(brief).join(' | ')};`
      + `plan.md ${checks.planInAlice ? '在 alice 文件夹' : '没落在 alice 文件夹'};alice 搜索${checks.aliceSearchFound ? '找到' : '没找到'};`
      + `bob ${bobSaw ? '看到了 alice 的随机码' : '没看到 alice 的随机码'}、盘上 ${bobDisk.length} 处;`
      + `插件脚本 ${scriptCalls.length} 次(${scriptOk ? '退出码 0' : '没成功'})、stats.json ${statsHits.length} 份、digest ${digestSaid ? '对' : `不对(应为 ${expectDigest})`};`
      + `bob 自写脚本 ${bobRan ? '跑起来了' : '没跑'}(run_plugin_script ${bobScriptCalls.length} 次${bobRefused ? '、均被拒' : ''})`;
    const output = turns.map((t) => `【${t.who}】${t.answer.slice(0, 600)}\n  调用:${t.calls.map((x) => `${x.name} ${x.args.slice(0, 140)}`).join('\n        ') || '无'}`).join('\n\n');
    return { ok, detail, output, checks, toolCalls: turns.reduce((n, t) => n + t.calls.length, 0) };
  } finally {
    rmSync(credDir, { recursive: true, force: true });
    if (child.exitCode === null && !child.signalCode) {
      child.kill('SIGTERM');
      await Promise.race([exited, sleep(8000)]);
      if (child.exitCode === null && !child.signalCode) { child.kill('SIGKILL'); await exited; }
    }
  }
}
