/**
 * 关于这个人的事有没有写进画像(human/SOUL.md)—— live-harness 的 `humanportrait` 场景(10-29)。
 *
 * 正式版里 human/ 的画像一直是空的:remember 只有 agent / project 两档,「叫我什么、在学什么」都落进了各自 agent 的记忆。
 * 这一版 remember 多了 `person`(写画像,所有 Agent 都读),并且跨档取代:旧的那条在 agent 记忆里,改口的新说法写进画像时把旧的拿掉。
 * 每轮一个新 agent + 一个小项目;agent 记忆里先放一条旧说法(叫「老板」),四条消息照人平时说话的样子写,不提任何存储 / 工具:
 *   ① 改称呼 + 语言习惯 → 画像【门:画像里有「阿青」;agent 记忆里旧的「老板」没了、也没另存一份「阿青」】
 *   ② 在学什么、在做什么 → 画像【门:画像里有「线性代数」或「记账」】
 *   ③ 纠正 agent 的做法(改完先自己跑一遍)→ 这是对 agent 的要求【门:不进画像】;落在哪只记录
 *   ④ 只在这个项目成立的事(提交说明用英文)→ 项目记忆【门:不进画像】;落在哪只记录
 * 最后另一个 agent 开新会话问「我叫什么」【门:答得出「阿青」】。
 * 全部原文(画像、两份记忆、每轮 remember 参数)存 `humanportrait-evidence.json`。
 * 基线(没有 person 档的旧引擎)上画像应当还是空的 → 负对照红。
 * 自检(不用模型):`node scripts/lib/human-portrait-live.mjs`。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const SEED = '- 用户希望被称呼为「老板」。\n';
const TURNS = [
  ['name', '以后别叫我老板了，叫我阿青就行。我平时用中文，技术名词保留英文就好。'],
  ['life', '顺便说下，我这几周在学线性代数，周末在做一个记账小程序。'],
  ['workflow', '另外你以后改完代码，先自己跑一遍再告诉我结果，别只说改好了。'],
  ['project', '这个项目里提交说明一律用英文写。'],
];
const WORKFLOW = /跑一遍|自己跑|自行运行|先运行|运行并|run it|verify/i; // 负对照里模型写的是「先自行运行并验证」
const PROJECT = /提交说明|commit/i;

/** 代码判的几道门;where = 两条「不该进画像」的事实际落在哪(只记录)。 */
export function grade({ soul, agentMem, projectMem, readerReply, error }) {
  const gates = {
    soulName: soul.includes('阿青'),
    soulLife: /线性代数|记账/.test(soul),
    oldGone: !agentMem.includes('老板'),
    noAgentDup: !agentMem.includes('阿青'),
    workflowNotInSoul: !WORKFLOW.test(soul),
    projectNotInSoul: !PROJECT.test(soul),
    crossAgent: readerReply.includes('阿青'),
  };
  const where = { workflow: WORKFLOW.test(agentMem) ? 'agent' : WORKFLOW.test(projectMem) ? 'project' : 'none', project: PROJECT.test(projectMem) ? 'project' : PROJECT.test(agentMem) ? 'agent' : 'none' };
  return { ok: !error && Object.values(gates).every(Boolean), gates, where };
}

export async function humanPortraitLive(h) {
  const { run, api, workspace, OUT, MODEL, AGENT_CONFIG, rounds } = h;
  const reader = `portrait-reader-${randomUUID().slice(0, 6)}`;
  await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug: reader, name: 'Sora', systemPrompt: "You are Sora, a helpful assistant. Reply in the user's language." }) });
  const memText = async (slug) => (await api(`/agent/agents/${slug}/memory`).catch(() => ({ content: '' }))).content || '';
  const evidence = []; const tools = []; const outs = []; let passed = 0;
  for (let r = 1; r <= rounds; r++) {
    const slug = `portrait-${randomUUID().slice(0, 6)}`;
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: 'Nori', systemPrompt: "You are Nori, a hands-on assistant. Reply in the user's language." }) });
    const dir = join(workspace, slug); mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'README.md'), '# 天气小工具\n\n一个查天气的命令行脚本:`node weather.js 上海`。\n');
    // 画像全引擎一份、所有 Agent 共读:每轮开头清空,上一轮写的不算这一轮的
    const soul0 = await api('/agent/human/SOUL.md');
    if (soul0.content) await api('/agent/human/SOUL.md', { method: 'PUT', body: JSON.stringify({ content: '', summary: 'Harness round reset', expectedVersion: soul0.version }) });
    const mem0 = await api(`/agent/agents/${slug}/memory`);
    await api(`/agent/agents/${slug}/memory`, { method: 'PUT', body: JSON.stringify({ content: SEED, expectedVersion: mem0.version }) });
    const cfg = { ...AGENT_CONFIG, agentSlug: slug, cwd: dir, approvalMode: 'auto-edit', thinkingLevel: 'medium' };
    const sid = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: `Human portrait ${r}`, model_id: MODEL, project_path: dir, agent_config: cfg }) })).session.id;
    const turns = []; let error = null;
    for (const [key, msg] of TURNS) {
      const ev = await run(sid, msg, 300_000, cfg);
      turns.push({ key, tools: ev.toolCalls, remembered: ev.toolArgs.filter((t) => t.name === 'remember').map((t) => String(t.arguments || '')), error: ev.error || null, reply: String(ev.content || '') });
      tools.push(`${key}${r}:${ev.toolCalls.join('/') || '-'}`);
      if (ev.error) { error = `${key}: ${ev.error}`; break; }
    }
    const soul = (await api('/agent/human/SOUL.md')).content || '';
    const agentMem = await memText(slug);
    const projectMem = ((await api(`/agent/project-context?sessionId=${sid}`).catch(() => ({}))).memory?.entries || []).map((e) => e.content).join('\n');
    let readerReply = '';
    if (!error) {
      const rid = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: `Portrait reader ${r}`, model_id: MODEL, agent_config: { ...AGENT_CONFIG, agentSlug: reader } }) })).session.id;
      const seen = await run(rid, '我叫什么？一句话回答，不调用工具。', 120_000, { ...AGENT_CONFIG, agentSlug: reader });
      readerReply = String(seen.content || ''); if (seen.error) error = `reader: ${seen.error}`;
    }
    const x = grade({ soul, agentMem, projectMem, readerReply, error });
    if (x.ok) passed++;
    const line = `${Object.entries(x.gates).map(([k, v]) => `${v ? '✓' : '✗'}${k}`).join(' ')};「改完先跑」落在 ${x.where.workflow}、「提交说明」落在 ${x.where.project}${error ? `;出错 ${error}` : ''}`;
    console.log(`  第 ${r}/${rounds} 轮(${slug}):${x.ok ? '✓' : '✗'} ${line}`);
    outs.push(`【第 ${r} 轮${x.ok ? ' ✓' : ' ✗'}】${line}\n— 画像 —\n${soul || '(空)'}\n— agent 记忆 —\n${agentMem || '(空)'}\n— 项目记忆 —\n${projectMem || '(空)'}\n— 另一个 agent 答 —\n${readerReply}`);
    evidence.push({ round: r, slug, ok: x.ok, gates: x.gates, where: x.where, error, soul, agentMem, projectMem, readerReply, turns });
    writeFileSync(join(OUT, 'humanportrait-evidence.json'), JSON.stringify({ model: MODEL, seed: SEED, turns: TURNS, rounds: evidence }, null, 2));
  }
  return { ok: passed === rounds, detail: `${passed}/${rounds} 轮全过`, output: outs.join('\n\n'), toolCalls: tools };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const good = { soul: '- 叫阿青，别叫老板。\n- 在学线性代数。', agentMem: '- 改完代码先自己跑一遍再报结果。', projectMem: '- 提交说明用英文。', readerReply: '你叫阿青。', error: null };
  assert.equal(grade(good).ok, true);
  assert.deepEqual(grade(good).where, { workflow: 'agent', project: 'project' });
  assert.equal(grade({ ...good, agentMem: '- 用户希望被称呼为「老板」。' }).ok, false); // 旧说法没被取代
  assert.equal(grade({ ...good, agentMem: '- 叫用户阿青。' }).ok, false); // 画像之外又存一份
  assert.equal(grade({ ...good, soul: `${good.soul}\n- 提交说明用英文。` }).ok, false); // 项目的事进了画像
  assert.equal(grade({ ...good, soul: '' }).ok, false); // 基线:画像为空
  assert.equal(grade({ ...good, error: 'x' }).ok, false);
  console.log('human-portrait-live self-check ok');
}
