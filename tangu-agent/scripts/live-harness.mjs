#!/usr/bin/env node
/**
 * 真模型 live 台架:真 standalone 引擎 × Codex 直连(缺省 codex/gpt-5.6-luna)× 隔离 home。
 * 补的是「假引擎 / vi.fn 模型」测不到的那一层:harness 稳定性(工具回合、压缩)、
 * Historian → 候选 → Dream 整固 → 新会话回忆、Muse 心跳周期。每条场景 PASS/FAIL + 墙钟 + 首帧,
 * 模型原话进 report.md 供人读(「实际体验」只能靠这个感知,几何断言看不出来)。
 *
 *   npm run build && npm run live:harness                    # 全部场景(约 5-10 分钟,真烧订阅额度)
 *   npm run live:harness -- --only chat,tool,muse            # 子集(historian→dream→recall 三连有先后依赖)
 *   npm run live:harness -- --only chat,tool,loop            # loop = 轮数耗尽末轮收尾(改 agentLoop 末轮/收尾提示后跑)
 *   TANGU_LIVE_MODEL=codex/gpt-5.6-sol npm run live:harness  # 换模型
 *   npm run live:harness -- --only historian,dream,muse --muse-mode auto   # Muse 三档:ask(缺省)|agent|auto
 *   npm run live:harness -- --only chat,tool --exec-mode sandbox           # 负对照:sandbox 模式下工具走云工作区,未登录应报错而非假空目录
 *   npm run live:harness -- --only conflict                  # 改 skills/amadeus-note-format(同步冲突副本合并)后跑:技能装载 + 双向并集 + 画布对不动
 *   npm run live:harness -- --only cache                     # 前缀缓存命中(A/B/B′/C/D + head hash 探针);token 节省看 scripts/cache-hit-report.mjs
 *   npm run live:harness -- --only recall-unprompted --ab-memory   # B1 行为闸:记忆易变段走 tail vs system 各跑一遍(两次引擎启动,顺序)
 *   npm run live:harness -- --only deferred                  # E2 按需装载:load_tools 先于 read_document + 子代理 read_document 直通 + 子代理自己 load_tools 解锁 browser_snapshot
 *   npm run live:harness -- --only grant                     # 改 delegate.grantTools / 子代理管理面闸后跑:授予时子代理用得上 manage_schedule,不授予时照旧被拒(正负两跑,均 action=list 无副作用)
 *   npm run live:harness -- --only churn                     # 同会话 6 连发的后续调用命中画像(不设命中率阈值,六个 run 须跑完)
 *   node scripts/live-harness.mjs --selftest                 # 纯判据(done 锚点 / load_tools 措辞 / 子代理归属)的负对照;不起引擎、不需凭证
 *
 * 凭证:把 ~/.forsion-dev/provider-auth.json(--auth 可改)**软链**进隔离共享域 —— 引擎自己读,本脚本不读;
 * 到期刷新写回同一文件,和开第二个桌面实例的行为一致。绝不碰 ~/.forsion-dev/tangu 的 state.db。
 * 凭证只在引擎启动时装载一次(main.ts loadOAuthDirectProviders),跑到一半 token 过期会 401 —— 台架十来分钟够用,别拿它跑小时级。
 * 产物:<out>/report.md + results.json + engine.log(缺省 os.tmpdir()/tangu-live-<时间戳>/,--out 可改)。
 * 退出码:有 FAIL 或整体超时(--timeout 毫秒,缺省 15 分钟;到点也出报告)= 1。
 * ponytail: 顺序跑、无重试、断言只钉「链路走通 + 事实命中」;模型答偏与引擎坏在 detail 里分开写,不自动重跑。
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, appendFileSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir, homedir } from 'node:os';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fromDb, report as timelineReport } from './stall-timeline.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist', 'standalone', 'main.js');
// --selftest 只跑纯判据,不起引擎 → 未构建的树上也该能跑(否则它会先撞上这条,出一句误导的 dist 缺失)。
if (!existsSync(entry) && !process.argv.includes('--selftest')) { console.error('dist 缺失,先 npm run build'); process.exit(2); }

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const MODEL = opt('model', process.env.TANGU_LIVE_MODEL || 'codex/gpt-5.6-luna');
const AUTH = resolve(opt('auth', process.env.TANGU_LIVE_AUTH || join(homedir(), '.forsion-dev', 'provider-auth.json')));
const KEYS = ['chat', 'tool', 'loop', 'group', 'historian', 'dream', 'recall', 'compact', 'conflict', 'muse', 'cache', 'recall-unprompted', 'deferred', 'churn', 'bigread', 'grant'];
// opt-in:缺省全量跑里**不带**这几个 —— cache 7 个 run / churn 6 个 run(都慢),cache 与 recall-unprompted
// 还会往隔离 home 播记忆行(会进别的场景的系统提示);deferred 要真装 liteparse 解析文档;
// grant 是两个委派 run(慢),且只在动过 delegate.grantTools / 子代理管理面闸时才有信息量。
const OPT_IN = new Set(['cache', 'recall-unprompted', 'deferred', 'churn', 'bigread', 'grant']);
const NEEDS = { dream: ['historian'], recall: ['historian', 'dream'] }; // 记忆链三连有先后依赖;其余场景自包含
const ONLY = new Set(opt('only', process.env.TANGU_LIVE_ONLY || KEYS.filter((k) => !OPT_IN.has(k)).join(',')).split(',').map((s) => s.trim()).filter(Boolean));
{ // --only 写错 / 缺上游 → 直接拒,别跑出 0/0 或靠猜答的假绿(Codex 09-12)
  const bad = [...ONLY].filter((k) => !KEYS.includes(k));
  const missing = [...ONLY].flatMap((k) => (NEEDS[k] || []).filter((d) => !ONLY.has(d)).map((d) => `${k} 需要 ${d}`));
  if (!ONLY.size || bad.length || missing.length) { console.error(`--only 无效:${bad.length ? '未知 ' + bad.join(',') : ''}${missing.length ? ' ' + missing.join(';') : ''}${!ONLY.size ? '为空' : ''};合法值 ${KEYS.join(',')}`); process.exit(2); }
}

// ── 纯判据(不碰引擎/网络/磁盘)。放在这儿是为了 --selftest 能在没凭证、没 OUT 目录的机器上直接跑。 ──

/**
 * done 的 toolOffsets 与本 run 上屏的工具调用一一对应、且落在终稿范围内 —— 桌面 done 时靠它把直播段收敛成重载视图(09-15)。
 * 判据照抄桌面 `desktop/frontend/src/stores/appStore.ts`:
 *  - `segmentsFromHistory`:按 events 顺序游标推进,`at < cursor || at < 0 || at > content.length` 任一命中就**整条回退**旧渲染
 *    → 台架必须同样按 **SSE 调用顺序**验非递减;旧版只验范围,offset [10, 0] 台架绿而桌面红(评审 #5)。
 *  - `settleSegments`:`new Map(toolOffsets.map((o) => [o.id, o.offset]))` —— id 重复会在 Map 里折叠、空 id 匹配不上任何事件,
 *    桌面少渲染一张卡片而台架照绿 → 这里要求 id 非空唯一、两侧集合与**条数**都相等。
 * ⚠️ 桌面**容得下** toolOffsets 是 tool_call 的真子集(`at.has(ev.id)` 过滤掉「流出了参数却没执行」的末轮调用);
 *    台架这边钉死相等,是因为用它的 `tool` 场景不存在被丢弃的调用。将来拿它去判 loop 那种末轮场景要先放开这一条。
 */
const anchorsOk = (ev) => {
  if (!Array.isArray(ev.toolOffsets)) return false;
  const idOk = (x) => typeof x === 'string' && x.length > 0;
  const ids = ev.toolCallIds;
  if (!ids.length || !ids.every(idOk) || new Set(ids).size !== ids.length) return false;
  const offIds = ev.toolOffsets.map((o) => o?.id);
  if (!offIds.every(idOk) || new Set(offIds).size !== offIds.length) return false;
  if (offIds.length !== ids.length) return false; // 条数 + 唯一 + 全覆盖 ⇒ 集合相等
  const at = new Map(ev.toolOffsets.map((o) => [o.id, o.offset]));
  let cursor = 0;
  for (const id of ids) { // SSE 调用顺序 = 桌面 events 顺序
    if (!at.has(id)) return false;
    const off = at.get(id);
    if (!Number.isInteger(off) || off < cursor || off > ev.content.length) return false; // cursor 从 0 起 ⇒ already covers off < 0
    cursor = off;
  }
  return true;
};

/**
 * load_tools 的结果**明确接受**了 browser_snapshot 吗?(loadTools.ts:63-68 的三段式措辞)
 * 只判「结果里出现 browser_snapshot」会把 `No tools loaded. Already available: browser_snapshot.`(继承来的)
 * 和 `Loaded tool(s): calculator. Unavailable in this session: browser_snapshot.`(被拒的)都读成解锁成功。
 * deferGroup 会让一次解锁吐出整个 browser 组,所以按**后两段的字面量**切出「Loaded」段,别用 `[^.]*`(工具名里真有点号就截断了)。
 */
const acceptsSnapshotText = (text) => {
  const s = String(text || '');
  const loadedSeg = s.split(' Already available:')[0].split(' Unavailable in this session:')[0];
  return loadedSeg.includes('Loaded tool(s)') && /\bbrowser_snapshot\b/.test(loadedSeg);
};

/**
 * ③ 的归属判据:**同一个**子代理里,一次非错误且接受了 browser_snapshot 的 load_tools,其后跟着该子代理自己的 browser_snapshot。
 * 只看工具名混着找顺序的话,子代理 A 装载失败后盲调、或 A 装载 B 调用,都能凑出「load_tools 在前」的假绿(评审 #3)。
 * subId 缺失时**不回落**到按名字找(那正是旧的假绿),直接判不成立,由调用方在 detail 里写明「事件缺 subId」。
 */
const findSubUnlock = (subTools) => {
  let unlock = null;
  for (let i = 0; i < subTools.length; i++) {
    const t = subTools[i];
    if (t.name !== 'load_tools' || t.isError || !t.subId || !acceptsSnapshotText(t.preview)) continue;
    if (!unlock) unlock = { load: t, snap: null }; // 解锁成功但没跟调用:形态诊断用
    const snap = subTools.slice(i + 1).find((u) => u.subId === t.subId && u.name === 'browser_snapshot');
    if (snap) return { load: t, snap }; // 快照自身报错(本机没浏览器)不进门 —— 这条验的是解锁通道
  }
  return unlock;
};

/**
 * ③ 的定级。PASS = 同一子代理「load_tools 接受 browser_snapshot → 自己调 browser_snapshot」。
 * INCONCLUSIVE = 父 run 在 delegate **执行完之前**就解锁了 browser_snapshot → 子代理按契约继承,自解锁通道压根没被走到,
 *   判红是假红(评审 #4);记进 row.inconclusive,不计入引擎失败。
 * ⚠️ 「父先解锁」只是执行序(tool_result 到达序)的推断:同轮并发时快的 load_tools 可能先于慢的 delegate 落地、
 *   而子代理其实没继承到。所以再要一条**反证** —— 子代理的 browser_snapshot 结果不能是 registry.ts:384 那句
 *   `Tool "…" is not available in this session`:真吃到那句就说明它手上没这工具,是实打实的红,不许被 inconclusive 吃掉。
 * FAIL = 其余(run 报错 / 压根没委派 / 委派了但解不了锁)。
 */
const run3Verdict = (ev) => {
  const unlock = findSubUnlock(ev.subTools);
  const ok3Raw = !ev.error && !!unlock?.snap;
  const delegated = ev.toolCalls.includes('delegate');
  const iUnlock = ev.toolResults.findIndex((r) => r.name === 'load_tools' && !r.isError && acceptsSnapshotText(r.full));
  const iDelegate = ev.toolResults.findIndex((r) => r.name === 'delegate');
  const parentPreUnlocked = iUnlock >= 0 && (iDelegate < 0 || iUnlock < iDelegate);
  const subDenied = ev.subTools.some((t) => t.name === 'browser_snapshot' && /is not available in this session/.test(t.preview));
  return { unlock, ok3Raw, delegated, parentPreUnlocked, subDenied, inconclusive: !ok3Raw && !ev.error && delegated && parentPreUnlocked && !subDenied };
};

// ── --selftest:上面三个纯判据的负对照(不起引擎、不烧额度、不需要凭证)。每条都配一个**该红的**输入。──
if (argv.includes('--selftest')) {
  const fails = [];
  const check = (name, got, want) => { if (got !== want) fails.push(`${name}:得到 ${got},应为 ${want}`); };
  const evOf = (ids, offsets, content = 'abcdefghij') => ({ toolCallIds: ids, toolOffsets: offsets, content });
  check('anchors 正序', anchorsOk(evOf(['a', 'b'], [{ id: 'a', offset: 0 }, { id: 'b', offset: 5 }])), true);
  check('anchors 倒退(负对照)', anchorsOk(evOf(['a', 'b'], [{ id: 'a', offset: 10 }, { id: 'b', offset: 0 }])), false);
  check('anchors 重复 id(负对照)', anchorsOk(evOf(['a', 'a'], [{ id: 'a', offset: 0 }, { id: 'a', offset: 5 }])), false);
  check('anchors 空 id(负对照)', anchorsOk(evOf([''], [{ id: '', offset: 0 }])), false);
  check('anchors 条数不等(负对照)', anchorsOk(evOf(['a', 'b'], [{ id: 'a', offset: 0 }])), false);
  check('anchors 越界(负对照)', anchorsOk(evOf(['a'], [{ id: 'a', offset: 99 }])), false);
  check('accepts 已装载', acceptsSnapshotText('Loaded tool(s): browser_snapshot. Their full definitions are now available.'), true);
  check('accepts 组装载', acceptsSnapshotText('Loaded tool(s): browser_click, browser_snapshot. Their full definitions are now available.'), true);
  check('accepts 继承(负对照)', acceptsSnapshotText('No tools loaded. Already available: browser_snapshot. Call these tools directly.'), false);
  check('accepts 被拒(负对照)', acceptsSnapshotText('Loaded tool(s): calculator. Their full definitions are now available. Unavailable in this session: browser_snapshot. This may reflect platform support.'), false);
  const LOADED = 'Loaded tool(s): browser_snapshot. Their full definitions are now available.';
  const sub = (subId, name, extra = {}) => ({ subId, name, isError: false, preview: name === 'load_tools' ? LOADED : 'ok', ...extra });
  check('sub 同代理解锁后调用', !!findSubUnlock([sub('A', 'load_tools'), sub('A', 'browser_snapshot')])?.snap, true);
  check('sub 跨代理(负对照)', !!findSubUnlock([sub('A', 'load_tools'), sub('B', 'browser_snapshot')])?.snap, false);
  check('sub 先调用后解锁(负对照)', !!findSubUnlock([sub('A', 'browser_snapshot'), sub('A', 'load_tools')])?.snap, false);
  check('sub 解锁报错(负对照)', !!findSubUnlock([sub('A', 'load_tools', { isError: true }), sub('A', 'browser_snapshot')])?.snap, false);
  check('sub 缺 subId(负对照)', !!findSubUnlock([sub('', 'load_tools'), sub('', 'browser_snapshot')])?.snap, false);
  // ③ 定级:PASS / FAIL / INCONCLUSIVE 三态,每态配一个该翻面的输入
  const DENIED = 'Tool "browser_snapshot" is not available in this session. Use only tools from your tool list';
  const ev3of = (toolCalls, toolResults, subTools) => ({ error: null, toolCalls, toolResults, subTools });
  const pRes = (name, full = 'ok') => ({ name, isError: false, full });
  const grade = (e) => (run3Verdict(e).inconclusive ? 'INCONCLUSIVE' : run3Verdict(e).ok3Raw ? 'PASS' : 'FAIL');
  check('③ 子代理自解锁', grade(ev3of(['delegate'], [pRes('delegate')], [sub('A', 'load_tools'), sub('A', 'browser_snapshot')])), 'PASS');
  check('③ 压根没委派(负对照:不许 inconclusive)', grade(ev3of(['load_tools'], [pRes('load_tools', LOADED)], [])), 'FAIL');
  check('③ 父先解锁再委派', grade(ev3of(['load_tools', 'delegate'], [pRes('load_tools', LOADED), pRes('delegate')], [sub('A', 'browser_snapshot')])), 'INCONCLUSIVE');
  check('③ 父后解锁(负对照)', grade(ev3of(['delegate', 'load_tools'], [pRes('delegate'), pRes('load_tools', LOADED)], [sub('A', 'browser_snapshot')])), 'FAIL');
  check('③ 父先解锁但子代理吃到 not available(负对照)',
    grade(ev3of(['load_tools', 'delegate'], [pRes('load_tools', LOADED), pRes('delegate')], [sub('A', 'browser_snapshot', { preview: DENIED })])), 'FAIL');
  check('③ run 报错(负对照)', run3Verdict({ ...ev3of(['load_tools', 'delegate'], [pRes('load_tools', LOADED), pRes('delegate')], [sub('A', 'browser_snapshot')]), error: 'boom' }).inconclusive, false);
  if (fails.length) { console.error(`--selftest 失败 ${fails.length} 条:\n  ${fails.join('\n  ')}`); process.exit(1); }
  console.log('--selftest 全过(anchorsOk / acceptsSnapshotText / findSubUnlock / run3Verdict,含负对照)');
  process.exit(0);
}

const OUT = resolve(opt('out', process.env.TANGU_LIVE_OUT || join(tmpdir(), `tangu-live-${stamp}-${randomUUID().slice(0, 6)}`)));
const TIMEOUT_MS = Number(opt('timeout', process.env.TANGU_LIVE_TIMEOUT_MS || 15 * 60_000));
const SANDBOX = opt('sandbox', process.env.TANGU_LIVE_SANDBOX || 'auto');
const MUSE_MODE = opt('muse-mode', process.env.TANGU_LIVE_MUSE_MODE || 'ask'); // ask | agent | auto(三档权限阶梯,见 museAgentConfig)
const EXEC_MODE = opt('exec-mode', process.env.TANGU_LIVE_EXEC_MODE || 'host'); // sandbox = 复现「未登录 + 云工作区工具」那条路(负对照用)
if (!['ask', 'agent', 'auto'].includes(MUSE_MODE)) { console.error(`--muse-mode 只认 ask|agent|auto,收到 ${MUSE_MODE}`); process.exit(2); }
if (!['host', 'sandbox'].includes(EXEC_MODE)) { console.error(`--exec-mode 只认 host|sandbox,收到 ${EXEC_MODE}`); process.exit(2); }
if (!existsSync(AUTH)) { console.error(`凭证不存在:${AUTH}\n先在 Forsion Desktop(dev)登录 Codex 订阅,或 --auth 指向 provider-auth.json`); process.exit(2); }
// 生产凭证(~/.forsion/)默认拒绝:引擎启动时可能 refresh 并写回真身,别让台架去改正式安装的登录态(dev 一律 ~/.forsion-dev)。
if (realpathSync(AUTH).startsWith(join(homedir(), '.forsion') + '/') && !argv.includes('--allow-production-auth')) { console.error(`--auth 指向生产共享域 ${AUTH};要用它请显式加 --allow-production-auth`); process.exit(2); }

// ── --ab-memory:B1「记忆易变段落点」的 A/B(TANGU_MEMORY_VOLATILE=tail vs system)──
// 一个进程只能起一个引擎、而落点是**引擎启动期**的环境变量,所以顺序重跑自己两遍,各自隔离 home 与产物目录。
// TANGU_LIVE_AB_CHILD 防自举;子进程照常自己判 --only,父进程只收 recall-unprompted 那一行结论。
if (argv.includes('--ab-memory') && !process.env.TANGU_LIVE_AB_CHILD) {
  if (!ONLY.has('recall-unprompted')) { console.error('--ab-memory 需要 --only 里带 recall-unprompted(A/B 判的就是这条行为闸)'); process.exit(2); }
  const childArgs = [];
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--ab-memory') continue;
    if (argv[i] === '--out') { i++; continue; } // 两轮各自的产物目录在下面定,用户给的 --out 只当前缀
    childArgs.push(argv[i]);
  }
  const self = fileURLToPath(import.meta.url);
  const rounds = [];
  for (const variant of ['tail', 'system']) {
    const out = `${OUT}-${variant}`;
    console.log(`\n══ 记忆落点 A/B:TANGU_MEMORY_VOLATILE=${variant} → ${out} ══`);
    const code = await new Promise((r) => spawn(process.execPath, [self, ...childArgs, '--out', out],
      { stdio: 'inherit', env: { ...process.env, TANGU_LIVE_AB_CHILD: '1', TANGU_MEMORY_VOLATILE: variant } }).once('exit', (c) => r(c ?? 1)));
    let verdict = '(没有 results.json —— 子进程早退,看它自己的输出)';
    try {
      const row = (JSON.parse(readFileSync(join(out, 'results.json'), 'utf8')).results || []).find((x) => x.key === 'recall-unprompted');
      verdict = row ? `${row.skipped ? 'SKIP' : row.ok ? 'PASS' : 'FAIL'} — ${row.detail}` : '(这一轮没跑到 recall-unprompted)';
    } catch { /* 子进程可能在出报告前就死了 */ }
    rounds.push({ variant, out, code, verdict });
  }
  console.log('\n══ A/B 结论 ══');
  for (const r of rounds) console.log(`  ${r.variant.padEnd(7)} exit=${r.code}  recall-unprompted: ${r.verdict}\n          产物 ${r.out}`);
  console.log('两档都 PASS 才算 B1 没回归;只有 tail 红 = 记忆从 system 降到 user 权重后模型不用它了,按评审 §五 B1 退到变体 S(system-end)。');
  process.exit(rounds.every((r) => r.code === 0) ? 0 : 1);
}

// ── 隔离布局:<out>/forsion/{provider-auth.json→软链, tangu/{state.db, agents/…}} + <out>/workspace ──
const shared = join(OUT, 'forsion');
const home = join(shared, 'tangu'); // basename 必须是 tangu:forsionSharedDir() 才会到父目录找 provider-auth.json
const workspace = join(OUT, 'workspace');
mkdirSync(dirname(OUT), { recursive: true });
try { mkdirSync(OUT); } catch (e) { console.error(e?.code === 'EEXIST' ? `产物目录已存在:${OUT}(旧 state.db/旧 MEMORY 会污染结论,换一个或删掉)` : String(e?.message || e)); process.exit(2); }
mkdirSync(home, { recursive: true }); mkdirSync(workspace, { recursive: true });
const authLink = join(shared, 'provider-auth.json');
symlinkSync(AUTH, authLink); // 引擎起来装载完就 unlink(见下),产物目录里不留活凭证指针
const MARKER = `LIVE-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const markerFile = join(workspace, 'marker.txt');
writeFileSync(markerFile, `# 台架标记文件\ncode = ${MARKER}\n`);
// read_document 场景专用:**本机 liteparse 实测拒 .txt 与 .md**(`unsupported file format`),收 .csv。
// 用 .txt 的话模型会 read_document 报错 → 回落 read_file → 照样答对标记,于是「按需装载」场景**假绿**
// (2026-09-15 实测到的形态:序列 load_tools → read_document(Error)→ read_file,断言全绿)。
const markerDoc = join(workspace, 'marker-doc.csv');
writeFileSync(markerDoc, `field,value\ncode,${MARKER}\n`);
const FACT_DB = 'DuckDB'; const FACT_CODE = 'Ferrocene-7';
// cache / recall-unprompted 用的**固定预置记忆行**:不链 historian→dream(那条慢、且依赖模型配合),直接写记忆仓。
const SEED_TOKEN = `SEED-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
const SEED_FACT = `我所有项目的构建产物一律放在 ${SEED_TOKEN} 目录里,长期有效,别再问我。`;
// §1「存储证据」段(memoryRecall.ts appendSection('stable', …))的预算是 floor(cap/4)=1000 字符,且它**与查询无关**:
// 只播一条事实行的话,事实会稳稳落进 §1 → §1 在三个 TANGU_MEMORY_VOLATILE 档下都留在系统提示里,tail 与 system
// 于是双双「PASS」,A/B 什么也没测。先播一条足够长的填充行把 §1 的预算吃光(它会被截断并 break 掉整段),
// 事实就只能经**按查询打分**的 §2(易变段)到达模型 —— 落点 A/B 这才有牙齿。
const PAD_TOKEN = `PAD-${Math.random().toString(36).slice(2, 8).toUpperCase()}`;
// 中性英文填充:不含事实的任何关键词(项目 / 产物 / 目录 / readme),免得它自己被 §2 的打分选中。
const SEED_PAD = `${PAD_TOKEN} Archival filler row for prefix-budget testing; it carries no instruction and answers no question. `
  + Array.from({ length: 8 }, (_, i) => `Note ${i + 1}: the coastal survey team logged tidal range, wind bearing and cloud cover at six-hour intervals along the northern estuary terraces.`).join(' ');
if (SEED_PAD.length < 1000) { console.error(`填充行只有 ${SEED_PAD.length} 字,吃不掉 §1 的 1000 字预算`); process.exit(2); }
const TOKEN = randomUUID(); // 每次随机:撞上别的台架/引擎也只会 401,不会串到别人的引擎上报绿
const port = await new Promise((r) => { const srv = createServer(); srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => r(p)); }); });
const base = `http://127.0.0.1:${port}`;
const engineLog = join(OUT, 'engine.log');
const startedAt = new Date().toISOString();

const child = spawn(process.execPath, [
  entry, '--port', String(port), '--host', '127.0.0.1', '--data-dir', join(home, 'state.db'),
  '--sandbox', SANDBOX, '--cloud-url', 'http://127.0.0.1:9', '--token', TOKEN,
], { env: { ...process.env, TANGU_HOME: home, TANGU_DEFAULT_WORKSPACE: workspace, TANGU_CACHE_PROBE: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
child.stdout.on('data', (d) => appendFileSync(engineLog, d));
child.stderr.on('data', (d) => appendFileSync(engineLog, d));
let childExit = null;
child.once('exit', (code, signal) => { childExit = { code, signal }; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, every = 2000) => { const end = Date.now() + ms; for (;;) { const v = await fn(); if (v) return v; if (Date.now() > end) return null; await sleep(every); } };
const api = async (path, init = {}) => {
  const r = await fetch(base + path, { ...init, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...(init.headers || {}) } });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  if (!r.ok) throw new Error(`${init.method || 'GET'} ${path} → ${r.status} ${(typeof body === 'string' ? body : JSON.stringify(body)).slice(0, 300)}`);
  return body;
};
const museLogTail = () => { try { return readFileSync(engineLog, 'utf8').split('\n').filter((l) => l.includes('[muse]')).slice(-6).join(' ⏎ '); } catch { return ''; } };
const asList = (x, key) => Array.isArray(x) ? x : Array.isArray(x?.[key]) ? x[key] : Array.isArray(x?.rows) ? x.rows : [];

// 桌面 work 会话的 per-run 配置(execMode/cwd 只经 agent_config 传,见 agentLoop.ts:581;appStore.ts:1553 同形)。
// 不传 = sandbox 模式 → read_file/list_files 走云工作区版本,未登录时直接报「云端连接失败」(首跑实测)。
const AGENT_CONFIG = EXEC_MODE === 'host' ? { execMode: 'host', cwd: workspace } : {};

/**
 * 往隔离 home 预置**一条**固定记忆行,幂等。本地记忆不是 sqlite 表,是 agents/<slug>/ 下的文件仓
 * (adapters/standalone/localMemoryBrain.ts:.memory-state.json + MEMORY.md),POST /agent/memory 是它的公开写入口;
 * 不带 slug → 落缺省 agent(xyra),正是这些场景跑的那个。写完必须读回来确认,别拿没种上的 home 去烧模型调用。
 */
let memorySeeded = false;
async function seedMemory() {
  if (memorySeeded) return;
  // 顺序**是判据的一部分**:append 落在文档末尾 → entries 顺序 = 写入顺序,填充行必须排第一才吃得到 §1 的预算。
  await api('/agent/memory', { method: 'POST', body: JSON.stringify({ text: SEED_PAD }) });
  await api('/agent/memory', { method: 'POST', body: JSON.stringify({ text: SEED_FACT }) });
  const snap = await api('/agent/memory');
  const entries = (snap?.entries || []).map((e) => String(e?.content || ''));
  const text = String(snap?.content ?? snap?.memory ?? entries.join('\n'));
  if (!text.includes(SEED_TOKEN)) throw new Error(`记忆预置失败:写完读不回 ${SEED_TOKEN}(快照 ${text.length} 字)`);
  if (!text.includes(PAD_TOKEN)) throw new Error(`填充行预置失败:写完读不回 ${PAD_TOKEN}(快照 ${text.length} 字)`);
  if (entries.length && !entries[0].includes(PAD_TOKEN)) throw new Error(`填充行不在第一条(第一条是「${entries[0].slice(0, 40)}…」)——它吃不到 §1 预算,A/B 会双绿假过`);
  console.log(`记忆已预置:填充行 ${SEED_PAD.length} 字(${PAD_TOKEN})+ 事实行(${SEED_TOKEN}),共 ${entries.length} 条`);
  memorySeeded = true;
}
/** 起 run 并消费 SSE 到 done/error;approval_request 一律代批(记数),单 run 超时算 error。 */
async function run(sessionId, message, timeoutMs = 240_000, extraAgentConfig = {}) {
  const t0 = Date.now();
  const { runId } = await api('/agent/runs', { method: 'POST', body: JSON.stringify({ session_id: sessionId, model_id: MODEL, message, agent_config: { ...AGENT_CONFIG, ...extraAgentConfig } }) });
  const ev = { runId, tokens: 0, toolCalls: [], toolCallIds: [], toolOffsets: null, toolResults: [], subTools: [], subStarts: [], approvals: 0, usages: [], probes: [], content: '', error: null, done: false, group: { speakers: [], ended: null, starts: [], ends: [], summary: null, remarks: [] }, ttftMs: null, wallMs: 0 };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(`${base}/agent/runs/${runId}/events`, { headers: { Authorization: `Bearer ${TOKEN}` }, signal: ac.signal });
    if (!res.ok || !res.body) { ev.error = `events ${res.status}`; return ev; }
    let buf = '';
    outer: for await (const chunk of res.body) {
      buf += Buffer.from(chunk).toString('utf8');
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const frame = buf.slice(0, i); buf = buf.slice(i + 2);
        for (const line of frame.split('\n')) {
          if (!line.startsWith('data:')) continue;
          let e; try { e = JSON.parse(line.slice(5).trim()); } catch { continue; }
          const p = e.payload || {};
          if (e.type === 'token' || e.type === 'reasoning' || e.type === 'tool_stream') { if (ev.ttftMs == null) ev.ttftMs = Date.now() - t0; if (e.type === 'token') ev.tokens += 1; }
          else if (e.type === 'tool_call') { ev.toolCalls.push(p.name || '?'); ev.toolCallIds.push(p.id); }
          // 「调用过」≠「跑成了」:deferred 场景要判 read_document 真解析出了标记,不是报错后被 read_file 兜住。
          // `full` 留**未截断**的原文:bigread 要判的截断标记落在第 4000 字符附近,先截到 4000 就永远看不见
          // (评审 #7)。内存有界 —— 引擎侧 capToolResult 已把单条结果封在 48k。
          else if (e.type === 'tool_result') { const full = String(p.result || ''); ev.toolResults.push({ name: p.name || '?', isError: !!p.isError, result: full.slice(0, 4000), fullLength: full.length, full }); }
          // 子代理自己的工具调用**不进** tool_call(subAgent.ts 把它们包成 'subagent' 事件发在父 run 上)——
          // 要证「子代理用上了 read_document」只能在这儿收。isError/preview 也要留:只存工具名的话,
          // 子代理 read_document 报错、再用 read_file 兜出答案也照样全绿(评审 #5)。
          // subId 同样要留:同一个父 run 里可以并行跑多个子代理(subAgent.ts:245 每个一枚 uuid),
          // 丢掉它就只能把所有子代理的调用混在一起找顺序 —— A 装载失败、B 另外调一次也能凑出「load_tools 在前」(评审 #3)。
          // ponytail: preview 是 subAgent.ts publish 时截的**前 400 字符**,标记落在结果开头才判得到。
          else if (e.type === 'subagent' && p.phase === 'tool') ev.subTools.push({ subId: String(p.subId || ''), name: p.name || '?', isError: !!p.isError, preview: String(p.preview || '') });
          // 委派时授予了哪些管理工具(subAgent.ts 的 phase:'start' payload.grants)—— grant 场景**唯一**的
          // 观测点:「子代理没调成 manage_schedule」既可能是没授予、也可能是模型压根没试,只有这个字段
          // 分得开。字段缺席时记 null(老引擎 / 事件契约被改)—— 判据那边按红处理,绝不当成「肯定没授予」(Codex 09-15 #7)。
          else if (e.type === 'subagent' && p.phase === 'start') ev.subStarts.push({ subId: String(p.subId || ''), grants: Array.isArray(p.grants) ? p.grants.map(String) : null });
          else if (e.type === 'approval_request') {
            ev.approvals += 1;
            const id = p.approvalId || p.id || p.approval_id;
            if (id) await api(`/agent/runs/${runId}/approvals/${id}`, { method: 'POST', body: JSON.stringify({ action: 'approve' }) }).catch((err) => { ev.approveError = String(err.message); });
          }
          else if (e.type === 'usage') ev.usages.push(p);
          // 团队运行模式(群聊分叉):发言序 + 收场原因是 group 场景的唯一观测点;done 的 content 恒空,靠 ev.done 判链路走通。
          else if (e.type === 'group_speaker' && p.phase === 'start') ev.group.speakers.push(String(p.slug || '?'));
          else if (e.type === 'group_speaker' && p.phase === 'end') ev.group.remarks.push({ ...p, at: Date.now(), duringActivation: ev.group.starts.some((s) => s.slug === p.slug && !ev.group.ends.some((x) => x.runId === s.runId)) });
          else if (e.type === 'group_summary') ev.group.summary = p;
          else if (e.type === 'group_ended') ev.group.ended = p;
          // 并行团队(09-16 第四轮):成员激活的起止时刻 —— 「真并行」的唯一观测点是两次激活的时间区间交叠。
          else if (e.type === 'team_member') (p.phase === 'start' ? ev.group.starts : ev.group.ends).push({ slug: String(p.slug || '?'), at: Date.now(), runId: p.runId || null, messageId: p.messageId });
          else if (e.type === 'cache_probe') ev.probes.push(p); // 双闸开着才有(TANGU_CACHE_PROBE=1 + agentConfig.cacheProbe)
          else if (e.type === 'done') { ev.done = true; ev.content = String(p.content || ''); ev.toolOffsets = p.toolOffsets ?? null; break outer; }
          else if (e.type === 'error') { ev.error = String(p.error || 'error'); break outer; }
        }
      }
    }
    if (!ev.done && !ev.error) ev.error = 'SSE 结束但无 done/error';
  } catch (e) {
    ev.error = ac.signal.aborted ? `run ${timeoutMs / 1000}s 超时` : String(e?.message || e);
    if (ac.signal.aborted) await api(`/agent/runs/${runId}/abort`, { method: 'POST', body: '{}' }).catch(() => {}); // 断 SSE 不等于停 run:服务端还在烧额度
  } finally { clearTimeout(timer); ev.wallMs = Date.now() - t0; }
  return ev;
}
const ttft = (ev) => ev.usages?.[0]?.ttftMs ?? ev.ttftMs ?? null;
/** 只看 **usages[0]** = 本 run 的第一次模型调用:后续轮天然高命中,会把「新会话共享不共享头」这个信号冲掉。 */
const hit0 = (ev) => { const u = ev.usages?.[0]; const p = Number(u?.prompt) || 0; return p ? (Number(u?.cached) || 0) / p : null; };
const hitPct = (x) => (x == null ? '-' : `${Math.round(100 * x)}%`);
const tokensOf = (ev) => ev.usages?.reduce((a, u) => a + (Number(u.prompt) || 0) + (Number(u.completion) || 0), 0) || null;
const sec = (ms) => ms == null ? '-' : `${(ms / 1000).toFixed(1)}s`;

const results = []; const byKey = {};
let health = null; let finished = false;
// inconclusive 的行仍按 PASS 计(它不是引擎失败),但表里要看得见「有一条没判到」——只写 detail 的话人扫表会漏。
const verdict = (r) => (r.skipped ? 'SKIP' : r.ok ? (r.inconclusive ? 'PASS(含未判定项)' : 'PASS') : 'FAIL');
const record = (key, name, r, ms) => { const row = { key, name, ms, ...r }; results.push(row); byKey[key] = row; console.log(`${verdict(r)}  ${name}  ${sec(ms)}  | ${r.detail}`); return row; };
async function scenario(key, name, fn) {
  if (!ONLY.has(key)) return null;
  const upstreamFailed = (NEEDS[key] || []).filter((d) => byKey[d] && !byKey[d].ok);
  if (upstreamFailed.length) return record(key, name, { ok: false, skipped: true, detail: `上游 ${upstreamFailed.join(',')} 失败,未跑(不算独立红,也不烧额度)` }, 0);
  console.log(`▶ ${name}`);
  const t0 = Date.now();
  try { return record(key, name, await fn(), Date.now() - t0); }
  catch (e) { return record(key, name, { ok: false, detail: String(e?.message || e) }, Date.now() - t0); }
}

/** Muse 场景跑到了收集阶段才有 journal 键;没有就不出这一节。 */
function museSection(fence) {
  const m = results.find((r) => r.journal !== undefined);
  if (!m) return [];
  return ['## Muse', '### Journal', fence(m.journal), '### TODO', fence(JSON.stringify(m.todos, null, 1)), '### 审批队列', fence(JSON.stringify(m.approvals, null, 1)), '### 状态', fence(JSON.stringify(m.status, null, 1))];
}
async function finish(reason) {
  if (finished) return; finished = true;
  rmSync(authLink, { force: true }); // 任何退出路径都不留凭证软链
  if (!childExit) { child.kill('SIGTERM'); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(8000)]); }
  if (!childExit) { child.kill('SIGKILL'); await Promise.race([new Promise((r) => child.once('exit', r)), sleep(3000)]); }
  let timeline = '';
  try { timeline = timelineReport(await fromDb(join(home, 'state.db'), 1)); } catch (e) { timeline = `(时间线不可用:${e?.message || e})`; }
  const fence = (s, n = 2500) => '```\n' + String(s || '(空)').slice(0, n) + (String(s || '').length > n ? '\n…(截断)' : '') + '\n```';
  const md = [
    `# Tangu live 台架 ${startedAt}`, '',
    `- 模型 \`${MODEL}\`;引擎 ${health?.version || '?'};sandbox ${health?.sandbox || SANDBOX};execMode ${EXEC_MODE};museMode ${MUSE_MODE};memoryVolatile ${process.env.TANGU_MEMORY_VOLATILE || '(缺省)'};场景 ${[...ONLY].join(',')}${reason ? `;**提前结束:${reason}**` : ''}`,
    `- 隔离 home \`${home}\`;引擎日志 \`${engineLog}\``, '',
    '| 场景 | 结果 | 墙钟 | 首帧 | 工具调用 | tokens | 备注 |', '|---|---|---|---|---|---|---|',
    ...results.map((r) => `| ${r.name} | ${verdict(r)} | ${sec(r.ms)} | ${sec(r.ttftMs)} | ${(r.toolCalls || []).join(', ') || '-'} | ${r.tokens ?? '-'} | ${String(r.detail || '').replace(/\|/g, '/')} |`),
    '', '首帧 / tokens 只计场景里的前台 run;Historian 判官、Dream、压缩本身的模型调用不在此列(全量归属见文末时间线)。',
    '', '## 模型原话(按场景)',
    ...results.flatMap((r) => [`### ${r.name}`, fence(r.output)]),
    ...museSection(fence),
    '', '## 时间线归属(stall-timeline,同一 state.db)', fence(timeline, 6000), '',
  ].join('\n');
  writeFileSync(join(OUT, 'report.md'), md);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify({ model: MODEL, engine: health, execMode: EXEC_MODE, museMode: MUSE_MODE, memoryVolatile: process.env.TANGU_MEMORY_VOLATILE || null, only: [...ONLY], startedAt, finishedAt: new Date().toISOString(), reason: reason || null, results }, null, 2));
  const passes = results.filter((r) => r.ok).length; const skipped = results.filter((r) => r.skipped).length;
  console.log(`\n${passes}/${results.length} PASS${skipped ? `(跳过 ${skipped})` : ''}${reason ? `(提前结束:${reason})` : ''}\n报告:${join(OUT, 'report.md')}\n引擎日志:${engineLog}`);
  process.exit(results.length && passes === results.length && !reason ? 0 : 1);
}
const globalTimer = setTimeout(() => { console.error(`整体 ${TIMEOUT_MS / 1000}s 超时`); void finish('timeout'); }, TIMEOUT_MS);
globalTimer.unref?.();
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => void finish(sig));

try {
  health = await until(() => (childExit ? Promise.resolve(null) : fetch(`${base}/health`).then((r) => (r.ok ? r.json() : null)).catch(() => null)), 30_000, 500);
  if (!health || childExit) throw new Error(`引擎${childExit ? `已退出(code ${childExit.code} ${childExit.signal || ''})` : ' 30s 未就绪'}\n${readFileSync(engineLog, 'utf8').slice(-1500)}`);
  console.log(`引擎 ${health.version} 就绪 :${port}(sandbox ${health.sandbox}),模型 ${MODEL},产物 ${OUT}`);

  // 快速失败:模型目录里没有目标模型 = 凭证/登录问题,后面全会因同一原因红,不浪费额度。
  const models = asList(await api('/agent/models'), 'models');
  if (!models.some((m) => m.id === MODEL)) throw new Error(`模型目录无 ${MODEL};直连可用:${models.filter((m) => m.source === 'direct').map((m) => m.id).join(', ') || '(无 —— 凭证未装载或已失效)'}`);
  rmSync(authLink, { force: true }); // 凭证只在引擎启动时装载一次,之后不再读文件 → 立刻拆掉软链

  const sessA = `live-a-${Date.now()}`;
  const chat = await scenario('chat', 'chat 基础对话', async () => {
    const ev = await run(sessA, '用一句话介绍你自己,句末加上 OK。');
    return { ok: !ev.error && ev.content.length > 0, detail: ev.error || `${ev.content.length} 字`, output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls };
  });
  if (chat && !chat.ok) throw new Error(`基础对话失败,后续场景不跑:${chat.detail}`);

  await scenario('tool', 'tool 工具回合', async () => {
    const ev = await run(sessA, `请用工具读取文件 ${markerFile},把文件里 code = 后面的值原样回复给我,不要多说。`);
    const hit = ev.content.includes(MARKER);
    const anchors = anchorsOk(ev);
    return { ok: !ev.error && ev.toolCalls.length > 0 && hit && anchors, detail: ev.error || `工具 ${ev.toolCalls.join(',') || '无'};标记${hit ? '命中' : '未命中'};done 锚点${anchors ? '对齐' : `不对齐(${JSON.stringify(ev.toolOffsets)})`}${ev.approvals ? `;代批 ${ev.approvals}${ev.approveError ? '(失败:' + ev.approveError + ')' : ''}` : ''}`, output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls };
  });

  // 并行团队(新工作区 × 轨道体系,09-16 第四轮:成员各自在自己的工作会话里并行干活、全员起头、被 @ 者优先、成员各自以 DONE 表态,
  // 没有会议/协作之分、没有投票、没有缺省轮数上限)。判三件事:① **真并行** —— 两名成员的激活时间区间交叠(team_member start/end);
  // ② 模型配合团队规则 —— Beta 等 Alpha 派活时 @Alpha 且不写 DONE(等人规则),派到活后完成并写 DONE(自己的提示词里没写 DONE);
  // ③ 全员 DONE 收场(done)且总激活数有界。刻意不传 groupMaxRounds:兜底天花板 30 周期 + 300s 超时,模型不守约定就会在这里失败。
  await scenario('group', 'group 并行团队(两名 agent 同时起、互相 @ 后收敛)', async () => {
    const mk = (slug, name, systemPrompt) => api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name, description: 'live harness', systemPrompt }) }).catch(() => null);
    await mk('live-alpha', 'Alpha', 'You are Alpha, the planner. On the first request, first call team_say with a short progress note that you are planning the task, then split the job: tell @Beta in one sentence exactly what to write, addressing them as "@Beta". When Beta reports back, reply with a one-line summary of the result and then the word DONE on its own line.');
    await mk('live-beta', 'Beta', 'You are Beta, the executor. Only Alpha assigns work. When @Alpha assigns you something, produce it in one short paragraph without using tools and address your reply to "@Alpha".');
    const sessG = `live-g-${Date.now()}`;
    const ev = await run(sessG, '请规划:写一句关于协作的口号,交给合适的人执行。', 300_000, {
      groupChat: true, groupAgents: ['live-alpha', 'live-beta'], groupSeedHistory: false,
    });
    const sp = ev.group.speakers;
    const early = ev.group.remarks.some((r) => r.slug === 'live-alpha' && r.duringActivation && !ev.group.starts.some((s) => s.messageId === r.messageId));
    const backgrounds = await api(`/agent/sessions/${sessG}/background?kind=historian`);
    const historian = backgrounds.background || [];
    const hasSummary = !!ev.group.summary?.text && historian.length === 1 && ev.group.summary.historianSessionId === historian[0].sessionId;
    const reason = ev.group.ended?.reason || null;
    // 交叠:某次 start 落在另一位成员的某次 [start, end] 区间里
    const spans = (slug) => ev.group.starts.filter((s) => s.slug === slug).map((s, i) => ({ start: s.at, end: ev.group.ends.filter((x) => x.slug === slug)[i]?.at ?? Infinity }));
    const overlap = spans('live-alpha').some((a) => spans('live-beta').some((b) => a.start <= b.end && b.start <= a.end));
    const converged = reason === 'done';
    // A member may publish several team_say remarks per activation. Bound activations, not public remarks.
    const both = sp.includes('live-alpha') && sp.includes('live-beta');
    const msgs = await api(`/agent/sessions/${sessG}/messages?limit=50`).catch(() => null);
    const list = Array.isArray(msgs?.messages) ? msgs.messages : Array.isArray(msgs) ? msgs : [];
    const attributed = list.filter((m) => m.role === 'model' && /^\*\*🗣 (Alpha|Beta)\*\*/.test(String(m.content || ''))).length;
    return {
      ok: !ev.error && both && overlap && converged && ev.group.starts.length <= 10 && early && hasSummary,
      detail: ev.error || `发言序 ${sp.join('→') || '无'};并行${overlap ? '交叠' : '未交叠(串行!)'};收场 ${reason || '无'}(${ev.group.ended?.steps ?? '?'} 步 · ${ev.group.ended?.rounds ?? '?'} 周期);带发言人前缀的落库消息 ${attributed} 条;工作中发言 ${early};固定 Historian 摘要 ${hasSummary}`,
      output: list.filter((m) => m.role === 'model').map((m) => String(m.content || '')).join('\n\n---\n\n'), ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls,
    };
  });

  // 复现 09-13 用户导出的失败形态:上限极低时末轮不带 tools,模型不该把调用手写进正文(` to=x code:{…}` / 裸工具参数 JSON),
  // 该给出实质进度正文 + 点明来源的耗尽提示。maxIterations=2 → 第 0 轮可用工具,第 1 轮即末轮(收到 FINAL_TURN_NOTE);
  // maxIterations=1 → 首轮即末轮(FINAL_TURN_NOTE_SINGLE),不该泄漏、也不该误报「耗尽」(没用过工具)。
  await scenario('loop', 'loop 轮数耗尽的末轮收尾(maxIterations=2)+ 单轮(maxIterations=1)', async () => {
    const fa = join(workspace, 'loop-a.txt'); const fb = join(workspace, 'loop-b.txt'); const fc = join(workspace, 'loop-c.txt');
    writeFileSync(fa, `alpha = ${MARKER}-A\n`); writeFileSync(fb, `beta = ${MARKER}-B\n`);
    // 泄漏判据只认工具调用形态:to=NAME / <invoke / 带已知工具参数键的 JSON;模型正经用 JSON 列「已完成/未完成」不算泄漏
    const isLeak = (s) => /\bto=[a-z_]+\b/i.test(s) || /<invoke\s/i.test(s) || /\{"(?:command|path|file_path|content|query|pattern)":/.test(s);
    const stripNotice = (s) => s.replace(/^\s*>?\s*⚠️.*$/gm, '').trim();
    const ev = await run(`live-loop-${Date.now()}`, `分三步做,每一步只调一次工具、做完上一步再做下一步:1) 用 read_file 读 ${fa};2) 用 read_file 读 ${fb};3) 用 write_file 把两个值写进 ${fc}。最后告诉我三步各自的结果。`, 240_000, { maxIterations: 2 });
    const noticeFull = ev.content.includes('已达到最大循环轮数(2 轮,来自本会话 /loop 设置)');
    const substantive = stripNotice(ev.content).length >= 20; // 末轮必须有实质进度正文,只剩一条通知不算过
    const leak = isLeak(ev.content);
    const ev1 = await run(`live-loop1-${Date.now()}`, `用 read_file 读 ${fa},把 alpha 的值告诉我。`, 240_000, { maxIterations: 1 });
    const leak1 = isLeak(ev1.content);
    const notice1 = ev1.content.includes('已达到最大循环轮数');
    const ok = !ev.error && noticeFull && substantive && !leak && ev.toolCalls.length >= 1
      && !ev1.error && ev1.content.trim().length > 0 && !leak1 && !notice1;
    return {
      ok,
      detail: ev.error || ev1.error || `①工具 ${ev.toolCalls.join(',') || '无'};耗尽提示(含来源)${noticeFull ? '出现' : '缺失'};实质正文${substantive ? '有' : '无'};泄漏${leak ? '有' : '无'} ②单轮:泄漏${leak1 ? '有' : '无'};耗尽提示${notice1 ? '误报' : '无'};正文 ${ev1.content.trim().length} 字`,
      output: `【maxIterations=2】\n${ev.content}\n\n【maxIterations=1】\n${ev1.content}`,
      ttftMs: ttft(ev), tokens: (tokensOf(ev) || 0) + (tokensOf(ev1) || 0), toolCalls: [...ev.toolCalls, ...ev1.toolCalls],
    };
  });

  const sessB = `live-b-${Date.now()}`;
  const rawPath = join(home, 'agents', 'xyra', '.memory-raw.md');
  await scenario('historian', 'historian 记忆候选采集', async () => {
    await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ historian: { enabled: true, modelId: MODEL, everyRounds: 1, firstRoundTrigger: true, mode: 'independent' } }) });
    const ev = await run(sessB, `请记住两件长期有效的事:1) 我所有个人项目的本地存储一律用 ${FACT_DB};2) 我的项目代号是 ${FACT_CODE}。以后别再问我这两件事。`);
    if (ev.error) return { ok: false, detail: ev.error, output: ev.content };
    const rows = () => api('/agent/special/historian/activity?limit=50').then((a) => (a.activity || []).filter((r) => r.session_ref === sessB));
    let act = await until(async () => { const r = await rows(); return r.some((x) => x.action === 'memory_candidates') ? r : null; }, 180_000, 3000);
    if (!act) act = await rows();
    const raw = existsSync(rawPath) ? readFileSync(rawPath, 'utf8') : '';
    const hit = raw.includes(FACT_DB) && raw.includes(FACT_CODE); // 两条事实都要在,丢一条就是丢
    return { ok: act.some((x) => x.action === 'memory_candidates') && hit, detail: `${act.length ? '活动 ' + act.map((r) => r.action).join('/') : '180s 无 Historian 活动'};.memory-raw ${hit ? '含事实' : '不含事实'}(${raw.split('\n').filter(Boolean).length} 行)`, output: `【assistant】${ev.content}\n\n【.memory-raw.md】\n${raw}`, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls };
  });

  await scenario('dream', 'dream 记忆整固', async () => {
    await api('/agent/agents/xyra/memory/dream', { method: 'PUT', body: JSON.stringify({ enabled: true, modelId: MODEL, timeoutMs: 120_000 }) });
    await api('/agent/agents/xyra/memory/dream', { method: 'POST', body: '{}' });
    const st = await until(async () => { const d = await api('/agent/agents/xyra/memory/dream'); return d.status && !d.status.running && d.status.state !== 'idle' ? d.status : null; }, 200_000, 3000);
    const mem = await api('/agent/memory');
    const content = String(mem.content ?? mem.memory ?? '');
    const hit = content.includes(FACT_DB) && content.includes(FACT_CODE);
    return { ok: st?.state === 'completed' && hit, detail: `${st ? st.state + ':' + (st.detail || '') : '200s 未结束'};MEMORY ${hit ? '含事实' : '不含事实'}`, output: `【status】${JSON.stringify(st)}\n\n【MEMORY】\n${content}` };
  });

  await scenario('recall', 'recall 新会话回忆', async () => {
    // 先删掉说出事实的那个会话:记忆回灌还会搜其它会话的历史消息(memoryRecall.ts),留着它就证不了「答案来自 MEMORY」。
    await api(`/agent/sessions/${sessB}`, { method: 'DELETE' });
    const ev = await run(`live-c-${Date.now()}`, '我的项目代号是什么?我的个人项目本地存储用哪个数据库?只回答这两个名字,不要解释。');
    const low = ev.content.toLowerCase();
    const hit = low.includes(FACT_DB.toLowerCase()) && low.includes(FACT_CODE.toLowerCase());
    return { ok: !ev.error && hit, detail: ev.error || (hit ? '两条都答中(源会话已删,只能来自记忆)' : `答偏:${ev.content.slice(0, 80)}`), output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls };
  });

  await scenario('compact', 'compact 压缩后续聊', async () => {
    // 自包含:自己的会话先把标记读进上下文,再压缩,再追问 —— 不依赖 tool 场景,答不出标记就是红。
    const sessD = `live-d-${Date.now()}`;
    const pre = await run(sessD, `请用工具读取文件 ${markerFile},把文件里 code = 后面的值原样回复给我,不要多说。`);
    if (pre.error || !pre.content.includes(MARKER)) return { ok: false, detail: `前置读标记失败:${pre.error || '未命中'}`, output: pre.content, toolCalls: pre.toolCalls };
    const c = await api(`/agent/sessions/${sessD}/compact`, { method: 'POST', body: '{}' }).catch((e) => ({ error: e.message }));
    const ev = await run(sessD, '刚才那个文件里 code = 后面的值是什么?只回答值本身。');
    const kept = ev.content.includes(MARKER);
    return { ok: !ev.error && c.ok === true && kept, detail: `压缩 ${JSON.stringify(c).slice(0, 90)};压缩后标记${kept ? '仍答对' : '丢失'}${ev.error ? ';' + ev.error : ''}`, output: ev.content, ttftMs: ttft(ev), tokens: (tokensOf(pre) || 0) + (tokensOf(ev) || 0) || null, toolCalls: [...pre.toolCalls, ...ev.toolCalls] };
  });

  // 技能改动的真模型验证:amadeus-note-format §十 同步冲突副本合并。原位 = 云端版(-S)、副本 = 本机版(-L),共同基线两行;
  // prompt 明说「合并完删副本」,所以「副本消失」是公平断言。use_skill 进 PASS 门:没装载技能就合对了,证不了描述触发得动。
  // 第二问是数据保护的负对照:画布(.excalidraw.md)冲突对按技能规定不许合并,两份必须逐字节原样。
  await scenario('conflict', 'conflict 同步冲突副本合并(amadeus-note-format 技能)', async () => {
    const dir = join(workspace, 'notes'); mkdirSync(dir, { recursive: true });
    const base = '# 本周计划\n\n- 基线条目一\n- 基线条目二\n';
    const copy = join(dir, 'Plan (conflict 2026-09-14 1840).md');
    writeFileSync(join(dir, 'Plan.md'), `${base}- 云端新增 ${MARKER}-S\n`);
    writeFileSync(copy, `${base}- 本机新增 ${MARKER}-L\n`);
    const board = join(dir, 'Board.excalidraw.md'); const boardCopy = join(dir, 'Board (conflict 2026-09-14 1840).excalidraw.md');
    writeFileSync(board, '---\nexcalidraw-plugin: parsed\n---\n\n```json\n{"elements":[{"id":"a","type":"rectangle"}]}\n```\n');
    writeFileSync(boardCopy, '---\nexcalidraw-plugin: parsed\n---\n\n```json\n{"elements":[{"id":"b","type":"ellipse"}]}\n```\n');
    const before = [readFileSync(board, 'utf8'), readFileSync(boardCopy, 'utf8')];
    const ev = await run(`live-conflict-${Date.now()}`, `笔记库在 ${dir},Plan.md 有一份同步冲突副本,请合并两边内容,合并完把冲突副本删掉,最后一句话说明各自来自哪一边。`);
    const merged = existsSync(join(dir, 'Plan.md')) ? readFileSync(join(dir, 'Plan.md'), 'utf8') : '';
    const both = merged.includes(`${MARKER}-S`) && merged.includes(`${MARKER}-L`);
    const baseKept = merged.includes('基线条目一') && merged.includes('基线条目二');
    const leftovers = readdirSync(dir).filter((f) => f.startsWith('Plan') && f.includes('(conflict'));
    const skillLoaded = ev.toolCalls.includes('use_skill');
    const ev2 = await run(`live-conflict2-${Date.now()}`, `笔记库在 ${dir},Board.excalidraw.md 有一份同步冲突副本,请处理。`);
    const boardIntact = existsSync(board) && existsSync(boardCopy) && readFileSync(board, 'utf8') === before[0] && readFileSync(boardCopy, 'utf8') === before[1];
    const ok = !ev.error && skillLoaded && both && baseKept && leftovers.length === 0 && !ev2.error && boardIntact;
    return {
      ok,
      detail: ev.error || ev2.error || `技能${skillLoaded ? '已装载' : '未装载'};两侧标记${both ? '都在' : '缺'};基线${baseKept ? '在' : '丢'};副本${leftovers.length ? '残留 ' + leftovers.join(',') : '已删'};画布对${boardIntact ? '原样' : '被动了'}`,
      output: `【合并】${ev.content}\n\n【Plan.md】\n${merged}\n\n【画布对】${ev2.content}`,
      ttftMs: ttft(ev), tokens: (tokensOf(ev) || 0) + (tokensOf(ev2) || 0) || null, toolCalls: [...ev.toolCalls, ...ev2.toolCalls],
    };
  });

  await scenario('muse', `muse 心跳周期(${MUSE_MODE})`, async () => {
    await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ muse: { enabled: true, modelId: MODEL, mode: MUSE_MODE, heartbeatMinutes: 1, supervisorPollMinutes: 1, maxIterationsPerCycle: 12, maxRestartsPerWindow: 3, allowedFolders: [workspace], notify: 'immediate' } }) });
    const status = () => api('/agent/special/muse/status').then((s) => (s && typeof s.status === 'object' ? s.status : s)); // 路由包一层 {status}
    const started = await until(async () => { const s = await status(); return s.running || s.lastCycleAt ? s : null; }, 120_000, 3000);
    if (!started) return { ok: false, detail: `120s 未起周期;[muse] 日志:${museLogTail() || '(无)'}` };
    // 第二个心跳必须真起来(09-11:预算把缓存命中全额计入 → 默认配置下第二周期即「token 预算用尽」)。
    // 判据用**更大的 lastCycleAt**,不用 restartsThisWindow≥2:计数在 startCycle **之前**就 +1 了,
    // 第二次 createRun/startCycle 挂掉计数照样是 2,而周期 1 留下的 Journal 能满足剩余条件 → 假绿(评审 #6)。
    // lastCycleAt 只在 startCycle 里(createRun 成功之后)赋值,推进 = 第二个 agent_run 真建起来了。
    // 也不用 running 翻转:周期 1 终态 → kickMuse 一秒内就起周期 2,5s 轮询看不到空档。
    // 周期 2 一起即收:只证预算闸放行,finish 会杀引擎,不多烧一整个周期。
    const engineText = () => { try { return readFileSync(engineLog, 'utf8'); } catch { return ''; } };
    // 两道闸的措辞不同且互不为子串(muse.ts 计费闸 `token 预算用尽` / 毛量闸 `毛 prompt 预算用尽`):
    // 只 grep 计费那句,毛量闸挡住时下面会报成「420s 未起」—— 把「被预算挡住」误读成「起不来」。
    // 命中哪句也写进 detail:计费闸查 maxTokensPerWindow,毛量闸查 GROSS_TOKENS_FACTOR,指错地方白排查一轮。
    // ponytail: 只收 `if (cfg.maxTokensPerWindow > 0)` 里的两道闸;muse.ts 的重启闸(本窗口预算用尽)故意不进
    // —— 台架配 maxRestartsPerWindow=3,周期 2 之前不可能触发。两边措辞的对齐由 test/museBudgetGateMarkers.test.ts 钉。
    const BLOCK_MARKS = ['token 预算用尽', '毛 prompt 预算用尽'];
    const blocked = () => { const t = engineText(); return BLOCK_MARKS.find((m) => t.includes(m)) || ''; };
    const firstCycleAt = Number(started.lastCycleAt) || 0;
    const advanced = (s) => Number(s?.lastCycleAt) > 0 && (firstCycleAt ? Number(s.lastCycleAt) > firstCycleAt : Number(s.restartsThisWindow) >= 2);
    const second = await until(async () => { const s = await status(); return advanced(s) || blocked() ? s : null; }, 420_000, 5000);
    // 起周期那一行的实际措辞见 src/services/muse.ts:`启动第 N/M 个思考周期(…,计费 A/B,毛量 C/D)`。
    // 引擎早就不再打 `token 已计 A/B`,旧正则永远零命中、detail 里恒是 `?`(评审:仪器自己坏了没人知道)。
    // 两段连着匹配才只命中这一行:单写 `计费 A/B` 会把「token 预算用尽(… 计费 A/B,未缓存 …)」也算进来。
    const spent = [...engineText().matchAll(/计费 (\d+)\/(\d+),毛量 (\d+)\/(\d+)/g)]
      .map((m) => `${m[1]}/${m[3]}`).join('→'); // 每次起周期时的「计费/毛量」已计量
    await sleep(3000); // 周期 1 的 Journal 行在起周期 2 的同一 tick 开头已补写(muse.ts tick → flushJournal),留余量落盘
    const journalDir = join(home, 'agents', 'muse', 'Library', 'Journal');
    const journal = existsSync(journalDir) ? readdirSync(journalDir).map((f) => `## ${f}\n${readFileSync(join(journalDir, f), 'utf8')}`).join('\n') : '';
    const todos = asList(await api('/agent/special/muse/todos'), 'todos');
    const approvals = asList(await api('/agent/special/approvals'), 'approvals');
    let museSays = '';
    const sid = second?.sessionId || started.sessionId;
    if (sid) { const list = asList(await api(`/agent/sessions/${sid}/messages`).catch(() => []), 'messages'); museSays = list.filter((m) => m.role === 'assistant' || m.role === 'model').map((m) => String(m.content || '')).join('\n---\n'); }
    const blockedBy = blocked();
    const twoCycles = advanced(second) && !blockedBy;
    const ok = twoCycles && (journal.trim().length > 0 || todos.length > 0 || approvals.length > 0);
    return { ok, detail: `周期 2 ${twoCycles ? '已起' : blockedBy ? `被 token 预算挡(${blockedBy})` : '420s 未起'}(lastCycleAt ${firstCycleAt || '?'}→${Number(second?.lastCycleAt) || '?'},restarts ${second?.restartsThisWindow ?? '?'});起周期时计费/毛量 ${spent || '?'};Journal ${journal.trim() ? '有' : '无'};todo ${todos.length};审批 ${approvals.length};error ${(second || started).lastError || '无'}`, output: museSays, journal, todos, approvals, status: second || started };
  });
  // ── 缓存结构:A(新会话) / B(新会话·同文) / B′(新会话·异文) / C(S2 后续) / D(S1 后续)──
  // 台架**证不了 token 省了多少**(样本太小、上游路由不可控),它证的是「结构没塌」:同会话后续调用还命中得了吗?
  // 跨会话那半(A vs B 的 headHash 相不相等)只**记录**不设门 —— 它受上游副本路由影响,红了也未必是引擎的锅(§2.4)。
  await scenario('cache', 'cache 前缀缓存命中(A/B/B′/C/D + head hash 探针)', async () => {
    await seedMemory(); // 头部里有一条固定记忆行,A/B 才有可比的稳定段
    const probe = { cacheProbe: true };
    const S1 = `live-cache-1-${Date.now()}`, S2 = `live-cache-2-${Date.now()}`, S2b = `live-cache-3-${Date.now()}`;
    const T1 = '用一句话说明什么是前缀缓存,不要举例。';
    const A = await run(S1, T1, 240_000, probe);
    const B = await run(S2, T1, 240_000, probe);                       // 新会话、同文
    const Bp = await run(S2b, '用一句话说明什么是向量检索,不要举例。', 240_000, probe); // 新会话、异文
    // C/D 各取**两个不同 run** 的较大者(台架无重试纪律:不是同一个 run 重跑,是各自独立的后续提问)。
    const C1 = await run(S2, '再用一句话补充一点。', 240_000, probe);
    const C2 = await run(S2, '再补充最后一点。', 240_000, probe);
    const D1 = await run(S1, '再用一句话补充一点。', 240_000, probe);   // 放在 S2 那批之后:考的是 S1 的前缀扛不扛得住中间插进别的会话
    const D2 = await run(S1, '再补充最后一点。', 240_000, probe);
    const all = [A, B, Bp, C1, C2, D1, D2];
    const named = [['A', A], ['B', B], ['B′', Bp], ['C1', C1], ['C2', C2], ['D1', D1], ['D2', D2]];
    const err = all.map((e) => e.error).filter(Boolean)[0];
    const C = Math.max(hit0(C1) ?? 0, hit0(C2) ?? 0);
    const D = Math.max(hit0(D1) ?? 0, hit0(D2) ?? 0);
    const head = (e) => e.probes?.[0]?.headHash || null;
    const same = (e) => e.probes?.[0]?.headHashSameAsAgentModel ?? null;
    // 探针本身是本轮新增的契约,守不住它这条场景就没意义:缺 probe 必红,绝不拿占位串互比
    // (此前两个缺失值都映射成同一个「(无探针)」,报告还会写成 headHash A=B,评审 #4)。
    const noProbe = named.filter(([, e]) => !(e.probes || []).length).map(([n]) => n);
    // A 必须是本引擎该 (agent, 模型) 的第一次探针 → 无历史可比(headHashSameAsAgentModel=null);
    // B/B′ 则必须有可比状态(true/false),否则「A=B 与否」这句话根本没有依据。
    const baselineOk = A.probes?.[0]?.probeSeq === 0 && same(A) === null;
    const comparable = typeof same(B) === 'boolean' && typeof same(Bp) === 'boolean';
    // 门钉 C/D(同会话后续)+ 探针完整性。今天实测同会话后续命中 88–96%,codex/* 另有约 20% 的
    // 「整次未命中」噪声 → 地板取 50%:塌方(0%)必红,正常抖动不会假红。跨会话那三个数只进报告。
    const ok = !err && !noProbe.length && baselineOk && comparable && C >= 0.5 && D >= 0.5;
    const headCmp = head(A) && head(B) ? (head(A) === head(B) ? 'A=B' : 'A≠B') : 'A/B 缺探针,不可比';
    const changed = all.flatMap((e) => (e.probes || []).slice(1).flatMap((x) => x.changedSegments || []));
    const freq = Object.entries(changed.reduce((a, k) => ((a[k] = (a[k] || 0) + 1), a), {})).sort((x, y) => y[1] - x[1]);
    return {
      ok,
      detail: err || `A ${hitPct(hit0(A))} / B ${hitPct(hit0(B))} / B′ ${hitPct(hit0(Bp))}(跨会话,只记录);C ${hitPct(C)} / D ${hitPct(D)}(门 ≥50%)`
        + `;探针${noProbe.length ? `缺席:${noProbe.join(',')}` : '齐全'};A 基线${baselineOk ? '无历史 ✓' : '不是无历史基线 ✗'};B/B′ 可比${comparable ? '✓' : '✗'};headHash ${headCmp}`,
      output: [
        `预置记忆:${SEED_FACT}`,
        `usages[0] 命中:A=${hitPct(hit0(A))} B=${hitPct(hit0(B))} B′=${hitPct(hit0(Bp))} C1=${hitPct(hit0(C1))} C2=${hitPct(hit0(C2))} D1=${hitPct(hit0(D1))} D2=${hitPct(hit0(D2))}`,
        `探针条数:${named.map(([n, e]) => `${n}=${(e.probes || []).length}`).join(' ')}`,
        `headHash:A=${head(A) ?? '(无探针)'} B=${head(B) ?? '(无探针)'} B′=${head(Bp) ?? '(无探针)'}`,
        `headHashSameAsAgentModel:A=${String(same(A))} B=${String(same(B))} B′=${String(same(Bp))}`,
        `run 内变化过的段:${freq.length ? freq.map(([k, v]) => `${k}×${v}`).join(' / ') : '(无后续探针)'}`,
        '',
        '判读:A=B 且 B 的 headHashSameAsAgentModel=true → 新会话共享到了稳定头 + 工具定义;',
        'A≠B 但两边正文同字 → 分叉来自记忆块/跨会话召回段(§2.4),不是路由。B′ 是「异文」对照,它跟 A 不等属正常。',
      ].join('\n'),
      ttftMs: ttft(A), tokens: all.reduce((a, e) => a + (tokensOf(e) || 0), 0) || null, toolCalls: [],
    };
  });

  // B1 的**行为闸**:记忆易变段无论落在系统提示还是尾部 user 通道,模型都得照样用得上记忆。
  // 提问是任务型的、全程不提「记忆/记得/之前说过」——只有真读进上下文并用上,才答得出 SEED_TOKEN。
  // 两个落点各跑一遍:npm run live:harness -- --only recall-unprompted --ab-memory
  await scenario('recall-unprompted', `recall-unprompted 不点名也会用记忆(TANGU_MEMORY_VOLATILE=${process.env.TANGU_MEMORY_VOLATILE || '(缺省)'})`, async () => {
    await seedMemory();
    const ev = await run(`live-unprompted-${Date.now()}`, '我要给一个新项目的 README 写「构建产物」那一小节,一句话说明产物放在哪个目录就行。');
    const hit = ev.content.includes(SEED_TOKEN);
    return {
      ok: !ev.error && hit,
      detail: ev.error || (hit ? `用上了预置记忆(${SEED_TOKEN})` : `没用记忆,答的是:${ev.content.slice(0, 90)}`),
      output: `【预置记忆】${SEED_FACT}\n\n【回答】${ev.content}`,
      ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls,
    };
  });

  // ── E2 按需装载(deferred)的三条真模型闸 ──
  // ① work 缺省档把 read_document 移出常驻 defs(presetTable WORK_DEFERRED),模型只能先 load_tools 解锁再用 ——
  //    「目录里广而告之却解锁不了」是本机存量 bug 的形态,只有真模型走一遍才证得了这条取回通道通。
  // ② 子代理(delegate)被剥掉 unlockTools,没有 load_tools 这条通道 → 本轮给 read_document 开了窄口
  //    (toolRegistry.isDeferredIn:subAgentDepth≥1 时不按 deferred 处理)。子代理拿不到它,读 PDF/Office
  //    只会得到乱码,而且**不报错** —— 所以断言必须落在「子代理真把值带回来了」。
  // ③ 子代理**自己的** load_tools 通道(subAgent.ts:subUnlocked/unlockTools + 目录段):
  //    browser_snapshot 是静态 deferred、且不在 ②那条窄口名单里 —— 子代理要用它只能先自己 load_tools。
  //    门只钉「子代理工具序列里 load_tools 在 browser_snapshot 之前」;**快照本身失败(没浏览器)不算红** ——
  //    这条验的是解锁通道通不通,不是浏览器能不能起。
  await scenario('deferred', 'deferred 按需装载(load_tools→read_document)+ 子代理直通 + 子代理自解锁 browser_snapshot', async () => {
    const ev1 = await run(`live-deferred-1-${Date.now()}`,
      'Use the read_document tool on ./marker-doc.csv in the workspace and tell me the value of code.');
    const seq1 = ev1.toolCalls;
    const iLoad = seq1.indexOf('load_tools');
    const iDoc = seq1.indexOf('read_document');
    // 解锁后那次 read_document 必须**自己**解析出标记:只判「调用过 + 正文有标记」的话,
    // read_document 报错、模型回落 read_file 也照样全绿(实测过的假绿形态)。
    const docOk = ev1.toolResults.some((r) => r.name === 'read_document' && !r.isError && r.full.includes(MARKER));
    const ok1 = !ev1.error && iLoad >= 0 && iDoc > iLoad && docOk && ev1.content.includes(MARKER);
    const ev2 = await run(`live-deferred-2-${Date.now()}`,
      'Delegate this to a sub-agent: it must use read_document on ./marker-doc.csv and report the value of code; then repeat the value to me.',
      300_000);
    // 子代理的工具调用不进父 run 的 tool_call(包成 'subagent' 事件)→ 直通闸的判据落在 ev2.subTools 上;
    // 只判「有 delegate + 父正文有标记」不够:父代理完全可能自己 read_file 一遍把标记带出来。
    // 「调用过」也不够:子代理的 read_document 可能报错,再由它自己或父代理 read_file 兜出标记 →
    // 门必须落在「那次 read_document **成功**且结果里就有标记」(评审 #5)。
    const subNames = ev2.subTools.map((t) => t.name);
    const delegated = ev2.toolCalls.includes('delegate');
    const subUsedDoc = subNames.includes('read_document');
    const subDocOk = ev2.subTools.some((t) => t.name === 'read_document' && !t.isError && t.preview.includes(MARKER));
    const ok2 = !ev2.error && delegated && subDocOk && ev2.content.includes(MARKER);
    // ③ 子代理自解锁:门钉「**同一个**子代理先 load_tools 明确拿到 browser_snapshot,其后它自己调了 browser_snapshot」
    //    (findSubUnlock:按 subId 归属 + acceptsSnapshotText 认措辞)。快照自身失败(本机没浏览器)不进门 —— 验的是解锁通道。
    //    父 run 先 load_tools 过 browser_snapshot 再 delegate 时,子代理按契约**继承**该工具、不必也不会再解锁一轮
    //    → 这条通道根本没被走到,判红是假红(评审 #4)。这种形态记为 inconclusive(SKIP 形态)写进 row.inconclusive,
    //    **不计入引擎失败**;「委派了但子代理解不了锁」「压根没委派」仍各自判红。
    const ev3 = await run(`live-deferred-3-${Date.now()}`,
      'Delegate to a sub-agent: it must call load_tools to unlock browser_snapshot and then call browser_snapshot; report what happened.',
      300_000);
    const subNames3 = ev3.subTools.map((t) => t.name);
    const { unlock: unlock3, ok3Raw, delegated: delegated3, parentPreUnlocked, subDenied: subDenied3, inconclusive: run3Inconclusive } = run3Verdict(ev3);
    const subLoad = unlock3?.load || ev3.subTools.find((t) => t.name === 'load_tools') || null;
    const subSnap = unlock3?.snap || ev3.subTools.find((t) => t.name === 'browser_snapshot') || null;
    const subLoadPreview = subLoad ? subLoad.preview : '';
    const missingSubId = ev3.subTools.some((t) => !t.subId); // 归属不了 → 不回落按名字找(那就是旧的假绿)
    const ok3 = ok3Raw || run3Inconclusive;
    return {
      ok: ok1 && ok2 && ok3,
      ...(run3Inconclusive ? { inconclusive: '③ 父 run 先 load_tools 解锁了 browser_snapshot 再 delegate → 子代理继承,自解锁通道未被走到;本轮不作引擎判据(SKIP 形态)' } : {}),
      detail: `①序列 [${seq1.join(' → ') || '无'}];load_tools ${iLoad >= 0 ? `第 ${iLoad + 1} 格` : '缺席'};read_document ${iDoc >= 0 ? `第 ${iDoc + 1} 格` : '缺席'};该次结果${docOk ? '含标记' : '未解析出标记'};正文标记${ev1.content.includes(MARKER) ? '命中' : '未命中'}${ev1.error ? ';' + ev1.error : ''}`
        + ` ②父序列 [${ev2.toolCalls.join(' → ') || '无'}];子代理工具 [${subNames.join(' → ') || '无'}];delegate ${delegated ? '有' : '无'};子代理 read_document ${subUsedDoc ? '用上' : '没用上'};该次结果${subDocOk ? '含标记' : '未解析出标记(报错或回落)'};正文标记${ev2.content.includes(MARKER) ? '命中' : '未命中'}${ev2.error ? ';' + ev2.error : ''}`
        + ` ③${run3Inconclusive ? 'INCONCLUSIVE(不计入引擎失败)' : ok3Raw ? 'PASS' : 'FAIL'};父序列 [${ev3.toolCalls.join(' → ') || '无'}];delegate ${delegated3 ? '有' : '无(父自己干了 → 子序列必空)'};父先解锁 ${parentPreUnlocked ? `有(子代理继承 browser_snapshot,自解锁通道未被走到${subDenied3 ? ';但子代理吃到 not available → 并没继承到,仍判红' : ''})` : '无'};子代理工具 [${subNames3.map((n, i) => `${ev3.subTools[i].subId.slice(0, 4) || '????'}:${n}`).join(' → ') || '无'}];同代理 load_tools→browser_snapshot ${unlock3?.snap ? '成立' : unlock3 ? '解锁成立但其后没调用' : missingSubId ? '不成立(事件缺 subId,无法归属)' : '不成立'};快照${subSnap ? (subSnap.isError ? '报错(不计入门)' : '成功') : '未调用'};load_tools 结果 ${subLoad ? (subLoad.isError ? '报错:' : '') + JSON.stringify(subLoadPreview.slice(0, 160)) : '(没调用)'}${ev3.error ? ';' + ev3.error : ''}`,
      output: `【① 主 loop 按需装载】工具序列:${seq1.join(' → ') || '(无)'}\nread_document 结果:${(ev1.toolResults.find((r) => r.name === 'read_document') || {}).result?.slice(0, 300) || '(没调用)'}\n${ev1.content}\n\n【② 子代理直通】父工具序列:${ev2.toolCalls.join(' → ') || '(无)'};子代理工具序列:${subNames.join(' → ') || '(无)'}\n子代理 read_document 结果预览:${(ev2.subTools.find((t) => t.name === 'read_document') || {}).preview?.slice(0, 300) || '(没调用)'}\n${ev2.content}\n\n【③ 子代理自解锁 browser_snapshot】父工具序列:${ev3.toolCalls.join(' → ') || '(无)'};子代理工具序列:${subNames3.join(' → ') || '(无)'}\n子代理 load_tools 结果预览:${subLoadPreview.slice(0, 400) || '(没调用)'}\n子代理 browser_snapshot 结果预览:${subSnap ? `${subSnap.isError ? '[isError] ' : ''}${subSnap.preview.slice(0, 400)}` : '(没调用)'}\n${ev3.content}`,
      toolSequences: { unlock: seq1, delegateParent: ev2.toolCalls, delegateSub: subNames, subUnlockParent: ev3.toolCalls, subUnlockSub: subNames3 },
      subLoadTools: subLoad ? { subId: subLoad.subId, isError: subLoad.isError, preview: subLoadPreview } : null,
      subSnapshot: subSnap ? { subId: subSnap.subId, isError: subSnap.isError, preview: subSnap.preview } : null,
      ttftMs: ttft(ev1), tokens: (tokensOf(ev1) || 0) + (tokensOf(ev2) || 0) + (tokensOf(ev3) || 0) || null, toolCalls: [...seq1, ...ev2.toolCalls, ...ev3.toolCalls],
    };
  });

  // ── grant:子代理管理面「缺省拒 + 委派时父代理逐次授予」的真模型闸(delegate.grantTools) ──
  // 单测能证 ctx.subAgentGrants 这个开关接对了,证不了**模型会不会用**:depth 0 的模型得自己看懂
  // grantTools 这个参数、并在用户说「授予」时真把名字填进去。正负两跑用的是**同一句任务**,只差
  // 最后一句授不授权 —— 差异只能来自这条通道。两跑都 action=list(只读,无副作用)。
  //   正:① 有一个 start 事件的 grants 含 manage_schedule(父代理真授了)
  //       ② 子代理那次 manage_schedule 的结果不是子代理拒绝语(闸真抬起来了)
  //   负:① 没有任何 start 事件授予它 ② 子代理要么没跑成 manage_schedule、要么吃到的就是那句拒绝
  // ⚠️ 两跑都要求父序列里**真的有 delegate**:父代理自己去查日程也能把条目报出来,那种形态下
  //    负判据「子代理没成功调用 manage_schedule」是空真的 —— 不设这道前提,负对照等于没跑。
  // ⚠️ 负对照的措辞必须**点名参数**并给出理由:第一版写的是「it must call manage_schedule … do not grant it any
  //    extra tools」,模型判定 manage_schedule 不算「extra」照样授了(live 09-15:start grants 含 manage_schedule),
  //    那是提示词自相矛盾,不是引擎漏闸。父代理**故意**授了的形态记 INCONCLUSIVE(模型判断,不作引擎判据),
  //    只有「没授予却跑成」才是闸漏。
  await scenario('grant', 'grant 子代理管理面按委派授予(manage_schedule:授予 / 不授予 两跑)', async () => {
    const GRANTED = 'manage_schedule';
    const denyRe = /unavailable to sub-agents/i;
    const subCalls = (ev) => ev.subTools.filter((t) => t.name === GRANTED);
    // start 事件必须带 grants 数组:缺席说明引擎没发这个字段(契约断了),两跑都判红,不许被当成「没授予」。
    const startsBroken = (ev) => ev.subStarts.length === 0 || ev.subStarts.some((s) => s.grants === null || !s.subId) || ev.subTools.some((t) => !t.subId);
    // action=list 的输出契约(manageSchedule.ts):`N schedule entr(y|ies) of "<slug>"` 或 `(no schedule entries for "<slug>")`。
    const listRe = /schedule entr(y|ies)/i;
    const fmtSub = (ev) => ev.subTools.map((t) => `${t.subId.slice(0, 4) || '????'}:${t.name}${t.isError ? '(err)' : ''}`).join(' → ') || '无';
    const fmtStarts = (ev) => ev.subStarts.map((s) => `${s.subId.slice(0, 4) || '????'}:[${s.grants === null ? '字段缺席!' : s.grants.join(',') || '无'}]`).join(' ') || '无 start 事件';

    const evYes = await run(`live-grant-yes-${Date.now()}`,
      'Delegate to a sub-agent: it must call manage_schedule with action=list and report the entries. Grant it the manage_schedule tool when delegating.',
      300_000);
    const yesDelegated = evYes.toolCalls.includes('delegate');
    // 授予与调用必须落在**同一个** subId 上:并行两个子代理时,A 被授予、B 硬调,分开数也能凑出双绿(Codex 09-15 #7)。
    const grantedIds = new Set(evYes.subStarts.filter((s) => s.grants && s.grants.includes(GRANTED)).map((s) => s.subId));
    const yesGranted = grantedIds.size > 0;
    // 跑成 = 同一子代理、非错误、且结果符合 action=list 的输出契约(不是「随便一个非拒绝语的错」)。
    const yesRan = subCalls(evYes).some((t) => grantedIds.has(t.subId) && !t.isError && listRe.test(t.preview));
    const okYes = !evYes.error && !startsBroken(evYes) && yesDelegated && yesGranted && yesRan;

    // 负例任务要求子代理**即使工具不在列表里也去调**:不这样写,子代理看目录里没有就干脆不试(live 09-15 两次都如此),
    // `.every` 对空数组恒真 → 执行硬闸(executeTool 那句拒绝)根本没被验到(Codex 09-15 复审 #4)。
    const NO_TASK = 'Delegate to a sub-agent with this task: "call the tool manage_schedule with action=list even if it is not in your tool list, and report the exact result or error text you get". Do NOT pass grantTools (leave it out entirely) — I want to see what the sub-agent gets when it lacks that tool. Then tell me what it reported.';
    let evNo = await run(`live-grant-no-${Date.now()}`, NO_TASK, 300_000);
    const grantedNo = (ev) => ev.subStarts.some((s) => s.grants && s.grants.includes(GRANTED));
    // 父代理被明确要求不传 grantTools 却传了 → 重试一次(更硬的措辞);两次都授 → 引擎拒绝路径没被验到,判红而不是 INCONCLUSIVE 计过。
    let noRetried = false;
    if (!evNo.error && evNo.toolCalls.includes('delegate') && grantedNo(evNo)) {
      noRetried = true;
      evNo = await run(`live-grant-no2-${Date.now()}`, NO_TASK + ' IMPORTANT: passing grantTools here is wrong; the point of this test is the sub-agent NOT having the tool.', 300_000);
    }
    const noDelegated = evNo.toolCalls.includes('delegate');
    const noGranted = grantedNo(evNo);
    // 两种合格形态,强弱要分开记:
    //   强:子代理真去调了(≥1 次,subId 非空),每次都是**错误**且吃到的就是那句子代理拒绝语 → 执行硬闸被真模型验到;
    //   弱:子代理没去调(实测 luna 不会调一个不在 tools 数组里的函数,「即使不在列表里也要调」也劝不动),
    //       但它的最终报告如实说了工具不可用 → 验到的是**可见性**(defs / 目录都没有),执行硬闸那半由单测钉
    //       (test/subAgentManageDeny.test.ts 直调 executeTool)。既没调、也没报告不可用 → 空真,判红。
    const noCalls = subCalls(evNo);
    const noBlocked = noCalls.length > 0 && noCalls.every((t) => t.subId && t.isError && denyRe.test(t.preview));
    const missingRe = /unavailable|not available|no access|don.t have access|not (?:in|part of) (?:my|the|its) tool|cannot call|can.t call|lack(?:s|ing)? (?:the |access)/i;
    const noReportedMissing = noCalls.length === 0 && missingRe.test(evNo.content);
    const okNo = !evNo.error && !startsBroken(evNo) && noDelegated && !noGranted && (noBlocked || noReportedMissing);

    const previewOf = (ev) => (subCalls(ev)[0]?.preview || '').slice(0, 300) || '(子代理没调用 manage_schedule)';
    return {
      ok: okYes && okNo,
      detail: `【授予】${startsBroken(evYes) ? 'start 事件缺 grants 字段(契约断了)!;' : ''}父序列 [${evYes.toolCalls.join(' → ') || '无'}];delegate ${yesDelegated ? '有' : '无(父自己干了 → 本跑无效)'}`
        + `;start grants ${fmtStarts(evYes)};授予命中 ${yesGranted ? '是' : '否'};子代理 ${GRANTED} ${subCalls(evYes).length ? (yesRan ? '跑成(同 subId、非错误、符合 list 输出契约)' : '调用了但不算跑成(报错 / 拒绝语 / 不是被授予的那个子代理 / 输出不合 list 契约)') : '没调用'}`
        + `;子代理工具 [${fmtSub(evYes)}]${evYes.error ? ';' + evYes.error : ''}`
        + ` 【不授予】${noRetried ? '(第一次父代理违令授了,已重试)' : ''}${startsBroken(evNo) ? 'start 事件缺 grants/subId(契约断了)!;' : ''}父序列 [${evNo.toolCalls.join(' → ') || '无'}];delegate ${noDelegated ? '有' : '无(父自己干了 → 负对照空真,判红)'}`
        + `;start grants ${fmtStarts(evNo)};父授予 ${noGranted ? '有(被要求不传却仍传了,重试后依旧 → 引擎拒绝路径未验到,判红)' : '无'};子代理 ${GRANTED} ${noCalls.length ? (noBlocked ? '真去调了且吃到子代理拒绝语(强:执行硬闸验到)' : noGranted ? '跑成(已授予)' : '调了但不是「错误 + 拒绝语」→ 闸漏了或归属不了') : noReportedMissing ? '没去调,但报告里如实说工具不可用(弱:只验到可见性,执行硬闸由单测钉)' : '既没去调也没报告不可用(空真,判红)'}`
        + `;子代理工具 [${fmtSub(evNo)}]${evNo.error ? ';' + evNo.error : ''}`,
      output: `【① 授予 manage_schedule】父工具序列:${evYes.toolCalls.join(' → ') || '(无)'};子代理工具序列:${fmtSub(evYes)}\n`
        + `start grants:${fmtStarts(evYes)}\n子代理 ${GRANTED} 结果预览:${previewOf(evYes)}\n${evYes.content}\n\n`
        + `【② 不授予(负对照)】父工具序列:${evNo.toolCalls.join(' → ') || '(无)'};子代理工具序列:${fmtSub(evNo)}\n`
        + `start grants:${fmtStarts(evNo)}\n子代理 ${GRANTED} 结果预览:${previewOf(evNo)}\n${evNo.content}`,
      toolSequences: { grantedParent: evYes.toolCalls, grantedSub: evYes.subTools.map((t) => t.name), plainParent: evNo.toolCalls, plainSub: evNo.subTools.map((t) => t.name) },
      subStarts: { granted: evYes.subStarts, plain: evNo.subStarts },
      ttftMs: ttft(evYes), tokens: (tokensOf(evYes) || 0) + (tokensOf(evNo) || 0) || null,
      toolCalls: [...evYes.toolCalls, ...evNo.toolCalls],
    };
  });

  // ── bigread:E4「大工具结果中段截断 + 全文落盘给路径」的真模型验证 ──
  // ⚠️ 这条路径验的是 **run_bash 自己的帽**(head 4000 + tail 1500 + 落盘,hostExec.ts truncateBashOutput),
  //    不是 48k 硬帽:run_bash 早就把结果压到 ~5.5k 了,capToolResult(48k)根本轮不上。48k 标记只作信息性记录。
  await scenario('bigread', 'bigread 大工具结果中段截断 + 溢出落盘后模型拿到头/中/尾事实', async () => {
    const H = `HEAD-${MARKER.slice(5)}`, M = `MID-${MARKER.slice(5)}`, E = `END-${MARKER.slice(5)}`;
    const lines = [`head_code=${H}`];
    for (let i = 1; i <= 1500; i++) lines.push(`${String(i).padStart(5, '0')} ${'lorem ipsum dolor sit amet '.repeat(3)}`);
    lines.splice(750, 0, `mid_code=${M}`);
    lines.push(`end_code=${E}`);
    writeFileSync(join(workspace, 'big.log'), lines.join('\n')); // ≈135k 字符 > 48k 硬帽
    const ev = await run(`live-bigread-${Date.now()}`,
      'Run `cat ./big.log` with run_bash (do not use read_file) and tell me the values of head_code and end_code. If the tool output says the middle was omitted and the full text was saved to a file, read that file to also report mid_code.', 300_000);
    // 判据必须落在**未截断**的工具结果上:台架自己只留前 4000 字,而标记恰好就在第 4000 字符附近(评审 #7)。
    // run_bash 自己先按 head 4000 + tail 1500 封顶并把全文落盘(hostExec.ts truncateBashOutput),
    // 结果只有 ~5.5k 字符 → **走这条路永远碰不到 48k 硬帽**(capToolResult),下面那个 cap48k 只可能是 false,
    // 留着是为了硬帽将来被挪到 run_bash 之前时能立刻看见。真正的门是 MID:中段被省略了,
    // 模型只有去读溢出文件才拿得到它。
    const r = ev.toolResults.find((x) => x.name === 'run_bash');
    const body = r?.full || '';
    const spilled = /captured output saved to /.test(body);             // run_bash 自己的溢出落盘标记
    const cap48k = /tool output too large: omitted /.test(body);        // capToolResult 的 48k 硬帽标记
    const ok = !ev.error && ev.content.includes(H) && ev.content.includes(E) && ev.content.includes(M);
    return {
      ok,
      detail: `run_bash 结果 ${r?.fullLength ?? 0} 字符;run_bash 溢出落盘标记${spilled ? '有' : '无'};48k 硬帽标记${cap48k ? '有' : '无(此路径本就到不了 48k,信息性)'}`
        + `;head ${ev.content.includes(H) ? '命中' : '未命中'} / mid(须读溢出文件)${ev.content.includes(M) ? '命中' : '未命中'} / end ${ev.content.includes(E) ? '命中' : '未命中'};序列 [${ev.toolCalls.join(' → ') || '无'}]${ev.error ? ';' + ev.error : ''}`,
      output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls,
    };
  });

  // ── churn:同一会话里 6 个小工具 run 连打,量「后续调用」的命中画像 ──
  // **不对命中率设阈值**:后续调用命中受上游副本路由影响(§2.5 的「整次未命中」13–20%),
  // 一两次塌方不足以判引擎坏;它出的是分布,供 B4① turn-state 的 on/off 两臂对比。
  // 但门还是有一个:六个 run 必须都跑完且各有 ≥1 次 usage —— 全失败时这张画像是空的,不能报绿。
  await scenario('churn', 'churn 同会话 6 连发的后续调用命中画像(不设命中率阈值,六个 run 须跑完)', async () => {
    const probe = { cacheProbe: true };
    const sess = `live-churn-${Date.now()}`;
    const notes = join(workspace, `churn-notes-${Date.now()}.txt`);
    writeFileSync(notes, 'step 0\n');
    const evs = [];
    for (let i = 1; i <= 6; i++) {
      evs.push(await run(sess, `Append the line 'step ${i}' to ${notes} using run_bash, then read the file back and confirm the last line.`, 240_000, probe));
    }
    const err = evs.map((e) => e.error).filter(Boolean)[0];
    // 每个 run 的 usages 逐条留档(results.json 里可跨次比对;report.md 只印摘要)。
    const usages = evs.flatMap((e, r) => (e.usages || []).map((u, k) => ({
      run: r + 1, k, iteration: u.iteration ?? null, prompt: Number(u.prompt) || 0, cached: Number(u.cached) || 0,
      cacheReported: u.cacheReported ?? null, headHash: u.headHash || null,
      ratio: Number(u.prompt) ? (Number(u.cached) || 0) / Number(u.prompt) : null,
    })));
    const later = usages.filter((u) => u.k > 0); // 「后续调用」= 每个 run 的第一次模型调用之外的全部
    // 缓存量未知的调用(cacheReported=false,或老事件缺字段且 cached=0)不进 miss 的分子分母 ——
    // 把它们当成整次未命中会虚增这条画像,与 cache-hit-report 同口径(评审 #8/#2)。
    const isKnown = (u) => u.cacheReported === true || (u.cacheReported == null && u.cached > 0);
    const laterKnown = later.filter(isKnown);
    const laterUnknown = later.filter((u) => !isKnown(u));
    const misses = laterKnown.filter((u) => u.ratio !== null && u.ratio < 0.05);
    // 信息性 = **不对命中率设阈值**,不等于「怎样都绿」:六个 run 全超时/鉴权失败时整份画像是空的,
    // 那不叫「没设门」,那叫没跑成(评审 #8)。
    const completed = evs.filter((e) => !e.error && (e.usages || []).length > 0).length;
    const line = (u) => `run${u.run}/iter${u.iteration ?? '?'} prompt=${u.prompt} cached=${u.cached} ${hitPct(u.ratio)}`;
    return {
      ok: completed === evs.length,
      detail: `${err ? 'run 有错:' + err + ';' : ''}完成 ${completed}/${evs.length} 个 run(各 ≥1 次 usage)`
        + `;后续调用 ${later.length} 次(其中缓存量未知 ${laterUnknown.length} 次,不计入下面的比例)`
        + `,整次未命中(<5%)${misses.length}/${laterKnown.length}`
        + `${laterKnown.length ? `,占 ${Math.round((100 * misses.length) / laterKnown.length)}%` : ''};首调命中 ${evs.map((e) => hitPct(hit0(e))).join('/')}`,
      output: [
        `会话 ${sess};6 个 run,每个「run_bash 追加一行 + 读回确认」,完成 ${completed}/${evs.length}。`,
        `后续调用 ${later.length} 次;缓存量已上报 ${laterKnown.length} 次、未知 ${laterUnknown.length} 次。`,
        `已上报的那批里整次未命中(cached/prompt < 0.05)${misses.length} 次。`,
        '',
        '【全部 usage 事件】',
        ...usages.map((u) => `  ${line(u)}${u.k === 0 ? '  (首调)' : ''}${isKnown(u) ? '' : '  ⚠缓存量未知(上游未报)'}`),
        '',
        '【整次未命中的后续调用(只数已上报缓存量的)】',
        ...(misses.length ? misses.map((u) => `  ${line(u)}`) : ['  (无)']),
      ].join('\n'),
      usages, laterCalls: later.length, laterKnownCalls: laterKnown.length, laterUnknownCalls: laterUnknown.length, laterFullMisses: misses.length,
      ttftMs: ttft(evs[0]), tokens: evs.reduce((a, e) => a + (tokensOf(e) || 0), 0) || null,
      toolCalls: evs.flatMap((e) => e.toolCalls),
    };
  });

  await finish();
} catch (e) {
  console.error(String(e?.message || e));
  await finish(String(e?.message || e).split('\n')[0].slice(0, 120));
}
