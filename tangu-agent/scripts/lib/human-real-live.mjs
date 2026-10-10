/**
 * 协作说明(HUMAN.md)在一段较长的真实任务之后被写成什么样 —— live-harness 的 `humanreal` 场景(10-10)。
 *
 * 反馈(2.13.1):agent 写的协作说明「很关心自己要怎么做,而不是用户该怎么做」,用的也不是用户容易读懂的话。
 * 原有的 `human` 场景把要写的两条内容连同落点一起喂给模型,量不到这件事。这里照人平时干活的样子来:
 * 每轮一个新 agent + 一个小项目(周报脚本),六条消息都不提任何存储库 / 工具 / 文件名:
 *   ①–④ 真干活:需求一开始没说清,后面一条条补(要按地区、退款不算、金额单位)。
 *   ⑤ 用户纠正 agent 的做法(「改完先自己跑一遍」)→ 这是用户对 agent 的要求,归记忆;协作说明不该动。【门】
 *   ⑥ 用户问「我这边以后怎么做能少返工,整理下来我照着做」→ 该写进协作说明。【门:写了】
 * 写成的东西两层判:
 *   代码硬判:跟用户的语言(中文);文档、更新卡上的那句和「更新依据」里不带工具名 / 内部标识这类词(JARGON);⑥ 那一轮自己得存上。
 *   判官(固定 codex/gpt-6-luna、思考 medium,和被测模型无关):逐条判「这件事是谁做」,并点出这条里用户不会说、也没解释的词
 *     (只说「偏抽象」不算,必须点得出具体的词 —— 头一版让它直接判「读不读得懂」,把「按什么分」「定死」这种大白话也判了进去)。
 *     它点出来的词里,用户自己在六条消息里说过的(实测点过「千分位」)和 agent 的名字由代码去掉,不算数。
 *     判官自己也有起伏,每份文档判三次,两道门各按多数算。
 *     【门:没有一条是 agent 自己要做的事;没有一条带这样的词】;「双方各做一半」的条目、逐条带不带「你」、
 *     以及程序直接数的「口径 / 维度 / 交付 / 验收」出现几处(判官对夹在口语里的单个词会漏)只记数。
 * 判官那次调用也经引擎走(系统提示里带着被测版本的协作说明指引),所以判据全写在判官消息里、不指望它读指引。
 * 全部原文(文档、写入参数、判官逐条结论)存 `humanreal-evidence.json`。
 * `--humanreal-rejudge <evidence.json,…>`:不跑任务,只把旧证据里的文档按现在的判据重判一遍(改了判据之后,改前改后才是同一把尺子),
 *   结果存 `humanreal-rejudge-evidence.json`;这一种只出数,不设门。
 * 自检(不用模型):`node scripts/lib/human-real-live.mjs` —— 判官结论的格式校验和判定的几条门。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const JUDGE_MODEL = 'codex/gpt-6-luna';
const AGENT_NAME = 'Mika';
// 写给人看的文档里不该出现的词:工具名、内部文件名、引擎自己的概念。用户自己项目里的词(脚本名、列名)不在此列。
const JARGON = /manage_[a-z]+|load_tools|use_skill|run_bash|\bremember\b|HARNESS|MEMORY\.md|HUMAN\.md|expectedVersion|\bslug\b|\bscope\b|system prompt|系统提示|作用域|上下文窗口|\btokens?\b|子代理|sub-?agent/gi;

function mkProject(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'README.md'), '# 周报\n\n每周一跑一次 `node report.js > weekly.md`,把 weekly.md 发给老板。\n\n数据在 orders.csv,由仓库系统每周五导出。\n');
  writeFileSync(join(dir, 'orders.csv'), [
    'date,region,product,amount,status',
    '2026-09-28,华东,保温杯,128000,paid', '2026-09-28,华南,保温杯,96000,paid', '2026-09-29,华东,餐具套装,243500,paid',
    '2026-09-29,华北,保温杯,57000,refunded', '2026-09-30,华北,餐具套装,181200,paid', '2026-09-30,华南,餐具套装,74800,paid',
    '2026-10-01,华东,保温杯,33000,refunded', '2026-10-01,华南,便当盒,152600,paid', '2026-10-02,华北,便当盒,119900,paid',
    '2026-10-02,华东,便当盒,208300,paid', '2026-10-03,华南,保温杯,41000,paid', '2026-10-03,华北,保温杯,66400,paid', '',
  ].join('\n'));
  writeFileSync(join(dir, 'report.js'), [
    "const fs = require('fs');",
    "const rows = fs.readFileSync(__dirname + '/orders.csv', 'utf8').trim().split('\\n').slice(1).map((l) => l.split(','));",
    'const byProduct = {};',
    'for (const [, , product, amount] of rows) byProduct[product] = (byProduct[product] || 0) + Number(amount);',
    "console.log('# 周报\\n');",
    "console.log('| 产品 | 销售额(万元) |\\n|---|---|');",
    'for (const [p, v] of Object.entries(byProduct)) console.log(`| ${p} | ${(v / 10000).toFixed(2)} |`);',
    '',
  ].join('\n'));
}

// 六条消息都照人平时说话的样子写:不提存储库、工具、文件名(协作说明 / HUMAN.md / 记忆 一概不提)。
const TURNS = [
  ['vague', '这个周报脚本帮我弄一下,老板说现在的看不明白。'],
  ['late-need', '不是排版的问题。老板要看的是每个地区卖了多少,现在是按产品分的。'],
  ['late-rule', '哦对,退款的单子不能算进去,这个我忘说了。'],
  ['late-format', '金额别用万元,老板习惯看元,带千分位。早该跟你说的。'],
  ['correction', '另外以后改完脚本,先自己跑一遍把结果贴给我,别只说改好了。'],
  ['ask', '今天来回改了四趟,主要是我一开始没说清楚。你觉得以后我这边怎么做,咱们能少返工?你有什么希望我配合的也一起说,整理下来,我之后照着做。'],
];

const cjkRatio = (s) => { const c = (s.match(/[一-鿿]/g) || []).length, a = (s.match(/[A-Za-z]/g) || []).length; return c + a ? c / (c + a) : 0; };
const itemsOf = (md) => md.split('\n').map((l) => l.trim()).filter((l) => l && !/^#{1,6}\s/.test(l) && !/^[-*_]{3,}$/.test(l));
const parse = (s) => { try { return JSON.parse(s); } catch { return null; } };
/** 这个 run 里发出去的协作说明写入(完整参数),和真的落了盘的那几次(回执带 change;更新卡上显示的就是回执里的 summary / evidence)。 */
function humanWrites(ev) {
  const changes = ev.toolResults.map((r) => parse(r.full || r.result || '')).filter((v) => v?.kind === 'human_update' && v.change).map((v) => ({ scope: v.change.scope?.kind, summary: v.change.summary, evidence: v.change.evidence }));
  const args = ev.toolArgs.filter((t) => t.name === 'manage_human').map((t) => parse(t.arguments)).filter((a) => a?.action === 'update');
  return { changes, args };
}
const otherStores = (ev) => [...new Set(ev.toolArgs.filter((t) => ['remember', 'manage_harness', 'write_file', 'edit_file', 'apply_patch'].includes(t.name)).map((t) => t.name))];

const judgePrompt = (doc) => `Grade the note below. Do not call any tools. Reply with one JSON object and nothing else.

The note was written by an AI assistant for its human user to read later. The human is not a programmer and will read it without the conversation in front of them. During the work the human themselves said these things, so words from them are familiar to the human:
${TURNS.map(([, m]) => `- ${m}`).join('\n')}

Split the note into items: every bullet or standalone sentence that gives advice, a request or a rule. Skip headings and pure introductions. For each item decide:
- "actor": who performs the action the item asks for. "human" = the human reader does it (a reason such as "so that I can get it right the first time" does not change this). "agent" = the AI assistant does it, in any phrasing: "I will…", "the assistant should…", or an instruction with no subject that only the assistant can carry out (for example "run the script after every change and paste the output", "give two options first"). "both" = the item asks something of each side.
- "terms": the exact words or phrases in the item that this human would likely not understand, or would never say themselves: internal labels or code names, tool or file names of the AI system, and specialist or office-jargon nouns that the human did not use and that the note does not explain (for example 口径, 维度, 交付, 验收标准, 对齐, 默认假设, scope). Everyday wording is never a term, however blunt, general or informal it is. Use an empty list when there are none.

{"items":[{"text":"<the item, shortened to 40 characters>","actor":"human|agent|both","terms":[],"why":"<one short reason>"}]}

NOTE:
"""
${doc}
"""`;

const SAID = TURNS.map(([, m]) => m).join('\n');
const docOf = (r) => [r.agentDoc, r.projectDoc].filter(Boolean).join('\n\n');
const tallyOf = (judge) => ({ items: judge.items.length, agentItems: judge.items.filter((i) => i.actor === 'agent').length, bothItems: judge.items.filter((i) => i.actor === 'both').length,
  hardItems: judge.items.filter((i) => i.terms.length).length, terms: [...new Set(judge.items.flatMap((i) => i.terms))] });
const judgeLines = (judge) => judge.items.map((i) => `[${i.actor}${i.terms.length ? ` · 用户不会说的词:${i.terms.join('、')}` : ''}] ${i.text}(${i.why})`).join('\n');
/** 判官交回来的东西先过一遍格式:actor 不在三个值里、terms 不是字符串数组,整份不认(当成没判成,不当成干净)。 */
function readJudge(text) {
  const judge = parse((String(text || '').match(/\{[\s\S]*\}/) || [''])[0]);
  if (!Array.isArray(judge?.items) || !judge.items.length) return null;
  if (!judge.items.every((i) => i && ['human', 'agent', 'both'].includes(i.actor) && Array.isArray(i.terms) && i.terms.every((t) => typeof t === 'string'))) return null;
  for (const i of judge.items) i.terms = i.terms.filter((t) => t && !SAID.includes(t) && t !== AGENT_NAME); // 用户自己说过的词、agent 的名字不算
  return judge;
}

/** 三次判官结论 → 两道门各按多数;拿来展示逐条结论的是和多数一致的那一次。判成的不到两次算没判成。 */
function pickJudge(votes) {
  if (votes.length < 2) return { judge: null, judgeError: `判官三次里只判成 ${votes.length} 次` };
  const tallies = votes.map(tallyOf);
  const most = (f) => tallies.filter(f).length * 2 > tallies.length;
  const verdict = { noAgentItems: most((t) => t.agentItems === 0), noHardTerms: most((t) => t.hardItems === 0) };
  const at = tallies.findIndex((t) => (t.agentItems === 0) === verdict.noAgentItems && (t.hardItems === 0) === verdict.noHardTerms);
  return { judge: { ...votes[Math.max(at, 0)], verdict, votes: tallies.map((t) => ({ agentItems: t.agentItems, hardItems: t.hardItems, terms: t.terms })) }, judgeError: null };
}

/** 一轮的判定:实跑和重判走同一份。round = { turns, agentDoc, projectDoc, error }(旧证据的 turns 里没有 humanChanges,退回用写入参数)。 */
async function grade(round, judgeDoc, title) {
  const { turns, error } = round;
  const doc = docOf(round);
  const byKey = Object.fromEntries(turns.map((t) => [t.key, t]));
  const shown = turns.flatMap((t) => t.humanChanges || t.humanArgs || []); // 真存上的那几次:更新卡上的那句和「更新依据」
  const facing = [doc, ...shown.flatMap((c) => [String(c.summary || ''), String(c.evidence || '')])].join('\n');
  const jargon = [...new Set(facing.match(JARGON) || [])];
  const items = itemsOf(doc);
  const g = {
    wrote: !!doc.trim() && (byKey.ask?.humanApplied || 0) > 0, // ⑥ 那一轮自己得存上;早先存过、这一轮没存上不算
    correctionClean: !byKey.correction?.humanApplied, // ⑤ 那一轮不该动协作说明
    noJargon: jargon.length === 0,
    userLanguage: cjkRatio(doc) >= 0.6,
  };
  const { judge, judgeError } = doc.trim() ? await judgeDoc(doc, title) : { judge: null, judgeError: null };
  const t = judge ? tallyOf(judge) : null;
  if (t) { g.noAgentItems = judge.verdict ? judge.verdict.noAgentItems : t.agentItems === 0; g.noHardTerms = judge.verdict ? judge.verdict.noHardTerms : t.hardItems === 0; }
  const votes = judge?.votes ? `;三次判:agent 自己要做的 ${judge.votes.map((v) => v.agentItems).join('/')} 条、带用户不会说的词 ${judge.votes.map((v) => v.hardItems).join('/')} 条` : '';
  const ok = !error && g.wrote && g.correctionClean && g.noJargon && g.userLanguage && g.noAgentItems === true && g.noHardTerms === true;
  const addressed = items.filter((l) => /[你您]/.test(l)).length;
  // 程序直接数的几个办公行话:整份很口语、只夹了一个「口径」时,判官三次里常常只点出一次,过了多数那道门。只记数。
  const office = (doc.match(/口径|维度|交付|验收/g) || []).length;
  const midTask = turns.slice(0, 5).reduce((n, x) => n + x.humanApplied, 0); // ⑥ 之前自己写的次数:只记数
  const saveFailed = turns.reduce((n, x) => n + Math.max(0, x.humanArgs.length - x.humanApplied), 0); // 发了写入但没存上的次数(版本号抄错之类):只记数
  const line = error ? `出错 ${error}`
    : `${g.wrote ? '' : `⚠ ⑥ 那一轮没存进协作说明(去了:${byKey.ask?.otherStores.join(',') || '只在回复里说'});`}${!doc.trim() ? '协作说明为空' : t ? `${t.items} 条:agent 自己要做的 ${t.agentItems}、双方各一半 ${t.bothItems}、带用户不会说的词 ${t.hardItems}(${t.terms.join('、') || '无'})${votes}` : `判官没判成(${judgeError})`};带「你」${addressed}/${items.length} 行;「口径 / 维度 / 交付 / 验收」${office} 处;内部用词 ${jargon.join(',') || '无'};⑤ 纠正${g.correctionClean ? '没动协作说明' : '⚠ 被写进了协作说明'}(记忆 ${byKey.correction?.otherStores.includes('remember') ? '记了' : '没记'});⑥ 之前自发写 ${midTask} 次${saveFailed ? `;没存上 ${saveFailed} 次` : ''}`;
  return { ok, gates: g, judge, judgeError, tally: t, jargon, addressed: `${addressed}/${items.length}`, office, midTask, saveFailed, line, doc };
}
const KEYS = ['wrote', 'correctionClean', 'noJargon', 'userLanguage', 'noAgentItems', 'noHardTerms'];
const sumUp = (graded) => { const n = Object.fromEntries(KEYS.map((k) => [k, graded.filter((x) => x.gates[k]).length])); const judged = graded.filter((x) => x.tally).length;
  return `写了 ${n.wrote}、纠正没进协作说明 ${n.correctionClean}、无内部用词 ${n.noJargon}、用户的语言 ${n.userLanguage}、没有 agent 自己要做的事 ${n.noAgentItems}/${judged}、没有用户不会说的词 ${n.noHardTerms}/${judged};只记数:⑥ 之前自发写 ${graded.reduce((a, x) => a + x.midTask, 0)} 次、没存上 ${graded.reduce((a, x) => a + x.saveFailed, 0)} 次`; };

export async function humanRealLive(h) {
  const { run, api, workspace, OUT, MODEL, AGENT_CONFIG, rounds } = h;
  const judgeSlug = `humanreal-judge-${randomUUID().slice(0, 6)}`;
  await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: judgeSlug, name: 'Grader', systemPrompt: 'You grade short documents against a rubric and reply with JSON only. You never call tools.' }) });
  const judgeOnce = async (doc, title) => {
    const jid = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title, model_id: JUDGE_MODEL, agent_config: { ...AGENT_CONFIG, agentSlug: judgeSlug } }) })).session.id;
    const jev = await run(jid, judgePrompt(doc), 180_000, { agentSlug: judgeSlug, thinkingLevel: 'medium' }, undefined, undefined, undefined, undefined, { model: JUDGE_MODEL });
    return readJudge(jev.content);
  };
  // 判官自己也有起伏(同一份没有主语的清单式文档,两次重判「agent 自己要做的」出过 0 条和 5 条):判三次,两道门各按多数算
  const judgeDoc = async (doc, title) => pickJudge((await Promise.all([1, 2, 3].map((n) => judgeOnce(doc, `${title} #${n}`)))).filter(Boolean));

  // ── 重判:不跑任务,旧证据里的每一轮按现在的判据重算一遍(判官重新判,门也重新算)──
  if (h.rejudge?.length) {
    const rows = []; const lines = [];
    for (const file of h.rejudge) {
      const ev = JSON.parse(readFileSync(file, 'utf8')); const name = file.split('/').slice(-3, -2)[0]; const graded = [];
      for (const r of ev.rounds) {
        const x = await grade(r, judgeDoc, `Human real rejudge ${r.round}`); graded.push(x);
        rows.push({ file, model: ev.model, round: r.round, ok: x.ok, gates: x.gates, tally: x.tally, jargon: x.jargon, addressed: x.addressed, office: x.office, midTask: x.midTask, saveFailed: x.saveFailed, error: r.error || null, judge: x.judge, judgeError: x.judgeError });
        console.log(`  ${ev.model} ${name} 第 ${r.round} 轮:${x.ok ? '✓' : '✗'} ${x.line}`);
      }
      const ran = graded.filter((_, n) => !ev.rounds[n].error);
      lines.push(`${ev.model} ${name}:${graded.filter((x) => x.ok).length}/${ran.length} 轮全过${ran.length < graded.length ? `(另有 ${graded.length - ran.length} 轮没跑成)` : ''};${sumUp(ran)}`);
    }
    writeFileSync(join(OUT, 'humanreal-rejudge-evidence.json'), JSON.stringify({ judgeModel: JUDGE_MODEL, rows }, null, 2));
    // 只出数,不设门;有一份有内容的文档判官没判成才算这次重判没跑好
    return { ok: rows.every((x) => x.tally || x.error || x.judgeError === null), detail: lines.join(' | '), output: rows.map((x) => `【${x.model} ${x.file.split('/').slice(-3, -2)[0]} 第 ${x.round} 轮】\n${x.judge ? judgeLines(x.judge) : x.judgeError || x.error || '协作说明为空'}`).join('\n\n'), toolCalls: [] };
  }

  const evidence = []; const tools = []; const outs = []; const graded = [];
  for (let r = 1; r <= rounds; r++) {
    const slug = `humanreal-${randomUUID().slice(0, 6)}`;
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: AGENT_NAME, systemPrompt: `You are ${AGENT_NAME}, a hands-on assistant. Reply in the user's language.` }) });
    const dir = join(workspace, slug); mkProject(dir);
    // 思考档用引擎缺省的 medium(桌面端不改设置时的档),基线与改后两臂一致
    const cfg = { ...AGENT_CONFIG, agentSlug: slug, cwd: dir, approvalMode: 'auto-edit', thinkingLevel: 'medium' };
    const sid = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: `Human real ${r}`, model_id: MODEL, project_path: dir, agent_config: cfg }) })).session.id;
    const turns = []; let error = null;
    for (const [key, msg] of TURNS) {
      const ev = await run(sid, msg, 300_000, cfg);
      const w = humanWrites(ev);
      turns.push({ key, tools: ev.toolCalls, humanApplied: w.changes.length, humanChanges: w.changes, humanArgs: w.args, otherStores: otherStores(ev), approvals: ev.approvals, error: ev.error || null, reply: String(ev.content || '') });
      tools.push(`${key}${r}:${ev.toolCalls.join('/') || '-'}`);
      if (ev.error) { error = `${key}: ${ev.error}`; break; }
    }
    const agentDoc = (await api(`/agent/agents/${slug}/human`).catch(() => ({ content: '' }))).content || '';
    const projectDoc = (await api(`/agent/project-context/human?sessionId=${sid}`).catch(() => ({ content: '' }))).content || '';
    const x = await grade({ turns, agentDoc, projectDoc, error }, judgeDoc, `Human real judge ${r}`); graded.push(x);
    console.log(`  第 ${r}/${rounds} 轮(${slug}):${x.ok ? '✓' : '✗'} ${x.line}`);
    outs.push(`【第 ${r} 轮${x.ok ? ' ✓' : ' ✗'}】${x.line}\n${x.doc || '(协作说明为空)'}${x.judge ? `\n— 判官逐条 —\n${judgeLines(x.judge)}` : ''}`);
    evidence.push({ round: r, slug, ok: x.ok, gates: x.gates, error, jargon: x.jargon, midTask: x.midTask, saveFailed: x.saveFailed, addressed: x.addressed, office: x.office, agentDoc, projectDoc, writes: turns.flatMap((t) => t.humanArgs), judge: x.judge, judgeError: x.judgeError, turns });
    // 每轮落一次盘:台架整体超时(缺省 15 分钟;慢的模型 4 轮就会撞上,跑时带 --timeout)也留得下已经跑完的几轮
    writeFileSync(join(OUT, 'humanreal-evidence.json'), JSON.stringify({ model: MODEL, judgeModel: JUDGE_MODEL, turns: TURNS, rounds: evidence }, null, 2));
  }
  const passed = graded.filter((x) => x.ok).length;
  return { ok: passed === rounds, detail: `${passed}/${rounds} 轮全过;${sumUp(graded)}(判官 ${JUDGE_MODEL})`, output: outs.join('\n\n'), toolCalls: tools, humanRealPassed: passed };
}

// 自检:判官交回来格式不对的结论不能被当成干净;⑥ 那一轮没存上、早先存过也不算写了。
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const item = (o) => JSON.stringify({ items: [{ text: 't', why: 'w', actor: 'human', terms: [], ...o }] });
  assert.equal(readJudge(item({ actor: 'assistant' })), null);
  assert.equal(readJudge(item({ terms: '交付口径' })), null);
  assert.equal(readJudge('not json'), null);
  assert.deepEqual(readJudge(item({ terms: ['千分位', AGENT_NAME, '口径'] })).items[0].terms, ['口径']); // 用户说过的词和 agent 的名字去掉
  const turn = (key, humanApplied, extra = {}) => ({ key, humanApplied, humanArgs: Array(humanApplied).fill({ summary: 's', evidence: 'e' }), otherStores: [], ...extra });
  const turns = (ask, mid = 0) => [turn('vague', 0), turn('late-need', 0), turn('late-rule', mid), turn('late-format', 0), turn('correction', 0, { otherStores: ['remember'] }), turn('ask', ask)];
  const clean = async () => ({ judge: readJudge(item({})), judgeError: null });
  const doc = { agentDoc: '你可以先说清给谁看。', projectDoc: '' };
  assert.equal((await grade({ ...doc, turns: turns(1) }, clean)).ok, true);
  assert.equal((await grade({ ...doc, turns: turns(0, 1) }, clean)).ok, false); // 中途存过、⑥ 没存上
  assert.equal((await grade({ ...doc, turns: turns(1) }, async () => ({ judge: null, judgeError: 'x' }))).ok, false); // 判官没判成不算过
  assert.equal((await grade({ ...doc, turns: turns(1) }, async () => ({ judge: readJudge(item({ actor: 'agent' })), judgeError: null }))).ok, false);
  const jargonTurns = turns(1); jargonTurns[5].humanChanges = [{ summary: '好', evidence: '用 manage_human 记下' }];
  assert.equal((await grade({ ...doc, turns: jargonTurns }, clean)).ok, false); // 「更新依据」里带工具名
  const J = (actor, terms = []) => readJudge(item({ actor, terms }));
  assert.deepEqual(pickJudge([J('human'), J('agent'), J('human')]).judge.verdict, { noAgentItems: true, noHardTerms: true }); // 三次里一次出格:按多数
  assert.deepEqual(pickJudge([J('agent'), J('agent', ['口径']), J('human', ['口径'])]).judge.verdict, { noAgentItems: false, noHardTerms: false });
  assert.equal(pickJudge([J('human')]).judge, null); // 只判成一次不算数
  assert.equal((await grade({ ...doc, turns: turns(1) }, async () => pickJudge([J('agent'), J('agent'), J('human')]))).ok, false);
  console.log('human-real-live 自检通过');
}
