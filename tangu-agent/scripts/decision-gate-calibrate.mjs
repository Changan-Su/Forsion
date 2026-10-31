#!/usr/bin/env node
/**
 * Historian 决策闸的阈值标定(services/judgeSignals.ts 的 DECISION_HI / DECISION_LO 与 CORRECTION_QUESTION)。
 * 一批标注过的「上一条回复 + 用户这句」经云端中继 /api/brain/decision 问决策模型,同一请求里并排问线上问法和备选问法,
 * 记下每条的 P(纠正)、词面判定,再按「两头听模型、中间退回词面」算各组阈值的对错。state 用引擎同一个函数拼。
 *
 * 跑:cd tangu-agent && npm run build && node scripts/decision-gate-calibrate.mjs [--url <云端>] [--token <令牌>] [--out <json>]
 *   缺省读 ~/.forsion-dev/auth.json 的 cloudUrl / token(dev 桌面登录的那个云端)。换了决策模型要重跑。
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { CORRECTION_QUESTION, correctionState, looksLikeCorrection, DECISION_HI, DECISION_LO } from '../dist/services/judgeSignals.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const auth = (() => { try { return JSON.parse(readFileSync(join(homedir(), '.forsion-dev', 'auth.json'), 'utf8')); } catch { return {}; } })();
const URL_ = String(arg('url', auth.cloudUrl || '')).replace(/\/+$/, '');
const TOKEN = arg('token', auth.token || '');
if (!URL_ || !TOKEN) { console.error('需要 --url 与 --token(或 dev 桌面登录过云端)'); process.exit(2); }

// [上一条回复, 用户这句, 是不是纠正]
const A = [ // 纠正,没有词面关键词(词面会漏)
  ['可以用 npm install 安装依赖。', '我这边一直是 pnpm 的。', true],
  ['这是一份 500 字的周报草稿:本周完成了登录页改版、修复了三个支付问题……', '太长了,三行就够。', true],
  ['我把函数改成了用 for 循环遍历。', '我想要的是 map 写法,别用循环。', true],
  ['Here is the summary in English: the meeting covered the Q3 budget.', '用中文回我。', true],
  ['我用 Python 写了这个脚本。', '这个项目只能用 Go。', true],
  ['提交说明:修复了登录页验证码不刷新的问题', '提交说明一律英文,带 fix: 前缀。', true],
  ['已帮你把文件保存到桌面。', '放到 Downloads 里,桌面不要放东西。', true],
  ['推荐你用 MySQL 存这些数据。', '我们公司只用 PostgreSQL。', true],
  ['我给你列了十个方案,各有优缺点。', '只要一个,最推荐的那个。', true],
  ['Sure, I used tabs for indentation.', 'We use two spaces here.', true],
  ['我把按钮颜色改成了红色。', '要蓝色的。', true],
  ['我直接在 main 上提交了。', '改动都要先开分支,再提 PR。', true],
  ['标题我写成了《关于 2026 年度预算的通知》。', '标题别带书名号。', true],
  ['我用了 moment.js 处理日期。', '这个库我们已经弃用了,用 dayjs。', true],
  ['会议纪要已经发给全组了。', '这种东西先给我过目再发。', true],
  ['我把报告做成了 PPT。', '要的是 Word 文档。', true],
];
const B = [ // 纠正,带词面关键词
  ['给你一条命令:npm install', '不对,我的项目都用 pnpm,别给我 npm 的命令。', true],
  ['这道题答案是 42。', '算错了吧,应该是 24。', true],
  ['我按周把数据汇总好了。', '你理解错了,我要的是按月汇总。', true],
  ['我把那三个文件删掉了。', '不是让你删文件,是让你移到归档目录。', true],
  ['Here is a Python script that renames the files.', "That's not what I asked for, I wanted a bash script.", true],
  ['Sure! Here is the plan in English.', '以后回复都用中文。', true],
  ['功能写好了,可以提交了。', '又忘了加单元测试。', true],
  ['I set the deadline reminder for Monday.', 'No, the deadline is Friday, not Monday.', true],
];
const C = [ // 不是纠正,但带词面关键词(词面会误报)
  ['好的。', '不对称加密和对称加密有什么区别?', false],
  ['这是你要的翻译。', "把 'That is wrong' 翻译成中文怎么说?", false],
  ['已经帮你整理好了错题本。', '错了的那几道题再各出三道类似的。', false],
  ['给你推荐了五部电影。', '《不对劲的孩子》这部片子讲什么?', false],
  ['房租是每月 5 号交。', '下次记得提前一天提醒我交房租。', false],
  ['这是你要的代码。', 'next time 这个单词怎么发音?', false],
  ['日程已建好。', '以后每周一都提醒我开周会。', false],
  ['这是查询用的 SQL。', 'WHERE 子句写错了会报什么错?', false],
  ['OK, done.', 'Is it wrong to use var in modern JavaScript?', false],
];
const D = [ // 普通追问,不是纠正
  ['可以用 npm install 安装依赖。', '好,那再给我一条运行测试的命令。', false],
  ['这是会议纪要的摘要。', '谢谢,挺好的。', false],
  ['方案有三点:一是缓存,二是批量写,三是限流。', '能再详细讲讲第二点吗?', false],
  ['已翻译成英文。', '帮我把这个也翻译成日文。', false],
  ['明天的日程已经排好了。', '顺便查一下明天天气。', false],
  ['The script is ready.', 'Great, now add a README.', false],
  ['推荐方案是自建对象存储。', '这个方案的成本大概多少?', false],
  ['计划如上,你看可以吗?', '好的,就按这个来。', false],
  ['总结写好了。', '把它保存成 markdown 文件。', false],
  ['三个方案的对比表在上面。', '第三个方案和第一个比,哪个更省时间?', false],
  ['邮件草稿写好了。', '可以,帮我发出去。', false],
];
const CORPUS = [...A.map((x) => [...x, 'A']), ...B.map((x) => [...x, 'B']), ...C.map((x) => [...x, 'C']), ...D.map((x) => [...x, 'D'])];

const VARIANTS = {
  prod: CORRECTION_QUESTION,
  criteria: { ...CORRECTION_QUESTION, criteria: {
    true: 'The user rejects or fixes something in previous_reply: wrong facts, wrong format, wrong tool, wrong scope, or a different way they want it done.',
    false: 'The user asks something new, follows up, thanks, or agrees; mentioning words like "wrong" in an unrelated question does not count.',
  } },
  short: { type: 'noul', instructions: 'Does the user, in state.user_message, push back on or correct state.previous_reply?' },
};

const rows = [];
for (const [prev, msg, label, cls] of CORPUS) {
  const r = await fetch(`${URL_}/api/brain/decision`, {
    method: 'POST', headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ state: correctionState(prev, msg), questions: VARIANTS }),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`HTTP ${r.status}: ${JSON.stringify(j).slice(0, 200)}`); process.exit(1); }
  const p = Object.fromEntries(Object.keys(VARIANTS).map((k) => [k, j.answers?.[k]?.noul]));
  rows.push({ cls, label, lexical: looksLikeCorrection(msg), msg, p });
}

/** 两头听模型、中间退回词面:对了几条、模型改判了几条(改对 / 改错)。 */
const score = (v, hi, lo) => {
  let right = 0, fixed = 0, broke = 0;
  for (const r of rows) {
    const p = r.p[v];
    const out = typeof p === 'number' ? (p >= hi ? true : p <= lo ? false : r.lexical) : r.lexical;
    if (out === r.label) right++;
    if (out !== r.lexical) (out === r.label ? fixed++ : broke++);
  }
  return { right, fixed, broke };
};
const lexRight = rows.filter((r) => r.lexical === r.label).length;
console.log(`样本 ${rows.length} 条;只用词面对 ${lexRight} 条\n`);
for (const v of Object.keys(VARIANTS)) {
  console.log(`== ${v}`);
  for (const cls of ['A', 'B', 'C', 'D']) console.log(`  ${cls}: ${rows.filter((r) => r.cls === cls).map((r) => (typeof r.p[v] === 'number' ? r.p[v].toFixed(2) : '—')).join(' ')}`);
  const grid = [];
  for (let hi = 0.5; hi <= 0.951; hi += 0.05) for (let lo = 0.05; lo <= hi - 0.049; lo += 0.05) grid.push({ hi: +hi.toFixed(2), lo: +lo.toFixed(2), ...score(v, hi, lo) });
  grid.sort((a, b) => a.broke - b.broke || b.right - a.right || (b.hi - b.lo) - (a.hi - a.lo));
  console.log(`  现行 HI=${DECISION_HI} LO=${DECISION_LO}:`, score(v, DECISION_HI, DECISION_LO));
  console.log('  改错 0 条里对得最多的:', grid.filter((g) => g.broke === 0).slice(0, 5).map((g) => `HI=${g.hi} LO=${g.lo} 对${g.right} 改对${g.fixed}`).join(' | '));
}
const out = arg('out', '');
if (out) { writeFileSync(out, JSON.stringify({ at: new Date().toISOString(), url: URL_, rows }, null, 2)); console.log(`\n明细写到 ${out}`); }
