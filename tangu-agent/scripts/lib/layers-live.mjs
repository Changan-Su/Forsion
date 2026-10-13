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
// What marks a stored line as being about each message. One fresh agent per round, so plain words are enough.
const ABOUT = {
  A: /字幕|播客|屋顶|菜园/,
  B_EVENT: /复盘|报告|北辰/,
  B_PREF: /结论/,
  C: /测绘|考试|备考/,
};
// The judge's one line per round is the only signal that says "finished" even when it decided to write nothing.
const JUDGED = /\[historian\] (?:判断: title=|判断输出无法解析为 JSON|无可用对话内容,跳过|第 \d+ 轮到点但自上次维护无实质新增,跳过|onUserRunDone 异常)[^\n]*/;
const parse = (s) => { try { return JSON.parse(s || '{}') || {}; } catch { return {}; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function layersLive({ run, api, until, home, OUT, MODEL, AGENT_CONFIG, rounds }) {
  // First turn of a session is always judged independently, whatever mode the user runs the Historian in.
  await api('/agent/special/config', { method: 'POST', body: JSON.stringify({ historian: { enabled: true, modelId: MODEL, everyRounds: 1, firstRoundTrigger: true, mode: 'independent' } }) });
  const persona = ((await api('/agent/agents')).agents || []).find((a) => a.slug === 'xyra')?.systemPrompt || "You are a helpful assistant. Reply in the user's language.";
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
    all.push({ round: i + 1, slug, legs, log, memoryCount: entries.length });
  }
  writeFileSync(join(OUT, 'layers-evidence.json'), JSON.stringify({ says: SAYS, rounds: all }, null, 2));

  const n = all.length;
  const hit = (lines, rx) => lines.filter((s) => rx.test(s));
  // rounds in which `pick(round)` found something
  const count = (pick) => all.filter((r) => pick(r).length > 0).length;
  const a = { model: count((r) => hit(r.legs.A.memory, ABOUT.A)), judge: count((r) => hit(r.legs.A.inbox, ABOUT.A)), other: count((r) => [...r.legs.A.memory, ...r.legs.A.inbox].filter((s) => !ABOUT.A.test(s))) };
  const bEvent = { model: count((r) => hit(r.legs.B.memory, ABOUT.B_EVENT)), judge: count((r) => hit(r.legs.B.inbox, ABOUT.B_EVENT)) };
  const bPref = { model: count((r) => hit(r.legs.B.memory, ABOUT.B_PREF)), judge: count((r) => hit(r.legs.B.inbox, ABOUT.B_PREF)), any: count((r) => hit([...r.legs.B.memory, ...r.legs.B.inbox], ABOUT.B_PREF)) };
  const bLogged = count((r) => (ABOUT.B_EVENT.test(r.log) ? ['x'] : []));
  const c = { model: count((r) => hit(r.legs.C.memory, ABOUT.C)), judge: count((r) => hit(r.legs.C.inbox, ABOUT.C)), logged: count((r) => (ABOUT.C.test(r.log) ? ['x'] : [])) };
  const errors = all.flatMap((r) => Object.entries(r.legs).filter(([, l]) => l.error).map(([k, l]) => `第 ${r.round} 轮 ${k}:${l.error}`));
  const unjudged = all.flatMap((r) => Object.entries(r.legs).filter(([, l]) => !l.error && !l.judge).map(([k]) => `第 ${r.round} 轮 ${k}`));
  const show = (r) => Object.entries(r.legs).map(([k, l]) => [
    `【第 ${r.round} 轮 ${k}】${l.error ? ` 出错:${l.error}` : ''}`,
    `  模型自己发给 remember:${l.rememberCalls.length ? l.rememberCalls.join(' ‖ ') : '(无)'}`,
    `  模型自己发给 log_event:${l.logEventCalls.length ? l.logEventCalls.join(' ‖ ') : '(无)'}`,
    `  判官:${l.judge || '(180 秒内没有结果)'}`,
    `  判官写的日志:${l.judgeLog.length ? l.judgeLog.join(' ‖ ') : '(无)'}`,
    `  落在记忆里:${l.memory.length ? l.memory.join(' ‖ ') : '(无)'}`,
    `  落在候选箱:${l.inbox.length ? l.inbox.join(' ‖ ') : '(无)'}`,
  ].join('\n')).join('\n') + `\n【第 ${r.round} 轮 当天日志】\n${r.log.trim() || '(空)'}`;
  return {
    // Red = a conversation-only instruction or a today's event reached memory / the inbox, or the standing preference
    // was saved in no round at all (a boundary that stops everything is not a boundary). C and the log counts are read, not gated.
    ok: !errors.length && a.model + a.judge === 0 && bEvent.model + bEvent.judge === 0 && bPref.any >= 1,
    inconclusive: unjudged.length > 0,
    detail: [
      `${n} 轮,每轮三句话各开一个会话`,
      `A 只对这段对话有效的指示:进记忆 ${a.model}/${n} 轮、进候选箱 ${a.judge}/${n} 轮${a.other ? `(另有 ${a.other} 轮记了别的,见原文)` : ''}`,
      `B 今天做完的事:进记忆 ${bEvent.model}/${n}、进候选箱 ${bEvent.judge}/${n},进当天日志 ${bLogged}/${n}`,
      `B 长期偏好:记下 ${bPref.any}/${n}(模型自己记 ${bPref.model}、判官提名 ${bPref.judge})`,
      `C 近况(只记数):进记忆 ${c.model}/${n}、进候选箱 ${c.judge}/${n},进当天日志 ${c.logged}/${n}`,
      ...(errors.length ? [`出错:${errors.join(';')}`] : []),
      ...(unjudged.length ? [`判官没出结果:${unjudged.join('、')}`] : []),
    ].join(';'),
    output: all.map(show).join('\n\n'),
    layers: { rounds: n, a, bEvent, bPref, bLogged, c },
  };
}
