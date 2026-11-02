/**
 * 搬家的后台模型挑得准不准 —— live-harness 的 `portraitmove` 场景(10-30 画像写入第 2 步)。
 *
 * 不跑对话,只调人点的那几个接口:每轮一个新 agent,记忆里放一批真实形状的条目(模仿 xyra 那份),点「扫描」,判模型挑了哪些、写成什么样:
 *   【门】关于这个人的(称呼 / 语言 / 在学 / 背景)全挑上,句子写给人(第二人称)、保留原来的事实;
 *   【门】对 Agent 的要求、项目、环境、Agent 自己的身份、进度、角色扮演一条都不挑;
 *   【门】挪一条:画像里有,记忆里没;留一条:记忆里还在,再扫不再提。
 * 全部原文存 `portraitmove-evidence.json`。负对照:提示里去掉「Leave out …」那段 → 该挑不该挑的门应当红。
 * 自检(不用模型):`node scripts/lib/portrait-move-live.mjs`。
 */
import { rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

// [记忆原文, 句子里必须留下的词](英文条目可以跟着用户的语言译过来)
const PERSON = [
  ['用户希望被称呼为「阿青」。', /阿青/],
  ['用户平时用中文交流，技术名词保留英文。', /中文/],
  ['用户这几周在学线性代数。', /线性代数/],
  ['用户是独立开发者，住在杭州。', /杭州/],
  ['The user plays the cello on weekends.', /cello|大提琴/i],
];
const NOT_PERSON = [
  // 下面三条写成「用户……」的样子:真实记忆就长这样,这是 #360 live 调出来的那条分界,常识判不出来(10-30 负对照)
  '用户要求改完代码先自己跑一遍再报结果，别只说改好了。',
  '用户喜欢回复先给结论再展开，不要用表格。',
  '用户的账单项目用 pnpm，提交说明一律用英文。',
  'macOS 上 node 在 /opt/homebrew/bin，别用 nvm。',
  '我是 Nori，负责帮用户整理代码。',
  '在角色扮演里用户是船长，我是大副。',
  '10-20 修完了登录页的跳转问题。',
  'The billing service retries webhooks three times before giving up.',
];

/** picks = 这个 agent 的待处理项 [{content, fact}] */
export function grade(picks, error) {
  const byContent = new Map(picks.map((p) => [p.content.replace(/^[-*+]\s+/, ''), p.fact]));
  const missing = PERSON.filter(([c]) => !byContent.has(c)).map(([c]) => c);
  const wrong = NOT_PERSON.filter((c) => byContent.has(c));
  const notAddressed = PERSON.filter(([c]) => byContent.has(c) && !/你|\byou(r)?\b/i.test(byContent.get(c))).map(([c]) => byContent.get(c));
  const thirdPerson = picks.filter((p) => /用户|the user/i.test(p.fact)).map((p) => p.fact);
  const lostFact = PERSON.filter(([c, re]) => byContent.has(c) && !re.test(byContent.get(c))).map(([c]) => byContent.get(c));
  const gates = { allPicked: !missing.length, noneWrong: !wrong.length, addressed: !notAddressed.length && !thirdPerson.length, factKept: !lostFact.length };
  return { ok: !error && Object.values(gates).every(Boolean), gates, missing, wrong, notAddressed, thirdPerson, lostFact };
}

export async function portraitMoveLive(h) {
  const { api, OUT, MODEL, home, rounds } = h;
  const evidence = []; const outs = []; let passed = 0;
  const cfg = await api('/agent/special/config');
  await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ historian: { ...(cfg.historian || {}), modelId: MODEL } }) });
  const settled = async () => {
    for (let i = 0; i < 300; i++) {
      const v = await api('/agent/human/SOUL.md/move');
      if (!v.scanning) return v;
      await new Promise((r) => setTimeout(r, 1000));
    }
    throw new Error('scan did not finish');
  };
  const scan = async () => { await api('/agent/human/SOUL.md/move/scan', { method: 'POST', body: '{}' }); return settled(); };
  const decide = (id, decision) => api(`/agent/human/SOUL.md/move/items/${id}`, { method: 'POST', body: JSON.stringify({ decision }) });
  for (let r = 1; r <= rounds; r++) {
    rmSync(join(home, 'human-history', 'portrait-move.json'), { force: true }); // 「留着」按内容记:每轮用同一批句子,上一轮留着的这一轮不算
    const slug = `portraitmove-${randomUUID().slice(0, 6)}`;
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: 'Nori', systemPrompt: "You are Nori, a hands-on assistant." }) });
    const mem0 = await api(`/agent/agents/${slug}/memory`);
    await api(`/agent/agents/${slug}/memory`, { method: 'PUT', body: JSON.stringify({ content: [...PERSON.map(([c]) => c), ...NOT_PERSON].map((c) => `- ${c}`).join('\n') + '\n', expectedVersion: mem0.version }) });
    let error = null, picks = [], moved = {}, view = null;
    try {
      view = await scan();
      if (view.scanError) throw new Error(`scan: ${view.scanError}`);
      if (view.missed.includes(slug)) throw new Error('scan: this memory was missed');
      picks = view.items.filter((i) => i.memorySlug === slug);
      const [first, second] = picks;
      if (first) await decide(first.id, 'move');
      if (second) await decide(second.id, 'keep');
      const soul = (await api('/agent/human/SOUL.md')).content || '';
      const memory = (await api(`/agent/agents/${slug}/memory`)).content || '';
      const again = await scan();
      moved = { portraitHas: !!first && soul.includes(first.fact), memoryLost: !!first && !memory.includes(first.content), keptStays: !!second && memory.includes(second.content), keptQuiet: !!second && !again.items.some((i) => i.id === second.id) };
    } catch (e) { error = e instanceof Error ? e.message : String(e); }
    const x = grade(picks, error);
    const flow = Object.values(moved).length === 4 && Object.values(moved).every(Boolean);
    const ok = x.ok && flow;
    if (ok) passed++;
    const line = `${Object.entries(x.gates).map(([k, v]) => `${v ? '✓' : '✗'}${k}`).join(' ')} ${flow ? '✓' : '✗'}flow${error ? `;出错 ${error}` : ''}`;
    console.log(`  第 ${r}/${rounds} 轮(${slug}):${ok ? '✓' : '✗'} ${line}`);
    outs.push(`【第 ${r} 轮${ok ? ' ✓' : ' ✗'}】${line}\n${x.missing.length ? `漏挑:${x.missing.join(' / ')}\n` : ''}${x.wrong.length ? `挑错:${x.wrong.join(' / ')}\n` : ''}${picks.map((p) => `  ${p.content} → ${p.fact}`).join('\n')}`);
    evidence.push({ round: r, slug, ok, gates: x.gates, flow: moved, error, picks, missing: x.missing, wrong: x.wrong, notAddressed: x.notAddressed, thirdPerson: x.thirdPerson, lostFact: x.lostFact });
    writeFileSync(join(OUT, 'portraitmove-evidence.json'), JSON.stringify({ model: MODEL, person: PERSON.map(([c]) => c), notPerson: NOT_PERSON, rounds: evidence }, null, 2));
  }
  return { ok: passed === rounds, detail: `${passed}/${rounds} 轮全过`, output: outs.join('\n\n'), toolCalls: [] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const good = [
    { content: PERSON[0][0], fact: '你希望别人叫你阿青。' }, { content: PERSON[1][0], fact: '你平时用中文交流，技术名词保留英文。' },
    { content: PERSON[2][0], fact: '你这几周在学线性代数。' }, { content: PERSON[3][0], fact: '你是独立开发者，住在杭州。' },
    { content: `- ${PERSON[4][0]}`, fact: 'You play the cello on weekends.' },
  ];
  assert.equal(grade(good).ok, true);
  assert.equal(grade(good.slice(1)).ok, false); // 漏挑
  assert.equal(grade([...good, { content: NOT_PERSON[0], fact: '你要求改完先跑一遍。' }]).ok, false); // 对 Agent 的要求被挑走
  assert.equal(grade(good.map((p) => ({ ...p, fact: p.content }))).ok, false); // 没改写成第二人称
  assert.equal(grade(good.map((p, i) => (i ? p : { ...p, fact: '你希望别人叫你小青。' }))).ok, false); // 事实走样
  assert.equal(grade(good, 'x').ok, false);
  console.log('portrait-move-live self-check ok');
}
