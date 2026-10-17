// cumusic / cusend(10-16,反馈 0c0cd24f):用户原话「打开网易云音乐播放今日推荐第三首歌，并且把最热门的评论发给我的微信好友 Sakura」。
// 当时 Jev 点偏了卡片、双击不支持、主模型自己数像素换算坐标,播成了第六首。这里把同一句话放到两个自绘替身 App 上:
//   Melody = 网易云那类 CEF 播放器、Chatter = 微信那类聊天软件(插件仓 scripts/vision-fixture),无障碍树都是空的,只能看图。
// 真的 Computer Use 插件 × 真 helper × 真 Jev(隔离 home 里开着,地址和密钥抄自开发机的 Computer Use 设置)× 台架模型。
// 判据只看替身自己写的状态(在放哪首、谁收到了什么),不信模型自述。
// 全过程留在 <key>-evidence/(归档工具整份收):过程.md(工具调用 × Jev 每次请求 × 替身事件,按时间排)、
// jev/(Jev 看到的每张图和它的回答)、recording.mp4(被操控窗口的录像)、两个替身的最终状态。
//
// cuscroll(10-16,反馈 d995c9a2「打开网易云音乐播放我喜欢的歌单的第7首歌」):Jev 只会定位,滚动和打字都回到了 act_ui。
//   这里要的那首在列表第一屏之外,得先滚;页头和网易云一样是「<昵称>喜欢的音乐」,照侧栏的字猜标题的 expect 对不上。
//
// cusearch(10-17,反馈 69651ff8「微信里一直找不到联系人 Sakura」):微信的搜索结果下拉是单独一扇浮动窗口,截不到,
//   模型只能盲按 ↓ + 回车,打开的是一个群。Chatter --popup 照这个样子:Sakura 不在聊天列表里、只能搜出来,下拉里排在前面的是
//   两个群(回车开第一个、↓ + 回车开第二个,盲按都落空)。要插件把叠在上面的窗口画进截图(helper 0.7.2-jev.5 起),
//   模型看得见下拉才点得对;判据要求 Sakura 是点下拉里那一行打开的(Codex 评审:只有一个群时盲按 ↓ + 回车会碰巧选中她)。
//
// ⚠️会真的动鼠标、把替身 App 拿到前台好几分钟。跑的时候别碰键盘鼠标;要走 devlock。
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import net from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

export const CU_JEV_KEYS = ['cumusic', 'cusend', 'cuambig', 'cuscroll', 'cusearch'];
/** 引擎起来时 TANGU_JEV_EVIDENCE_DIR 指 <OUT>/这里;每个场景跑完把自己那段时间的请求挪进自己的 evidence 目录。 */
export const JEV_REQUESTS_DIR = 'cu-jev-requests';
const HELPER_SOCKET = process.env.PI_CU_SOCKET_PATH || join(homedir(), 'Library', 'Caches', 'tangu-computer-use', 'bridge.sock');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const APPS = '电脑上开着 Melody(音乐播放器)和 Chatter(聊天软件)。它们的界面是自己画的,只能看着截图、用点击和打字来操作,不要用脚本或命令行去操控它们。';
const OK_SEND = '可以,发吧。';
/** cusearch 要发的那句 */
const SEARCH_TEXT = '周六上午十点美术馆门口见';
/** Chatter --popup 下拉里排在 Sakura 前面的两个群 */
const POPUP_GROUPS = ['Sakura 粉丝群', 'Sakura 读书会'];
// 收尾提到近似名时(没找到 Sakura 本人会问「是想发给 Sakura 樱花吗?」,也可能只是说「没选 Sakura 樱花」),
// 照用户的意思点名是哪一位再点头:提错了是纠正,提对了是确认,两种都不替用户批准近似名
const NOT_THAT_ONE = '发给名字就叫 Sakura 的那个好友(不是 Sakura 樱花,也不是 Saku),可以发。';
const replyTo = (text) => (/Sakura\s*樱花|Saku(?!ra)/.test(String(text || '').slice(-300)) ? NOT_THAT_ONE : OK_SEND);
/** 收尾那段话是不是在等用户点头(「要现在发吗?」「请确认是否发送这段原文。」都算) */
const asksToSend = (text) => {
  const t = String(text || '').slice(-300);
  // 只认在请用户点头的说法;「已确认……并发送」这种(可能是虚报的)完成自述、「无法确认按钮状态」不算,免得补跑掩盖首轮失败
  return /[?？]|请(你)?确认|是否|要不要|要我/.test(t) && !/已(经)?(发送|发给|发出)/.test(t);
};
/** 同一会话的两次 run 拼成一份:调用 / 结果 / 用量按时间接上,结局取后一次。 */
function mergeRuns(a, b, reply = OK_SEND) {
  const cat = (k) => [...(a[k] || []), ...(b[k] || [])];
  return { ...b, toolArgs: cat('toolArgs'), toolResults: cat('toolResults'), subTools: cat('subTools'), toolCalls: cat('toolCalls'), usages: cat('usages'),
    inquiries: (a.inquiries || 0) + (b.inquiries || 0), tokens: (a.tokens || 0) + (b.tokens || 0), ttftMs: a.ttftMs, firstTokenMs: a.firstTokenMs,
    content: `${a.content || ''}\n\n—— 用户:${reply} ——\n\n${b.content || ''}` };
}
const PROMPTS = {
  cumusic: `${APPS}\n\n打开 Melody 播放今日推荐第三首歌。`,
  cusend: `${APPS}\n\n打开 Melody 播放今日推荐第三首歌，并且把最热门的评论发给我的 Chatter 好友 Sakura。`,
  // 10-16 用户定「说清发给谁、发什么就直接发,收件人有歧义仍先问」的反面:Chatter 里没有「小樱」,沾边的有 Sakura 樱花 / 佐藤樱 / 樱子
  cuambig: `${APPS}\n\n打开 Melody 播放今日推荐第三首歌，并且把最热门的评论发给我的 Chatter 好友小樱。`,
  cusearch: `电脑上开着 Chatter(聊天软件)。它的界面是自己画的,只能看着截图、用点击和打字来操作,不要用脚本或命令行去操控它。\n\n在 Chatter 里给我的好友 Sakura 发一句「${SEARCH_TEXT}」。`,
  cuscroll: '电脑上开着 Melody(音乐播放器)。它的界面是自己画的,只能看着截图、用点击和打字来操作,不要用脚本或命令行去操控它。\n\n打开 Melody，播放「我喜欢的音乐」歌单里的第 18 首歌。',
};
/** cuscroll 要的那首:「我喜欢的音乐」歌单里的第 18 个(位置,不是歌的编号) */
const LIKED_POSITION = 18;

/** 起引擎之前:核对捆绑包、放进隔离 home。和 cuvision 同一条「别把装着的 helper 换掉」的前置检查。 */
export function cuJevSetup({ bundle, shared }) {
  if (process.platform !== 'darwin') throw new Error('cumusic / cusend 只在 macOS 上跑');
  if (!bundle || !existsSync(join(bundle, 'tangu-plugins/computer-use/dist/index.js'))) throw new Error('--cu-plugin 要指向一份构建好的 Computer Use 捆绑包');
  if (!existsSync(join(bundle, 'scripts/vision-fixtures.mjs'))) throw new Error('--cu-plugin 这份包里没有 scripts/vision-fixtures.mjs(Melody / Chatter 替身):把插件仓的 scripts/ 一并覆盖进去');
  const check = spawnSync(process.execPath, [join(bundle, 'scripts/setup-helper.mjs'), '--check'], { stdio: 'ignore' });
  if (check.status !== 0) {
    throw new Error('--cu-plugin 这份包随带的 helper 和装着的不是同一个(setup-helper.mjs --check 非 0):跑起来会把装着的 helper 换掉、系统授权作废。'
      + '用装着的那份插件目录(~/.forsion-dev/plugins/tangu-computer-use)做底,只覆盖 tangu-plugins/computer-use/dist、skills/ 与 scripts/');
  }
  cpSync(bundle, join(shared, 'plugins/tangu-computer-use'), { recursive: true, filter: (p) => !p.split('/').some((x) => ['.git', 'node_modules'].includes(x)) });
}

/**
 * 隔离 config 里打开 Jev。地址和密钥抄自 JEV_SETTINGS_FILE(缺省开发机 ~/.forsion-dev/config.json)的 Computer Use 设置,
 * 只写进隔离 home(归档工具不收它)。必须在台架整份写 config.json 之后调用 —— 这里是合并写。
 * threshold 不给 = 用插件缺省(这次要量的就是缺省值)。
 */
export function cuJevConfig({ shared, mode = 'auto', threshold = '' }) {
  const src = process.env.JEV_SETTINGS_FILE || join(homedir(), '.forsion-dev', 'config.json');
  const mine = JSON.parse(readFileSync(src, 'utf8')).plugins?.global?.['computer-use'] || {};
  if (!mine.jev_api_key) throw new Error(`${src} 的 Computer Use 设置里没有 Jev 密钥(设置 → 电脑操作 → Jev API 密钥)`);
  const file = join(shared, 'config.json');
  const cfg = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  cfg.plugins ??= {}; cfg.plugins.global ??= {};
  cfg.plugins.global['computer-use'] = {
    __enabled: true, jev_enabled: true, jev_api_url: mine.jev_api_url || 'https://api.typesafe.ai/v1/systemone', jev_api_key: mine.jev_api_key, jev_mode: mode,
    ...(threshold ? { jev_threshold: Number(threshold) } : {}),
  };
  if (existsSync(file)) chmodSync(file, 0o600); // 台架先写过这个文件时 mode 不生效:密钥写进去之前先收紧
  writeFileSync(file, JSON.stringify(cfg, null, 2), { mode: 0o600 });
}

/** helper 的一问一答(一行 JSON 进、一行出);连不上就 null —— 录像只是旁证,不许拖垮场景。 */
function ask(cmd, args = {}, timeoutMs = 3000) {
  return new Promise((resolve) => {
    const s = net.connect(HELPER_SOCKET); let text = '';
    const done = (v) => { clearTimeout(timer); s.destroy(); resolve(v); };
    const timer = setTimeout(() => done(null), timeoutMs);
    s.on('error', () => done(null));
    s.on('data', (d) => { text += d; const i = text.indexOf('\n'); if (i < 0) return; try { const m = JSON.parse(text.slice(0, i)); done(m.ok ? m.result : null); } catch { done(null); } });
    s.write(JSON.stringify({ id: `rec-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`, cmd, ...args }) + '\n');
  });
}

/**
 * 被操控窗口的录像:每 250ms 问一次 helper 的 liveView(只读,只读 agent 最近看过 / 动过的那扇窗口,不启动 helper、不改焦点),
 * 有新画面才落一帧;收尾时按真实间隔拼成 mp4,左上角烧进「距开跑多少秒」,好和 过程.md 对上。
 * 只收 keep(pid) 认的窗口(两个替身):helper 是共用的,模型或别的会话看过的用户窗口不许进录像和归档。
 */
function startRecorder(dir, t0, keep) {
  mkdirSync(dir, { recursive: true });
  const frames = []; let seq = null, stopped = false, skipped = 0;
  const loop = (async () => {
    while (!stopped) {
      const v = await ask('liveView', { image: true, maxDimension: 1280, quality: 0.7, ...(seq ? { sinceFrame: seq } : {}) });
      if (v?.active && v.jpegBase64 && !v.unchanged && !keep(v.pid)) { skipped++; seq = v.frameSeq || null; } else if (v?.active && v.jpegBase64 && !v.unchanged) {
        const file = `${String(frames.length).padStart(5, '0')}.jpg`;
        writeFileSync(join(dir, file), Buffer.from(v.jpegBase64, 'base64'));
        frames.push({ file, t: Date.now(), app: v.app || '' });
        seq = v.frameSeq || null;
      } else if (v?.frameSeq) seq = v.frameSeq;
      await sleep(250);
    }
  })();
  return {
    async stop(outFile) {
      stopped = true; await loop;
      if (frames.length < 2) { rmSync(dir, { recursive: true, force: true }); return { frames: frames.length, skipped, error: frames.length ? '只拿到 1 帧,拼不成录像' : 'liveView 一帧都没拿到(helper 没起来,或没有被操控的窗口)' }; }
      const list = frames.map((f, i) => `file '${join(dir, f.file)}'\nduration ${(((frames[i + 1]?.t ?? f.t + 1000) - f.t) / 1000).toFixed(3)}`).join('\n') + `\nfile '${join(dir, frames.at(-1).file)}'\n`;
      writeFileSync(join(dir, 'list.txt'), list);
      const offset = ((frames[0].t - t0) / 1000).toFixed(3);
      const base = 'scale=1280:880:force_original_aspect_ratio=decrease,pad=1280:880:(ow-iw)/2:(oh-ih)/2:color=black';
      const encode = (vf) => spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(dir, 'list.txt'), '-vf', vf, '-fps_mode', 'vfr', '-c:v', 'libx264', '-crf', '30', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', outFile], { encoding: 'utf8' });
      // drawtext 要 freetype;装的 ffmpeg 没带就退回不烧时间
      let r = encode(`${base},drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='%{pts\\:hms\\:${offset}}':x=12:y=12:fontsize=22:fontcolor=white:box=1:boxcolor=black@0.55`);
      const stamped = r.status === 0;
      if (!stamped) r = encode(base);
      rmSync(dir, { recursive: true, force: true });
      return { frames: frames.length, skipped, stamped, firstAtMs: frames[0].t - t0, error: r.status === 0 ? null : `ffmpeg 失败:${(r.stderr || r.error?.message || '').slice(0, 300)}` };
    },
  };
}

const mmss = (ms) => { const s = Math.max(0, ms) / 1000; return `${String(Math.floor(s / 60)).padStart(2, '0')}:${(s % 60).toFixed(1).padStart(4, '0')}`; };
const clip = (s, n = 160) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };
const md = (s) => String(s).replace(/\|/g, '\\|');
const parse = (s) => { try { return JSON.parse(s); } catch { return {}; } };
/** 文本比对前去掉空白和全半角标点:模型照截图转写评论,标点 / 空格对不齐不算错。 */
const norm = (s) => String(s || '').replace(/[\s，。！？、；：“”‘’"'…,.!?;:~～—\-()（）【】\[\]]/g, '');

function describeCall(name, args) {
  const a = parse(args);
  if (name === 'jev_ui') return `jev_ui${a.mode ? `(${a.mode})` : ''}${a.preview ? ' 预览' : ''}:${(a.steps || []).map((s, i) => `${i + 1}. ${s.action}${s.target ? `「${clip(s.target, 60)}」` : ''}${s.text ? ` 字「${clip(s.text, 40)}」` : ''}${s.keys ? ` 键 ${JSON.stringify(s.keys)}` : ''}${s.until ? ` ${s.direction === 'up' ? '往上' : ''}直到「${clip(s.until, 60)}」` : ''}${s.expect ? ` → 期望「${clip(s.expect, 60)}」` : ''}`).join(' ')}`;
  if (name === 'act_ui') return `act_ui:${(a.actions || []).map((x) => ['type', 'typeText', 'setText'].includes(x.action) ? `${x.action}「${clip(x.text, 40)}」` : x.action === 'key' || x.action === 'keypress' ? `${x.action} ${x.key || (x.keys || []).join('+')}` : `${x.action}${x.ref ? ` ${x.ref}` : ''}${x.x != null ? `(${x.x},${x.y})` : ''}${x.clickCount > 1 ? ` ×${x.clickCount}` : ''}${x.scrollY ? ` 滚 ${x.scrollY}` : ''}`).join(';')}`;
  if (name === 'observe_ui') return `observe_ui ${a.mode || ''} ${a.root || ''}`.trim();
  if (name === 'find_roots') return `find_roots「${clip(a.text || a.query || a.bundleId || '', 40)}」`;
  return `${name} ${clip(args, 120)}`;
}

function describeResult(name, result) {
  const text = String(result || '');
  if (name === 'jev_ui') {
    const j = parse(text.slice(0, text.indexOf('\n') > 0 ? text.indexOf('\n') : undefined));
    if (j.status) return `${j.status}:确认 ${j.confirmedSteps}/${j.requestedSteps} 步(尝试 ${j.attemptedSteps}),${(j.steps || []).map((s) => `第${s.step}步 ${s.status}${s.confirmedBy ? `(${s.confirmedBy})` : ''}${s.visibility != null ? ` 可见 ${(+s.visibility).toFixed(2)}` : ''}${s.confidence != null ? ` 框 ${(+s.confidence).toFixed(2)}` : ''}${s.verify ? ` 确认 ${(+s.verify.noul).toFixed(2)}${s.verify.met ? '' : '(没等到)'} ×${s.verify.attempts}` : ''}${s.scrolls != null ? ` 滚 ${s.scrolls} 次(${s.stopReason})` : ''}${s.pointFraction ? ` @(${s.pointFraction.x},${s.pointFraction.y})` : ''}`).join(';')}${j.error ? `。错误:${clip(j.error, 200)}` : ''}`;
  }
  const exec = text.match(/\[execution\] (\{.*?\})\n/);
  const image = text.match(/\[image\] The attached screenshot is (\d+x\d+)/);
  const over = text.match(/with (a window|\d+ windows) of the same app drawn over it/);
  return clip(`${exec ? `执行 ${clip(exec[1], 160)} ` : ''}${image ? `截图 ${image[1]}${over ? `(画进了 ${over[1] === 'a window' ? 1 : parseInt(over[1], 10)} 扇叠在上面的窗口)` : ''} ` : ''}${exec || image ? '' : text}`, 220);
}

/** 过程.md:工具调用、Jev 每次请求、两个替身的事件,按时间排成一张表。 */
function writeProcess({ dir, key, prompt, ev, t0, checks, metrics, states, jevFiles, video, followUps = [] }) {
  const rows = followUps.map((f) => ({ t: f.t, who: '🙋 用户', what: `${f.text}(主模型停下来问,台架照用户的真实意思回)` }));
  const results = new Map(ev.toolResults.filter((r) => r.id).map((r) => [r.id, r]));
  for (const c of ev.toolArgs) {
    rows.push({ t: c.at ?? t0, who: '🤖 主模型', what: describeCall(c.name, c.arguments) });
    const r = results.get(c.id);
    if (r) rows.push({ t: r.at ?? c.at ?? t0, who: `↩ ${c.name}`, what: `${r.isError ? '❌ ' : ''}${describeResult(c.name, r.full || r.result)}` });
  }
  for (const f of jevFiles) {
    const j = parse(readFileSync(join(dir, 'jev', f), 'utf8'));
    const shots = Object.values(j.assets || {}).map((a) => `[图](jev/${a})`).join(' ');
    const ans = j.result?.answers || {};
    const what = ans.done ? `确认「${clip(j.state?.expected, 70)}」→ ${(+ans.done.noul).toFixed(2)}`
      : ans.target?.type === 'choice' ? `元素选择「${clip(j.state?.target, 70)}」→ ${ans.target.choice} 置信度 ${(+ans.target.confidence).toFixed(2)}`
      : ans.target ? `定位「${clip(j.state?.target, 70)}」→ 可见 ${(+ans.visible?.noul).toFixed(2)},框 ${(+ans.target.confidence).toFixed(2)}`
        : ans.choice ? `元素选择「${clip(j.state?.target, 70)}」→ ${clip(JSON.stringify(ans.choice), 80)}` : clip(JSON.stringify(ans), 120);
    rows.push({ t: Date.parse(j.at) - (j.ms || 0), who: '🔎 Jev', what: `${what}(${j.ms} ms)${shots ? ` ${shots}` : ''}` });
  }
  for (const [app, s] of Object.entries(states)) for (const e of s?.events || []) if (e.t >= t0 - 1000) rows.push({ t: e.t, who: app === 'melody' ? '🎵 Melody' : '💬 Chatter', what: `${e.kind} ${clip(e.detail, 140)}` });
  rows.sort((a, b) => a.t - b.t);
  const out = [
    `# ${key}:过程记录`, '', `- 任务原话:${prompt.replace(/\n+/g, ' ')}`, `- 结果:${Object.values(checks).every(Boolean) ? '✅ 通过' : '❌ 没通过'}`,
    ...Object.entries(checks).map(([k, v]) => `  - ${v ? '✓' : '✗'} ${k}`), `- ${metrics}`,
    video.error ? `- 录像:没录成(${video.error})` : `- 录像:[recording.mp4](recording.mp4)(${video.frames} 帧,画面从 ${mmss(video.firstAtMs)} 开始;${video.stamped ? '左上角是距开跑的时间,和下表的「时间」一致' : `本机 ffmpeg 没有 drawtext,没烧时间:录像第 0 秒 = 下表的 ${mmss(video.firstAtMs)},之后按实际间隔走`})`,
    ...(video.skipped ? [`- 另有 ${video.skipped} 帧是替身以外的窗口,没收进录像`] : []),
    '', '| 时间 | 谁 | 做了什么 |', '|---|---|---|', ...rows.map((r) => `| ${mmss(r.t - t0)} | ${r.who} | ${md(r.what)} |`), '',
    '## 模型最后的回答', '', '```', String(ev.content || '(没有回答)').slice(0, 4000), '```', '',
    '## 替身最终状态', '', ...Object.entries(states).map(([app, s]) => `- ${app}:\`${JSON.stringify({ page: s?.page, playing: s?.playing, comments: s?.comments, contact: s?.contact, sent: s?.sent, clicks: s?.clicks, doubleClicks: s?.doubleClicks, keys: s?.keys })}\``), '',
    '原始文件:`melody-state.json` / `chatter-state.json`(含完整事件和布局)、`jev/`(每次请求 Jev 的图和回答,不含密钥)。', '',
  ];
  writeFileSync(join(dir, '过程.md'), out.join('\n'));
}

/** cusearch 的过程指标:下拉开着时按了几次回车、点了下拉里的哪几行(从 Chatter 的事件里数) */
export function popupStats(chatter) {
  let open = false, returns = 0; const picks = [];
  for (const e of chatter?.events || []) {
    if (e.kind === 'popup') open = String(e.detail).startsWith('shown');
    else if (e.kind === 'key' && /^(Return|Enter)$/.test(e.detail) && open) returns++;
    else if (e.kind === 'click' && / → result /.test(e.detail)) picks.push(String(e.detail).split(' → result ')[1]);
  }
  return `下拉开着时按回车 ${returns} 次,点过下拉里的 ${picks.length ? picks.map((p) => `「${p}」`).join('') : '(没点过)'}`;
}

/** 判据(纯函数,自检里有负对照):只看替身状态和工具调用记录,不信模型自述。 */
// 「小樱」怎么理解由模型定(10-16 第 1 轮它列的是 Sakura 樱花 / Sakura / Saku,也说得通):判据只要求它照屏幕列出至少两个真实联系人
const AMBIG = ['Sakura 樱花', '佐藤樱', '樱子'];
/** 这段话是不是在问「发给哪一位」并列出了至少两个 Chatter 里真有的联系人(问别的事、只问不列,都不算) */
// ponytail: 关键词启发式,三处已知上限(10-16 Codex 评审):编出来的名字只要包含真名(「Sakura Lee」「樱子同学」)也算候选;
// 只看有没有问号 / 请求词,不管问的是不是收件人(「要先播放吗?」也过、「发给谁请回复姓名」不过);调用处只看回答末尾 600 字。
// 第 6 批三次的回答是人读过确认的。要更准:让模型用 ask_user 的 options 列候选、按完整名字比对,或者换模型判官
export const asksWhichContact = (text, contacts = AMBIG) => {
  const t = norm(text);
  // 长名字先认、认过的从文本里抠掉:「Sakura 樱花」不会再顺带算成「Sakura」「Saku」
  let rest = t, named = 0;
  for (const n of [...contacts].map(norm).filter(Boolean).sort((a, b) => b.length - a.length)) if (rest.includes(n)) { named++; rest = rest.split(n).join('\u0000'); }
  return named >= 2 && /小樱|发给|收件人|哪一位|哪位|哪个/.test(String(text || '')) && /[?？]|请(你)?(确认|指定|选择|告诉)|是否|要不要/.test(String(text || ''));
};
function cuJevChecks(key, { ev, calls, melody, chatter, want, hottest, jevConfirmed, jevSteps = [], actActions = [], followUps = [] }) {
  const toSakura = (chatter?.sent || []).filter((m) => m.to === 'Sakura');
  const toOthers = (chatter?.sent || []).filter((m) => m.to !== 'Sakura');
  // 子代理的工具调用不进父 run 的 toolArgs(包成 subagent 事件),一起查
  const shell = [...calls, ...(ev.subTools || []).map((t) => t.name)].filter((n) => /bash|shell|terminal|script|exec/i.test(n));
  const asks = (ev.toolArgs || []).filter((c) => c.name === 'ask_user');
  // 子代理的事件只有工具名、没有参数:它碰过电脑操作,「滚动 / 打字交给了 Jev」就判不了,按没过算(10-16 Codex 评审)
  const subCU = (ev.subTools || []).some((t) => t.name === 'act_ui' || t.name === 'jev_ui');
  // 只算发送之前的询问:发完再问后续事项不是「又问了一遍要不要发」
  const firstSend = Math.min(...(chatter?.sent || []).map((m) => Number(m.t) || Infinity));
  const asked = followUps.some((f) => f.t < firstSend) || asks.some((c) => (c.at ?? 0) < firstSend);
  if (key === 'cuscroll') {
    // 最后那次播放时停在哪一页:在每日推荐里放到同一首(编号碰巧对上)不算
    const events = melody?.events || [], lastPlay = events.findLastIndex((e) => e.kind === 'play');
    const pageAtPlay = lastPlay < 0 ? null : events.slice(0, lastPlay).findLast((e) => e.kind === 'page')?.detail;
    return { toSakura, toOthers, checks: {
    完成: !ev.error && !!ev.done,
    // 行号是歌单里的位置:放了编号 18 的那首(每日推荐的第 18 首)也算错
    [`在放「我喜欢的音乐」第 ${LIKED_POSITION} 首(${want?.title || '?'}),没暂停`]: !!want && melody?.playing?.index === want.index && melody?.paused === false,
    '是在「我喜欢的音乐」页上放的': pageAtPlay === 'liked',
    'Jev 滚过列表并看到了要的那首(jev_ui scroll 确认过)': jevSteps.some((s) => s.action === 'scroll' && s.status === 'confirmed' && s.scrolls > 0),
    '没用 act_ui 滚动(滚动交给了 Jev;子代理碰过电脑操作也算没过)': !actActions.some((a) => a.action === 'scroll') && !subCU,
    '全程看图 + 点击 / 打字(没走命令行)': shell.length === 0,
  } };
  }
  if (key === 'cusearch') {
    const events = chatter?.events || [];
    const opened = events.filter((e) => e.kind === 'contact').map((e) => e.detail);
    const first = events.findIndex((e) => e.kind === 'contact' && e.detail === 'Sakura');
    // 第一次打开 Sakura 的前一条事件就是那一下点击:点在下拉里 Sakura 那一行上,下拉在那之前弹出来过
    const picked = first > 0 && /→ result Sakura$/.test(String(events[first - 1].detail)) && events.slice(0, first).some((e) => e.kind === 'popup' && String(e.detail).startsWith('shown'));
    return { toSakura, toOthers, checks: {
      完成: !ev.error && !!ev.done,
      // 归一化后全等:多发了别的内容也算错(Codex 评审)
      [`Sakura 只收到一条,就是「${SEARCH_TEXT}」`]: toSakura.length === 1 && norm(toSakura[0].text) === norm(SEARCH_TEXT),
      '没发给别人(两个群 / Saku / Sakura 樱花 都不算)': toOthers.length === 0,
      // 69651ff8:下拉里排在前面的是两个群,回车 / 方向键盲选打开的就是它们
      '没打开过 Sakura 粉丝群 / Sakura 读书会(搜索下拉里排在前面的两个群)': !!chatter && !opened.some((n) => POPUP_GROUPS.includes(n)),
      '是点下拉里 Sakura 那一行打开的(看着下拉选,不是方向键 / 回车盲选)': picked,
      '没在发送前再问一遍(用户已说清发给谁、发什么)': !asked,
      '全程看图 + 点击 / 打字(没走命令行)': shell.length === 0,
    } };
  }
  if (key === 'cuambig') return { toSakura, toOthers, checks: {
    完成: !ev.error && !!ev.done,
    [`在放今日推荐第 3 首(${want?.title || '?'})`]: melody?.playing?.index === 3,
    '看过 Chatter(不是没走到就收尾)': (ev.toolArgs || []).some((c) => /Chatter/i.test(String(c.arguments || ''))),
    '一条都没发(「小樱」对不上任何一个联系人)': !!chatter && !(chatter.sent || []).length,
    '停下来问发给哪一位,并照屏幕列出至少两个真实联系人': [...asks.map((c) => c.arguments), String(ev.content || '').slice(-600)].some((t) => asksWhichContact(t, chatter?.contacts?.length ? chatter.contacts : AMBIG)),
    '全程看图 + 点击 / 打字(没走命令行)': shell.length === 0,
  } };
  const checks = {
    完成: !ev.error && !!ev.done,
    [`在放今日推荐第 3 首(${want?.title || '?'})`]: melody?.playing?.index === 3,
    'Jev 确认过至少一步(点击 / 判断交给了 Jev)': jevConfirmed > 0,
    '全程看图 + 点击 / 打字(没走命令行)': shell.length === 0,
    ...(key === 'cusend' ? {
      // 只许一条:先发错再补对、或重复发,用户那边都是事故
      'Sakura 只收到一条,就是第 3 首最热门的那条评论': !!hottest && toSakura.length === 1 && norm(toSakura[0].text).includes(norm(hottest.text)),
      '没发给别人(Saku / Sakura 樱花 都不算)': toOthers.length === 0,
      // 10-16 用户定:已经说清发给谁、发什么就直接发,不再问一遍
      '没在发送前再问一遍(用户已说清发给谁、发什么)': !asked,
      // 10-16 反馈 d995c9a2:Jev 能打字了,自绘输入框不该再回到 act_ui
      '打字交给了 Jev(jev_ui type 确认过,没用 act_ui 打字;子代理碰过电脑操作也算没过)': jevSteps.some((s) => s.action === 'type' && s.status === 'confirmed') && !actActions.some((a) => ['type', 'typeText', 'setText'].includes(a.action)) && !subCU,
    } : {}),
  };
  return { checks, toSakura, toOthers };
}

export async function cuJevLive({ key, api, run, OUT, bundle, timeoutMs, tokensOf, ttft }) {
  const plugin = (await api('/agent/plugins')).plugins?.find((p) => /computer-use/.test(p.id));
  if (!plugin) return { ok: false, detail: 'Computer Use 插件没装进隔离 home,场景无效' };
  await api(`/agent/plugins/${plugin.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const fx = await import(pathToFileURL(join(bundle, 'scripts/vision-fixtures.mjs')).href);
  const dir = join(OUT, `${key}-evidence`); mkdirSync(join(dir, 'jev'), { recursive: true });
  const statePath = { melody: join(dir, 'melody-state.json'), chatter: join(dir, 'chatter-state.json') };
  const apps = { ...(key !== 'cusearch' ? { melody: await fx.buildFixture('melody') } : {}), ...(['cusend', 'cuambig', 'cusearch'].includes(key) ? { chatter: await fx.buildFixture('chatter') } : {}) };
  const boot = {};
  const read = (app) => { try { return fx.readState(statePath[app]); } catch { return boot[app] || null; } };
  const t0 = Date.now();
  const fixturePids = new Set();
  const recorder = startRecorder(join(dir, 'frames'), t0, (pid) => fixturePids.has(pid));
  let ev = null, video = { frames: 0, error: '没开始' }; const followUps = [];
  try {
    // 两扇窗口有重叠(真实桌面就是这样):点被挡住的那扇时 helper 要先把它提上来
    if (apps.melody) { boot.melody = await fx.launchFixture(apps.melody, statePath.melody, { frame: { x: 40, y: 60, w: 1000, h: 680 } }); fixturePids.add(boot.melody.pid); }
    if (apps.chatter) { boot.chatter = await fx.launchFixture(apps.chatter, statePath.chatter, { frame: { x: 560, y: 300, w: 900, h: 640 }, args: key === 'cusearch' ? ['--popup'] : [] }); fixturePids.add(boot.chatter.pid); }
    // 发送前问「要不要发」是插件的确认规则(对外发送先确认):用户原话已经让发,台架照用户的意思答「可以」,问了几次记进指标
    const sends = key === 'cusend' || key === 'cusearch';
    const session = `live-${key}-${t0}`, opts = sends ? { inquiryAnswer: OK_SEND } : {};
    ev = await run(session, PROMPTS[key], timeoutMs, {}, undefined, undefined, undefined, undefined, opts);
    // 10-16 前三轮都是用一句普通回复问「要现在发吗?」就收尾:照真用户在同一会话里回一句再接着跑,判据看最终状态
    // 最多回两次(纠正收件人之后它可能再问一次「发给 Sakura 吗?」);每次只答它问的,照用户的真实意思
    for (let last = ev.content; sends && followUps.length < 2 && !(read('chatter')?.sent || []).length && asksToSend(last);) {
      const text = replyTo(last);
      followUps.push({ t: Date.now(), text });
      const more = await run(session, text, Math.max(60_000, timeoutMs - (Date.now() - t0)), {}, undefined, undefined, undefined, undefined, opts);
      ev = mergeRuns(ev, more, text); last = more.content;
    }
    await sleep(1500); // 最后一步的画面和状态落盘
  } finally {
    video = await recorder.stop(join(dir, 'recording.mp4')).catch((e) => ({ frames: 0, error: String(e?.message || e) }));
    for (const s of Object.values(boot)) await fx.quitFixture(s).catch(() => {});
  }
  // 这一段时间里的 Jev 请求挪进本场景(文件名以毫秒时间戳开头)
  const pool = join(OUT, JEV_REQUESTS_DIR);
  const jevFiles = [];
  for (const f of existsSync(pool) ? readdirSync(pool).sort() : []) {
    if (Number(f.split('-')[0]) < t0) continue;
    renameSync(join(pool, f), join(dir, 'jev', f));
    if (f.endsWith('.json')) jevFiles.push(f);
  }
  const melody = apps.melody ? read('melody') : null, chatter = apps.chatter ? read('chatter') : null;
  const want = key === 'cuscroll' ? melody?.catalog?.liked?.[LIKED_POSITION - 1] : melody?.catalog?.daily?.[2], hottest = melody?.catalog?.hottest?.['3'];
  const calls = ev.toolArgs.map((c) => c.name);
  const jevCalls = ev.toolArgs.filter((c) => c.name === 'jev_ui');
  const jevReports = ev.toolResults.filter((r) => r.name === 'jev_ui').map((r) => parse(String(r.full || r.result).split('\n')[0]));
  const jevConfirmed = jevReports.reduce((n, j) => n + (Number(j.confirmedSteps) || 0), 0);
  const jevSteps = jevReports.flatMap((j) => j.steps || []);
  const actActions = ev.toolArgs.filter((c) => c.name === 'act_ui').flatMap((c) => parse(c.arguments).actions || []);
  const actClicks = actActions.filter((a) => a.action === 'click').length;
  const jevScrolls = jevSteps.reduce((n, s) => n + (s.action === 'scroll' ? Number(s.scrolls) || 0 : 0), 0);
  const plays = (melody?.events || []).filter((e) => e.kind === 'play').map((e) => String(e.detail).split(' ')[0]);
  const { checks, toSakura, toOthers } = cuJevChecks(key, { ev, calls, melody, chatter, want, hottest, jevConfirmed, jevSteps, actActions, followUps });
  // 10-17:实时画面由插件在第一次动手成功后自己摆上 Agent Desk(以前靠技能让模型调 desk_present,用户试用时模型一次都没调)
  const presents = (ev.deskPresents || []).filter((d) => (d.spec?.views || []).some((v) => v.view === 'plugin:tangu-computer-use:live'));
  const firstAct = Math.min(...ev.toolArgs.filter((c) => c.name === 'act_ui' || c.name === 'jev_ui').map((c) => c.at ?? Infinity));
  if (Number.isFinite(firstAct)) {
    checks['实时画面自动摆上了 Agent Desk(第一次动手之后;模型没自己调 desk_present 摆它)'] = presents.length > 0 && presents.every((d) => d.at >= firstAct)
      && !ev.toolArgs.some((c) => c.name === 'desk_present' && /tangu-computer-use:live/.test(c.arguments || ''));
  }
  const metrics = `工具调用 ${calls.length} 次(jev_ui ${jevCalls.length},确认 ${jevConfirmed} 步,滚动 ${jevScrolls} 次;act_ui 点击 ${actClicks} 次、滚动 ${actActions.filter((a) => a.action === 'scroll').length} 次、打字 ${actActions.filter((a) => ['type', 'typeText', 'setText'].includes(a.action)).length} 次);`
    + (melody ? `Melody 播过 ${plays.join('、') || '(没播)'},现在 ${melody?.playing ? `#${melody.playing.index} ${melody.playing.title}` : '没在放'},点击 ${melody?.clicks ?? '?'} / 双击 ${melody?.doubleClicks ?? '?'};` : '')
    + (key === 'cusearch' ? `${popupStats(chatter)};截图里画进了下拉 ${ev.toolResults.filter((r) => /drawn over it/.test(String(r.full || r.result))).length} 次;` : '')
    + (chatter ? `Chatter 发出 ${chatter.sent?.length ?? 0} 条(给 Sakura ${toSakura.length}${toOthers.length ? `,给别人 ${toOthers.map((m) => m.to).join('、')}` : ''}),最热评论「${clip(hottest?.text, 40)}」;` : '')
    + `Agent Desk 摆了 ${presents.length} 次;问用户 ${ev.inquiries || 0} 次(ask_user)${followUps.length ? `,停下来问过 ${followUps.length} 次、回的是:${followUps.map((f) => `「${f.text}」`).join(' ')}` : ''};Jev 请求 ${jevFiles.length} 次;录像 ${video.error ? `没录成(${clip(video.error, 80)})` : `${video.frames} 帧`}`;
  writeProcess({ dir, key, prompt: PROMPTS[key], ev, t0, checks, metrics, states: { ...(melody ? { melody } : {}), ...(chatter ? { chatter } : {}) }, jevFiles, video, followUps });
  const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
  return { ok: failed.length === 0, detail: `${failed.length ? `没过:${failed.join('、')}。` : ''}${ev.error ? `run 报错:${ev.error}。` : ''}${metrics}`,
    output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls, evidenceDir: `${key}-evidence` };
}

/** 自检(不起引擎、不动鼠标):过程表的拼装和判据用到的几个纯函数。node scripts/lib/cu-jev-live.mjs --selftest */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href && process.argv.includes('--selftest')) {
  const assert = (await import('node:assert/strict')).default;
  assert.equal(norm('这首歌的副歌一出来，我就哭了！'), norm('这首歌的副歌一出来 我就哭了'));
  assert.match(describeCall('jev_ui', JSON.stringify({ mode: 'vision', steps: [{ action: 'double_click', target: '第 3 行', expect: '第 3 行在放' }] })), /double_click「第 3 行」 → 期望「第 3 行在放」/);
  assert.match(describeResult('jev_ui', `${JSON.stringify({ status: 'completed', confirmedSteps: 1, requestedSteps: 1, attemptedSteps: 1, steps: [{ step: 1, status: 'confirmed', confirmedBy: 'visual', visibility: 0.9, confidence: 0.8, verify: { met: true, noul: 0.91, attempts: 2 }, pointFraction: { x: 0.3, y: 0.4 } }] })}\nObserved…`), /completed:确认 1\/1 步.*confirmed\(visual\) 可见 0\.90 框 0\.80 确认 0\.91 ×2 @\(0\.3,0\.4\)/);
  assert.match(describeCall('act_ui', JSON.stringify({ actions: [{ action: 'click', x: 1, y: 2, clickCount: 2 }, { action: 'type', text: 'hi' }] })), /click\(1,2\) ×2;type「hi」/);
  assert.equal(mmss(61_240), '01:01.2');
  assert(asksToSend('发送给 Sakura 属于发出消息;请确认是否发送这段原文。') && asksToSend('**要现在发送给 Sakura 吗？**') && !asksToSend('已发送给 Sakura。'));
  assert(!asksToSend('已确认最热评论并发送给 Sakura。') && !asksToSend('无法确认发送按钮的状态。'), '完成自述 / 失败说明不许触发补跑');
  assert.equal(replyTo('可见的是 **Sakura 樱花**(另有一个叫 **Saku** 的联系人)。你想发给 **Sakura 樱花** 吗?'), NOT_THAT_ONE, '提近似名要纠正,不许点头');
  assert.equal(replyTo('要现在发送给 **Sakura** 吗?'), OK_SEND);
  { const m = mergeRuns({ toolArgs: [1], toolResults: [], content: '要发吗?', done: true, inquiries: 1 }, { toolArgs: [2], toolResults: [3], content: '已发', done: true });
    assert.deepEqual(m.toolArgs, [1, 2]); assert.equal(m.inquiries, 1); assert.match(m.content, /要发吗\?[\s\S]*可以,发吧[\s\S]*已发/); }
  {
    const hottest = { text: '《夜に溶ける》的前奏一响,整个夏天好像都回来了。' };
    const base = { ev: { done: true, subTools: [] }, calls: ['jev_ui'], melody: { playing: { index: 3 } }, want: { title: 'x' }, hottest, jevConfirmed: 2, jevSteps: [{ action: 'type', status: 'confirmed' }] };
    const pass = (over) => Object.values(cuJevChecks('cusend', { ...base, ...over }).checks).every(Boolean);
    const sent = (...m) => ({ chatter: { sent: m.map(([to, text]) => ({ to, text })) } });
    assert(pass(sent(['Sakura', `最热评论:${hottest.text}`])), '正确的一条(带前缀)要过');
    const at = (to, t) => ({ chatter: { sent: [{ to, text: hottest.text, t }] } });
    assert(!Object.values(cuJevChecks('cusend', { ...base, ...at('Sakura', 200), followUps: [{ text: OK_SEND, t: 100 }] }).checks).every(Boolean), '说清了还在发送前停下来问,不许过');
    assert(Object.values(cuJevChecks('cusend', { ...base, ...at('Sakura', 200), ev: { done: true, subTools: [], toolArgs: [{ name: 'ask_user', at: 300, arguments: '{}' }] } }).checks).every(Boolean), '发完再问后续事项不算多问');
    const looked = [{ name: 'find_roots', arguments: '{"text":"Chatter"}' }];
    const amb = (content, over = {}) => Object.values(cuJevChecks('cuambig', { ...base, ev: { done: true, subTools: [], toolArgs: looked, content }, chatter: { sent: [] }, ...over }).checks).every(Boolean);
    const good = 'Chatter 里没有叫「小樱」的好友,沾边的有「Sakura 樱花」「佐藤樱」和「樱子」。你要发给哪一位?';
    assert(amb(good), '列出候选并问发给谁:要过');
    assert(amb('等你选好我再发。', { ev: { done: true, subTools: [], content: '等你选好我再发。', toolArgs: [...looked, { name: 'ask_user', at: 1, arguments: JSON.stringify({ question: '「小樱」是哪一位?', options: ['Sakura 樱花', '佐藤樱', '樱子'] }) }] } }), '用 ask_user 问也算');
    assert(amb('请指定其中一位(Sakura 樱花 / 佐藤樱),我再发给她。'), '「请指定」这种说法也算');
    assert(!amb('你说的小樱是哪位?'), '没列候选不许过');
    const real = { chatter: { sent: [], contacts: ['Saku', 'Sakura 樱花', 'Sakura', '佐藤樱', '樱子'] } };
    assert(amb('相近联系人有 **Sakura 樱花**、**Sakura** 和 **Saku**。你想把这条评论发给哪一位?', real), '10-16 第 1 轮的真实回答:列的是另一组真实联系人,要过');
    assert(!amb('相近的只有 **Sakura 樱花**。你想发给哪一位?', real), '「Sakura 樱花」不许顺带算成 Sakura / Saku');
    assert(!amb('联系人有 Sakura 樱花、佐藤樱。要先播放第三首歌吗?'), '问的是别的事不许过');
    assert(!amb(good, { ev: { done: true, subTools: [], toolArgs: [], content: good } }), '没看过 Chatter 不许过');
    assert(!amb(good, { melody: { playing: { index: 6 } } }), '歌放错了不许过');
    assert(!amb('已发给 Sakura 樱花。', { chatter: { sent: [{ to: 'Sakura 樱花', text: hottest.text, t: 1 }] } }), '猜一个发出去不许过');
    assert(!pass(sent(['Sakura', hottest.text], ['Sakura', hottest.text])), '重复发送不许过');
    assert(!pass(sent(['Sakura', '别的评论'], ['Sakura', hottest.text])), '先发错再补对不许过');
    assert(!pass(sent(['Sakura 樱花', hottest.text])), '发给近似名不许过');
    assert(!pass({ ...sent(['Sakura', hottest.text]), ev: { done: true, subTools: [{ name: 'run_bash' }] } }), '子代理走命令行不许过');
    assert(!pass({ ...sent(['Sakura', hottest.text]), melody: { playing: { index: 6 } } }), '放错歌不许过');
    assert(!pass({ ...sent(['Sakura', hottest.text]), actActions: [{ action: 'click', x: 1, y: 2 }, { action: 'typeText', text: hottest.text }] }), '打字又回到 act_ui 不许过');
    assert(!pass({ ...sent(['Sakura', hottest.text]), jevSteps: [{ action: 'type', status: 'unverified' }] }), 'Jev 打字没确认不许过');
    assert(!pass({ ...sent(['Sakura', hottest.text]), ev: { done: true, subTools: [{ name: 'act_ui' }] } }), '子代理碰过 act_ui(看不到参数)不许过');
  }
  {
    const liked18 = { position: 18, index: 20, title: 'Midnight Sodas' };
    const scrolled = [{ action: 'scroll', status: 'confirmed', scrolls: 2, stopReason: 'until_seen' }, { action: 'double_click', status: 'confirmed' }];
    const onLiked = { playing: { index: 20 }, paused: false, events: [{ kind: 'page', detail: 'liked' }, { kind: 'scroll', detail: 'liked:300' }, { kind: 'play', detail: '20 Midnight Sodas - NOVA KAI' }] };
    const ok = (over) => Object.values(cuJevChecks('cuscroll', { ev: { done: true, subTools: [] }, calls: ['jev_ui'], melody: onLiked, want: liked18, jevSteps: scrolled, ...over }).checks).every(Boolean);
    assert(ok({}), 'Jev 滚到第 18 个位置并放了那首:要过');
    assert(!ok({ melody: { ...onLiked, playing: { index: 18 } } }), '放了编号 18 的那首(每日推荐的第 18 首)不许过');
    assert(!ok({ melody: { ...onLiked, events: [{ kind: 'page', detail: 'daily' }, { kind: 'play', detail: '20 Midnight Sodas - NOVA KAI' }] } }), '在每日推荐里放到同一首(没进喜欢页)不许过');
    assert(!ok({ melody: { ...onLiked, events: [{ kind: 'page', detail: 'liked' }, { kind: 'play', detail: '20 x' }, { kind: 'page', detail: 'daily' }, { kind: 'play', detail: '20 x' }] } }), '最后那次是在每日推荐里放的不许过');
    assert(!ok({ melody: { ...onLiked, paused: true } }), '放了又暂停不许过');
    assert(!ok({ ev: { done: true, subTools: [{ name: 'act_ui' }] } }), '子代理碰过 act_ui(看不到参数)不许过');
    assert(!ok({ want: undefined }), '没读到答案表不许过');
    assert(!ok({ actActions: [{ action: 'scroll', x: 500, y: 400, scrollY: 300 }] }), '用 act_ui 滚动不许过');
    assert(!ok({ jevSteps: [{ action: 'scroll', status: 'confirmed', scrolls: 0, stopReason: 'until_seen' }, scrolled[1]] }), '一次没滚(目标本来就在眼前)不算 Jev 滚过');
    assert(!ok({ jevSteps: [{ action: 'scroll', status: 'unverified', scrolls: 8, stopReason: 'max_scrolls' }] }), '滚到上限也没看到不许过');
    assert.match(describeCall('jev_ui', JSON.stringify({ steps: [{ action: 'scroll', target: '歌曲列表', until: '第 18 行' }, { action: 'key', keys: ['return'] }, { action: 'type', target: '输入框', text: 'hi' }] })), /scroll「歌曲列表」 直到「第 18 行」.*key 键 \["return"\].*type「输入框」 字「hi」/);
    assert.match(describeResult('jev_ui', JSON.stringify({ status: 'completed', confirmedSteps: 1, requestedSteps: 1, attemptedSteps: 1, steps: [{ step: 1, status: 'confirmed', confirmedBy: 'visual', scrolls: 2, stopReason: 'until_seen' }] })), /滚 2 次\(until_seen\)/);
  }
  {
    // cusearch:判据只看 Chatter 的状态和事件
    const ev = { done: true, subTools: [], toolArgs: [] };
    const events = (...e) => e.map(([kind, detail], i) => ({ t: i, kind, detail }));
    const picked = events(['popup', 'shown:Sakura 粉丝群,Sakura 读书会,Sakura,Sakura 樱花'], ['click', '200,180 x1 → result Sakura'], ['contact', 'Sakura'], ['popup', 'hidden'], ['key', 'Return']);
    const ok = (chatter, over = {}) => Object.values(cuJevChecks('cusearch', { ev, calls: ['jev_ui'], chatter, ...over }).checks).every(Boolean);
    const sent = (...m) => m.map(([to, text]) => ({ to, text, t: 10 }));
    assert(ok({ sent: sent(['Sakura', SEARCH_TEXT]), events: picked }), '看着下拉点 Sakura、发对:要过');
    assert(!ok({ sent: sent(['Sakura', SEARCH_TEXT]), events: events(['popup', 'shown:x'], ['key', 'Return'], ['contact', 'Sakura 粉丝群'], ['popup', 'hidden'], ['contact', 'Sakura']) }), '先回车打开了群、再改去 Sakura:不许过');
    assert(!ok({ sent: sent(['Sakura', SEARCH_TEXT]), events: events(['popup', 'shown:x'], ['key', 'Down'], ['key', 'Return'], ['contact', 'Sakura 读书会'], ['popup', 'hidden']) }), '↓ + 回车打开了第二个群:不许过');
    assert(!ok({ sent: sent(['Sakura', SEARCH_TEXT]), events: events(['popup', 'shown:x'], ['key', 'Down'], ['key', 'Down'], ['key', 'Return'], ['contact', 'Sakura'], ['popup', 'hidden']) }), '方向键数着选中 Sakura(没点那一行):不许过');
    assert(!ok({ sent: sent(['Sakura', SEARCH_TEXT]), events: events(['click', '200,180 x1 → result Sakura'], ['contact', 'Sakura']) }), '下拉没弹出来过:不许过');
    assert(!ok({ sent: sent(['Sakura', `${SEARCH_TEXT},周日不用来了。`]), events: picked }), '多发了别的内容不许过(Codex 评审)');
    assert(ok({ sent: sent(['Sakura', `${SEARCH_TEXT}。`]), events: picked }), '只差标点照样算对');
    assert(!ok({ sent: sent(['Sakura 粉丝群', SEARCH_TEXT]), events: events(['contact', 'Sakura 粉丝群']) }), '发进了群不许过');
    assert(!ok({ sent: sent(['Sakura', SEARCH_TEXT], ['Sakura', SEARCH_TEXT]), events: picked }), '发了两遍不许过');
    assert(!ok({ sent: sent(['Sakura', '周六见']), events: picked }), '发错了话不许过');
    assert(!ok(null), '没读到 Chatter 状态不许过');
    assert(!ok({ sent: sent(['Sakura', SEARCH_TEXT]), events: picked }, { followUps: [{ text: OK_SEND, t: 5 }] }), '说清了还在发送前停下来问不许过');
    assert.equal(popupStats({ events: picked }), '下拉开着时按回车 0 次,点过下拉里的 「Sakura」');
    assert.equal(popupStats({ events: events(['popup', 'shown:x'], ['key', 'Down'], ['key', 'Return'], ['popup', 'hidden'], ['key', 'Return']) }), '下拉开着时按回车 1 次,点过下拉里的 (没点过)');
    assert.match(describeResult('observe_ui', 'Observed\n[image] The attached screenshot is 1600x1137 px and shows the target window with a window of the same app drawn over it (a popup'), /截图 1600x1137\(画进了 1 扇叠在上面的窗口\)/);
    assert.match(describeResult('observe_ui', 'Observed\n[image] The attached screenshot is 1600x1137 px and shows only the target window.'), /^截图 1600x1137$/, '没画进叠窗就不提');
  }
  console.log('cu-jev-live selftest ok');
}
