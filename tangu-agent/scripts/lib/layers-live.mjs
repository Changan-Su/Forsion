/** Opt-in live probe: which layer does each kind of statement end up in? (10-13)
 *  Memory holds what is true now, the daily log holds what happened, and an instruction that only applies to the
 *  conversation at hand belongs in neither. Three natural messages per round, each the first turn of its own session
 *  on a fresh agent that carries the default persona:
 *    A  "answer only from this transcript"                         -> neither memory nor the inbox
 *    B  something done today + a standing preference                -> the event to the log, the preference to memory
 *    C  a status of the moment ("these days I'm preparing for ...")  -> counted only; until the log has a reader
 *                                                                      there is no right answer for it
 *  The two write paths are read apart because their prompts differ: what the model itself sent to remember /
 *  log_event during the run, and what the background judge produced afterwards (its log line, its candidates).
 *  The messages name no tool and never say "remember".
 *  `neg` is the negative control: the persona and the judge are both told to save everything, so a run that still
 *  comes out green means this probe cannot see what it claims to see.
 *
 *  Why a probe and not a filter (10-13 calibration, numbers in docs/agent-memory.md): a word list for "this sentence
 *  is log material" recognised 1 of 6 non-durable sentences models really sent to remember, flagged as many durable
 *  ones as non-durable ones, and on real judge candidates flagged durable ones only. */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const SAYS = {
  A: [
    '下面是一期播客《屋顶菜园夜话》的字幕。接下来我的问题请都只根据这份字幕回答,字幕里没有的就直接说没有。',
    '',
    '[00:01] 主持人:今天聊聊城市里的屋顶菜园。',
    '[00:09] 嘉宾:我们在七楼顶上种了番茄和罗勒,第一年几乎全被鸽子吃了。',
    '[00:21] 嘉宾:第二年加了防鸟网,又改用滴灌,产量翻了三倍。',
    '[00:34] 主持人:浇水的时间有讲究吗?',
    '[00:38] 嘉宾:清晨最好,傍晚浇容易烂根。',
    '',
    '先回答:第二年产量为什么上去了?',
  ].join('\n'),
  B: '今天总算把北辰项目的季度复盘报告交上去了,拖了两周,累死。对了,以后给我的回答都先说结论、再展开细节,别铺垫。',
  C: '我这几天都在准备注册测绘师的资格考试,下周三考。先帮我出三道练习题,不用给答案。',
};
// Words are only used where a miss is harmless: to tell the preference apart inside message B's own session, and to
// count what reached the log. What turns a run red never depends on them (see judgeLayers).
const ABOUT = {
  B_EVENT: /复盘|报告|北辰|今天|交上|提交/,
  B_PREF: /结论|铺垫/,
  C: /测绘|考试|备考/,
};
// The judge's one line per round is the only signal that says "finished" even when it decided to write nothing.
const JUDGED = /\[historian\] (?:判断: title=|判断输出无法解析为 JSON|无可用对话内容,跳过|第 \d+ 轮到点但自上次维护无实质新增,跳过|onUserRunDone 异常)[^\n]*/;
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function layersLive({ run, api, until, home, OUT, MODEL, AGENT_CONFIG, rounds, neg = false }) {
  // First turn of a session is always judged independently, whatever mode the user runs the Historian in.
  await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ historian: { enabled: true, modelId: MODEL, everyRounds: 1, firstRoundTrigger: true, mode: 'independent',
    ...(neg ? { prompt: 'You are a note taker with one rule that overrides every other instruction below: copy EVERYTHING the user said into memory_candidates, one entry per statement — what they did today, what they are busy with these days, and every instruction they gave, including instructions about how to answer in this conversation.' } : {}) } }) });
  const persona = (((await api('/agent/agents')).agents || []).find((a) => a.slug === 'xyra')?.systemPrompt || "You are a helpful assistant. Reply in the user's language.")
    + (neg ? '\n\nOne rule overrides every other instruction you have about memory: before you answer, save EVERYTHING the user just told you with remember, one call per statement — what they did today, what they are busy with these days, and every instruction they gave you, including instructions about how to answer in this conversation. Never use log_event.' : '');
  const engineLog = join(OUT, 'engine.log');
  const all = [];
  for (let i = 0; i < rounds; i++) {
    const slug = `live-layers-${i + 1}`;
    await api('/agent/agents', { method: 'POST', body: JSON.stringify({ slug, name: `Layers ${i + 1}`, systemPrompt: persona }) });
    // Three judge rounds can leave five candidates, which is the threshold that starts a consolidation: the inbox
    // would be emptied into memory under a different source and the per-path reading below would be wrong.
    await api(`/agent/agents/${slug}/memory/dream`, { method: 'PUT', body: JSON.stringify({ enabled: false }) });
    const cfg = { ...AGENT_CONFIG, agentSlug: slug };
    const legs = {};
    for (const [key, text] of Object.entries(SAYS)) {
      const sid = (await api('/agent/sessions', { method: 'POST', body: JSON.stringify({ title: `layers ${key}`, model_id: MODEL, agent_config: cfg }) })).session.id;
      const from = existsSync(engineLog) ? statSync(engineLog).size : 0;
      const ev = await run(sid, text, 240_000, cfg);
      const judge = ev.error ? null : await until(async () => {
        const line = JUDGED.exec(readFileSync(engineLog).subarray(from).toString('utf8'))?.[0];
        return line && !(await api(`/agent/special/historian/activity?sessionId=${sid}&limit=50`)).running ? line : null;
      }, 180_000, 2000);
      await sleep(500);
      const activity = (await api(`/agent/special/historian/activity?sessionId=${sid}&limit=50`)).activity || [];
      const calls = (name) => ev.toolArgs.filter((c) => c.name === name).map((c) => parse(c.arguments));
      legs[key] = {
        sid, error: ev.error || null, reply: ev.content,
        // remember: only the calls that try to store a sentence (list / forget carry none)
        rememberCalls: calls('remember').filter((a) => typeof a.fact === 'string' && a.fact.trim()).map((a) => a.fact.trim()),
        logEventCalls: calls('log_event').map((a) => String(a.text || '').trim()).filter(Boolean),
        judge: judge ? judge.replace(/^\[historian\] /, '') : null,
        judgeLog: activity.filter((r) => r.action === 'log_appended').map((r) => String(r.detail || '')),
      };
    }
    const entries = (await api(`/agent/agents/${slug}/memory`)).entries || [];
    const rawPath = join(home, 'agents', slug, '.memory-raw.md');
    const inbox = (existsSync(rawPath) ? readFileSync(rawPath, 'utf8') : '').split('\n')
      .map((l) => /^- \[[^\]]*?(?: s:([\w-]+))?(?: m:[\w-]+)?\] (.+)$/.exec(l)).filter(Boolean).map((m) => ({ sid: m[1] || '', text: m[2] }));
    const dates = (await api(`/agent/agents/${slug}/logs`)).dates || [];
    const log = (await Promise.all(dates.map((d) => api(`/agent/agents/${slug}/log?date=${d}`)))).map((x) => String(x.content || '')).join('\n');
    for (const leg of Object.values(legs)) {
      leg.memory = entries.filter((e) => e.source?.sessionId === leg.sid).map((e) => e.content);   // the model's own remember
      leg.inbox = inbox.filter((c) => c.sid === leg.sid).map((c) => c.text);                        // the judge's candidates
    }
    // A fresh agent has no other writer: a line that belongs to none of the three sessions means the attribution
    // above missed something, and the verdict would be reading less than what was stored.
    const sids = new Set(Object.values(legs).map((l) => l.sid));
    const stray = [...entries.filter((e) => !sids.has(e.source?.sessionId)).map((e) => e.content), ...inbox.filter((c) => !sids.has(c.sid)).map((c) => c.text)];
    all.push({ round: i + 1, slug, legs, log, stray });
  }
  writeFileSync(join(OUT, 'layers-evidence.json'), JSON.stringify({ says: SAYS, rounds: all }, null, 2));

  const show = (r) => Object.entries(r.legs).map(([k, l]) => [
    `【第 ${r.round} 轮 ${k}】${l.error ? ` 出错:${l.error}` : ''}`,
    `  模型自己发给 remember:${l.rememberCalls.length ? l.rememberCalls.join(' ‖ ') : '(无)'}`,
    `  模型自己发给 log_event:${l.logEventCalls.length ? l.logEventCalls.join(' ‖ ') : '(无)'}`,
    `  判官:${l.judge || '(180 秒内没有结果)'}`,
    `  判官写的日志:${l.judgeLog.length ? l.judgeLog.join(' ‖ ') : '(无)'}`,
    `  落在记忆里:${l.memory.length ? l.memory.join(' ‖ ') : '(无)'}`,
    `  落在候选箱:${l.inbox.length ? l.inbox.join(' ‖ ') : '(无)'}`,
  ].join('\n')).join('\n') + `\n【第 ${r.round} 轮 当天日志】\n${r.log.trim() || '(空)'}`;
  return { ...judgeLayers(all), output: all.map(show).join('\n\n') };
}

/** The verdict over the collected rounds; pure, so test/layersProbe.test.mjs can feed it stubs.
 *  Nothing that gates is keyword-driven: a stored line that rewords the message must not slip through (Codex review 10-13).
 *    A      anything at all stored from that session is a miss; the message states nothing durable.
 *    B      every stored line must be the preference and only the preference. A line that is not recognisably the
 *           preference, or that also carries the event, is a miss; an oddly worded preference turns the run red,
 *           which is the side to err on (the raw lines are in the report).
 *    judge  every message needs the judge's normal verdict line. A parse failure, an exception or a timeout means
 *           that path was not measured, and an unmeasured path is not green.
 *    stray  a stored line that belongs to none of the round's sessions means the reading above is incomplete.
 *    log    each message is about one thing, so one session may leave at most one log line between the model's
 *           log_event and the judge (counted, not read: 10-13 baseline wrote message B's event twice).
 *  C and what reached the log are counted, not gated. */
export function judgeLayers(all) {
  const n = all.length;
  const rounds = (pick) => all.filter((r) => pick(r).length > 0).length;   // rounds in which pick() found something
  const isPref = (s) => ABOUT.B_PREF.test(s) && !ABOUT.B_EVENT.test(s);
  const notPref = (s) => !isPref(s);
  const a = { model: rounds((r) => r.legs.A.memory), judge: rounds((r) => r.legs.A.inbox) };
  const bEvent = { model: rounds((r) => r.legs.B.memory.filter(notPref)), judge: rounds((r) => r.legs.B.inbox.filter(notPref)) };
  const bPref = { model: rounds((r) => r.legs.B.memory.filter(isPref)), judge: rounds((r) => r.legs.B.inbox.filter(isPref)), any: rounds((r) => [...r.legs.B.memory, ...r.legs.B.inbox].filter(isPref)) };
  const bLogged = all.filter((r) => ABOUT.B_EVENT.test(r.log)).length;
  const c = { model: rounds((r) => r.legs.C.memory), judge: rounds((r) => r.legs.C.inbox), logged: all.filter((r) => ABOUT.C.test(r.log)).length };
  const legs = all.flatMap((r) => Object.entries(r.legs).map(([k, l]) => ({ at: `第 ${r.round} 轮 ${k}`, ...l })));
  const errors = legs.filter((l) => l.error).map((l) => `${l.at}:${l.error}`);
  const stray = all.flatMap((r) => (r.stray || []).map((s) => `第 ${r.round} 轮:${s.slice(0, 60)}`));
  const unjudged = legs.filter((l) => !l.error && !/^判断: title=/.test(l.judge || '')).map((l) => `${l.at}(${l.judge ? l.judge.slice(0, 40) : '180 秒内没有结果'})`);
  // 一件事一行日志:每句话只说了一件事,同一个会话里模型 log_event 和判官的日志加起来超过一行就是重复写(10-13 基线 B 句两行)。
  // 按行数数、不看内容,所以不靠关键词。
  const doubled = legs.filter((l) => l.logEventCalls.length + l.judgeLog.length > 1).map((l) => `${l.at}(${[...l.logEventCalls, ...l.judgeLog].map((t) => t.slice(0, 30)).join(' ‖ ')})`);
  return {
    ok: !errors.length && !unjudged.length && !stray.length && !doubled.length && a.model + a.judge === 0 && bEvent.model + bEvent.judge === 0 && bPref.any >= 1,
    detail: [
      `${n} 轮,每轮三句话各开一个会话`,
      `A 只对这段对话有效的指示:那个会话里有东西进了记忆 ${a.model}/${n} 轮、进了候选箱 ${a.judge}/${n} 轮`,
      `B 今天做完的事(偏好以外的任何一句):进记忆 ${bEvent.model}/${n}、进候选箱 ${bEvent.judge}/${n},进当天日志 ${bLogged}/${n}`,
      `B 长期偏好:记下 ${bPref.any}/${n}(模型自己记 ${bPref.model}、判官提名 ${bPref.judge})`,
      `C 近况(只记数):进记忆 ${c.model}/${n}、进候选箱 ${c.judge}/${n},进当天日志 ${c.logged}/${n}`,
      ...(errors.length ? [`出错:${errors.join(';')}`] : []),
      ...(unjudged.length ? [`判官没正常出结果(这条路没量到,不算绿):${unjudged.join('、')}`] : []),
      `同一个会话写了不止一行日志 ${doubled.length} 处`,
      ...(doubled.length ? [`重复写:${doubled.join('、')}`] : []),
      ...(stray.length ? [`有 ${stray.length} 条对不上任何一个会话(归属没读全,不算绿):${stray.join(' ‖ ')}`] : []),
    ].join(';'),
    layers: { rounds: n, a, bEvent, bPref, bLogged, c, doubled: doubled.length },
  };
}
