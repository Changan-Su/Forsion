// cuvision(10-11):只能看图的 App —— 微信那一类,无障碍树是空的,只能看截图、按坐标点和滚。
// 来由是 Forsion 反馈 55b984eb:让 agent 打开微信看朋友圈,25 轮 9 分钟没做成(坐标按什么算没人告诉模型、
// expect 没满足不回报、按坐标的滚动送不到 App、窗口换了桌面只报「窗口没了」)。
//
// 真的 Computer Use 插件 × 真的 helper × 一个自绘的替身 App(插件仓 scripts/vision-fixture:左边一竖排四个色块,
// 右边 60 行只能靠滚轮滚的列表,全是画出来的)。替身 App 把自己的状态写成 JSON(在第几页、滚到哪),
// 判据看的是这份状态,不是模型的说法;模型报的可见行号再拿去和实际可见的行对。
//
// ⚠️会真的动鼠标、把替身 App 拿到前台几分钟。跑的时候别碰键盘鼠标;要走 devlock。
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROW_HEIGHT = 44, ROW_COUNT = 60; // 与插件仓 scripts/vision-fixture/main.swift 一致
export const defaultFixture = () => join(tmpdir(), 'cu-vision-fixture', 'CUFixture.app');

/** 起引擎之前:核对并把捆绑包放进隔离 home。 */
export function cuVisionSetup({ bundle, fixture, shared }) {
  if (process.platform !== 'darwin') throw new Error('cuvision 只在 macOS 上跑');
  if (!bundle || !existsSync(join(bundle, 'tangu-plugins/computer-use/dist/index.js'))) throw new Error('--cu-plugin 要指向一份构建好的 Computer Use 捆绑包');
  if (!existsSync(join(fixture, 'Contents/MacOS/CUFixture'))) {
    throw new Error(`替身 App 不在 ${fixture}:先在插件仓跑一次 npm run check:vision(它会把替身 App 编出来),或用 --cu-fixture 指过去`);
  }
  // ⚠️引擎第一次调工具时会拿包里随带的 helper 和装着的那个比,不一样就把装着的换掉。开发检出里的 helper 是本机签的,
  // 换上去之后用户授过的「辅助功能 / 屏幕录制」权限全部作废。所以包必须以装着的那份插件为底
  // (只覆盖 tangu-plugins/computer-use/dist 与 skills/),这里先用包自己的只读检查核一遍,不一致就不跑。
  const check = spawnSync(process.execPath, [join(bundle, 'scripts/setup-helper.mjs'), '--check'], { stdio: 'ignore' });
  if (check.status !== 0) {
    throw new Error('--cu-plugin 这份包随带的 helper 和装着的不是同一个(setup-helper.mjs --check 非 0):跑起来会把装着的 helper 换掉、系统授权作废。'
      + '用装着的那份插件目录(~/.forsion-dev/plugins/tangu-computer-use)做底,只覆盖 tangu-plugins/computer-use/dist 与 skills/');
  }
  cpSync(bundle, join(shared, 'plugins/tangu-computer-use'), { recursive: true, filter: (p) => !p.split('/').some((x) => ['.git', 'node_modules'].includes(x)) });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function cuVisionLive({ api, run, OUT, fixture, timeoutMs, ask, tokensOf, ttft }) {
  const plugin = (await api('/agent/plugins')).plugins?.find((p) => /computer-use/.test(p.id));
  if (!plugin) return { ok: false, detail: 'Computer Use 插件没装进隔离 home,场景无效' };
  await api(`/agent/plugins/${plugin.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });

  const statePath = join(OUT, 'cu-fixture-state.json');
  const state = () => { try { return JSON.parse(readFileSync(statePath, 'utf8')); } catch { return null; } };
  spawnSync('pkill', ['-f', 'CUFixture.app/Contents/MacOS/CUFixture']); // 上一次没收干净的
  execFileSync('open', ['-g', '-n', fixture, '--args', statePath]);
  for (let i = 0; i < 40 && !state(); i++) await sleep(250);
  const boot = state();
  if (!boot) return { ok: false, detail: `替身 App 没起来(${statePath} 没出现)` };

  try {
    const ev = await run(`live-cuvision-${Date.now()}`,
      // 照真实用户的说法提;只限定一件事 —— 必须看着屏幕、用点击和滚动来操作(用户 10-11 定的测试口径)。
      `电脑上开着一个叫 CUFixture 的小应用(${fixture})。它的界面是自己画的,只能看着截图、用点击和滚动来操作,不要用脚本或命令行去操控它。`
      // --cu-ask:要点的色块怎么说。color(缺省)=「橙色的那一个」;ordinal =「第三个」;fourth =「第四个」。
      // 缺省按颜色说,是因为按序号说时 gpt-6-luna 常常少数一个(10-11 实测:「第三个」9 次里 7 次点在第二个的正中,
      // 「第四个」3 次里 2 次点在第三个的正中;按颜色 7 次全对)。落点都在色块正中,所以那是模型数数的问题,不是坐标的问题,
      // 这个场景量的是后者。要看前者就带 --cu-ask ordinal。
      + `请你:① 点它左边那一竖排色块里${ask === 'ordinal' ? '的第三个' : ask === 'fourth' ? '的第四个' : '橙色的那一个'};② 把右边的列表往下滚,直到能看见「row 30」;`
      + '③ 告诉我这时列表里看得见的第一行和最后一行各是 row 几。回答的最后单独写一行「可见行:A-B」(A、B 是数字)。',
      timeoutMs);
    await sleep(1200); // 平滑滚动的尾巴
    const st = state() || boot;
    // 实际可见的行(露出一部分也算),按替身 App 自己的滚动位置算。
    const first = Math.floor(st.offset / ROW_HEIGHT) + 1;
    const last = Math.min(ROW_COUNT, Math.ceil((st.offset + st.content.h) / ROW_HEIGHT));
    const said = ev.content.match(/可见行\s*[:：]\s*(\d+)\s*[-–—~到至]\s*(\d+)/);
    const results = ev.toolResults.map((t) => t.full || t.result || '');
    const count = (re) => results.filter((r) => re.test(r)).length;
    const acts = ev.toolCalls.filter((n) => n === 'act_ui').length;
    // 模型每次点在哪、手里那张截图多大:点错的时候要靠这两样分清是「数错了」还是「坐标按另一张图算的」。
    const clicks = ev.toolArgs.filter((t) => t.name === 'act_ui').flatMap((t) => { try { return (JSON.parse(t.arguments).actions || []).filter((a) => a.action === 'click').map((a) => `(${a.x},${a.y})`); } catch { return []; } });
    const sizes = [...new Set(results.flatMap((r) => [...r.matchAll(/\[image\] The attached screenshot is (\d+x\d+)/g)].map((m) => m[1])))];
    const shell = ev.toolCalls.filter((n) => /bash|shell|terminal|script|exec/i.test(n));
    const checks = {
      完成: !ev.error && !!ev.done,
      点到要点的那个色块: st.page === (ask === 'fourth' ? 3 : 2),
      '滚到看得见 row 30': first <= 30 && 30 <= last,
      // 露出半行算不算「看得见」各有各的说法,前后各放一行
      报的可见行对得上: !!said && Math.abs(Number(said[1]) - first) <= 1 && Math.abs(Number(said[2]) - last) <= 1,
      '全程看图 + 点击 / 滚动(没走命令行)': acts > 0 && shell.length === 0,
    };
    const failed = Object.entries(checks).filter(([, pass]) => !pass).map(([name]) => name);
    const metrics = `工具调用 ${ev.toolCalls.length} 次(act_ui ${acts});坐标越界 ${count(/outside the look image bounds/)} 次;`
      + `expect 没等到 ${count(/\[expect\] NOT satisfied/)} 次;「窗口没了」${count(/The current controlled window is no longer available/)} 次;带 [image] 行的结果 ${count(/\[image\]/)} 条;`
      + `替身 App:第 ${st.page + 1} 页,滚动位置 ${Math.round(st.offset)},实际可见 row ${first}-${last},收到 ${st.clicks} 次点击 / ${st.scrolls} 个滚轮事件;`
      + `模型报的可见行 ${said ? `${said[1]}-${said[2]}` : '(没按格式写)'};点击坐标 ${clicks.join(' ') || '(无)'};截图尺寸 ${sizes.join(' / ') || '(无)'}`;
    return { ok: failed.length === 0, detail: `${failed.length ? `没过:${failed.join('、')}。` : ''}${ev.error ? `run 报错:${ev.error}。` : ''}${metrics}`,
      output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls };
  } finally {
    try { process.kill(boot.pid); } catch { /* 已经退了 */ }
  }
}
