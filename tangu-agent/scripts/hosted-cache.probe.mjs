#!/usr/bin/env node
/**
 * 托管面(/api/brain/llm/build-and-stream)前缀缓存探针:同一个上游,带不带 prompt_cache_key 各跑一条
 * 只在尾部追加的会话,看后续轮的 cached 是不是「紧挨着的上一轮」。回答「这个上游认不认会话粘性」。
 *
 *   node scripts/hosted-cache.probe.mjs --model <模型 id> [--rounds 10] [--arms off,on] [--thinking low]
 *   node scripts/hosted-cache.probe.mjs --model <模型 id> --auth ~/.forsion/auth.json --allow-production-auth
 *
 * 两臂只差一位:发给服务端的模型记录里 promptCachingEnabled 是 false 还是 true —— 服务端据此决定
 * 发不发 prompt_cache_key(server llmService.buildProviderPayload),所以**不用改后台的模型配置**。
 * 每臂各用一个随机会话 id 和一段带随机数开头的系统提示,两臂互不串缓存;两臂交替发,时段影响对等。
 * 判读:adjacent = 命中了上一轮写下的前缀;older = 只命中更早某一轮的;hit = 命中了但对不上具体哪一轮;miss = cached 0。
 * 带键那臂全是 adjacent 而不带键那臂零散 → 上游认这个键,把后台该模型的「请求侧缓存提示」打开即可。
 * 两臂都零散 → 上游不认,Forsion 这边无解。凭证只读、不打印;每发约 3k–8k prompt token,真实计费。
 *
 * 10-07 实测(本机 dev 服务端 2.3.36 → api.gpt.ge,Responses 协议):
 *   gpt-5-mini 各 9 轮后续(那次每轮只涨约 107 token):不带键 命中上一轮 4 / 命中但不是上一轮或分不清 2 / miss 3;
 *   带键 3 / 4 / 2。
 *   gpt-5.5 各 11 轮后续(上游计数粒度 1024,只能分命中与否):不带键 miss 4;带键 miss 2。
 * 带键没有让命中稳定落到上一轮,中转站也没有因为多了这个字段报 400 —— 它不按 prompt_cache_key 粘会话。
 * 起因是会话 96ecce8c 的 GPT 6.1 SOL(同一个中转站)后续 19 轮只命中 7 次;SOL 和 GPT 6 Luna 在 dev 服务端上没有行,没测到。
 */
import { readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

const argv = process.argv.slice(2);
const opt = (name, def) => { const i = argv.indexOf(`--${name}`); return i >= 0 && argv[i + 1] !== undefined ? argv[i + 1] : def; };
const AUTH = opt('auth', join(homedir(), '.forsion-dev', 'auth.json')).replace(/^~(?=\/)/, homedir());
const MODEL = opt('model', '');
const ROUNDS = Number(opt('rounds', 10));
const THINKING = opt('thinking', 'low'); // 'off' 会被部分模型拒(gpt-5-mini 不收 effort=none)
const ARMS = opt('arms', 'off,on').split(',').filter((a) => a === 'off' || a === 'on');
if (!MODEL || !ARMS.length || !(ROUNDS >= 2)) { console.error('用法:--model <模型 id> [--rounds 10] [--arms off,on] [--thinking low] [--auth <auth.json>]'); process.exit(2); }
const real = (p) => { try { return realpathSync(p); } catch { return p; } };
if (real(AUTH).startsWith(real(join(homedir(), '.forsion')) + '/') && !argv.includes('--allow-production-auth')) {
  console.error(`--auth 指向生产登录 ${AUTH};要用它请显式加 --allow-production-auth`); process.exit(2);
}
// JSON.parse 的原生报错会把出错那一行(含 token)打到 stderr,所以这里吞掉原错误只报文件名。
const { cloudUrl, token } = (() => { try { return JSON.parse(readFileSync(AUTH, 'utf8')); } catch { console.error(`${AUTH} 读不出来或不是合法 JSON`); process.exit(2); } })();
if (!cloudUrl || !token) { console.error(`${AUTH} 里没有 cloudUrl / token`); process.exit(2); }
const BASE = String(cloudUrl).replace(/\/+$/, '');
const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

const resolved = await fetch(`${BASE}/api/brain/llm/resolve`, { method: 'POST', headers, body: JSON.stringify({ modelId: MODEL }) });
if (!resolved.ok) { console.error(`resolve 失败:HTTP ${resolved.status} ${(await resolved.text()).slice(0, 200)}`); process.exit(1); }
const { model, apiModelId } = await resolved.json();
const host = (() => { try { return new URL(model.defaultBaseUrl).hostname; } catch { return '?'; } })();
console.log(`服务端 ${BASE} ｜ 模型 ${model.name}(${apiModelId})｜ 上游 ${host} ｜ 后台开关现值 promptCachingEnabled=${!!model.promptCachingEnabled}`);
if (/anthropic|claude|gemini/i.test(String(model.provider))) {
  console.error(`provider=${model.provider}:这类行不发 prompt_cache_key(Claude 的开关改的是 cache_control 断点),两臂不可比,不测`); process.exit(2);
}

// ~3k token 的稳定系统提示,远大于 1024 的起缓存门槛和 128 的计数粒度。
const rules = Array.from({ length: 70 }, (_, i) =>
  `Rule ${i + 1}: When handling task category ${i + 1}, prefer deterministic, well-documented steps; record the outcome, verify assumptions against primary sources, and keep the user informed briefly.`).join('\n');
const filler = 'Context note: the previous step finished without errors, the workspace is unchanged, and no further files were touched since the last check. ';
const arms = ARMS.map((name) => ({
  name, sessionId: randomUUID(), rows: [],
  messages: [{ role: 'system', content: `Probe session ${randomUUID()}. You are a terse assistant.\n${rules}` }],
}));

async function call(arm, round) {
  arm.messages.push({ role: 'user', content: `${filler.repeat(14)}Step ${round}: reply with exactly "ok ${round}" and nothing else.` });
  const started = Date.now();
  const res = await fetch(`${BASE}/api/brain/llm/build-and-stream`, {
    method: 'POST', headers, signal: AbortSignal.timeout(180_000),
    body: JSON.stringify({
      modelId: MODEL, apiModelId, model: { ...model, promptCachingEnabled: arm.name === 'on' },
      messages: arm.messages, usageSource: 'cache-probe', temperature: 0.7, maxTokens: 2000,
      attachments: [], thinkingLevel: THINKING, stream: true, cacheKey: arm.sessionId,
    }),
  });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  // 读到 done 帧就收手:它之后连接怎么断都不该把这一轮已完成的结果丢掉。
  let buf = '', done = null;
  const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
  try {
    while (!done) {
      const { value, done: eof } = await reader.read();
      if (eof) break;
      buf += value;
      for (let i; !done && (i = buf.indexOf('\n\n')) >= 0; buf = buf.slice(i + 2)) {
        const line = buf.slice(0, i).split('\n').find((l) => l.startsWith('data: '));
        if (!line) continue;
        const ev = JSON.parse(line.slice(6));
        if (ev.t === 'error') throw new Error(`服务端回了 error 帧 ${ev.status ?? ''} ${ev.message ?? ''}`);
        if (ev.t === 'done') done = ev;
      }
    }
  } finally { reader.cancel().catch(() => {}); }
  if (!done) throw new Error('流结束但没有 done 帧');
  arm.messages.push({ role: 'assistant', content: done.content || `ok ${round}` });
  const u = done.usage || {};
  arm.rows.push({ round, prompt: u.prompt_tokens || 0, cached: u.cached_tokens || 0, reported: u.cacheReported === true, ms: Date.now() - started });
}

for (let round = 1; round <= ROUNDS && arms.some((a) => !a.failed); round++) {
  for (const arm of arms) {
    if (arm.failed) continue; // 失败的那臂前缀已经断了,不再续发;另一臂照常跑完
    try { await call(arm, round); } catch (e) { console.error(`[${arm.name}] 第 ${round} 轮失败:${e.message}`); arm.failed = true; }
  }
}

// 归因只认「对得上具体某一轮」的:上游按 128 细报时,命中第 j 轮写下的前缀 = cached 等于第 j 轮 prompt 的
// 128 取整(容一个块的尾差)。恰好对上一轮 → adjacent / older;对不上或同时对上两轮 → 只报 hit,不硬判。
// 上游没报 cached 的轮记 unknown,不进命中率。
// ponytail: 「上游是不是按 128 细报」靠全部非零 cached 之间有没有非 1024 倍数的差来认(这个中转站上 gpt-5.5
// 是 1024 一档,那种上游的 cached 停着不动既可能是粒度粗也可能是落到了旧缓存,分不开)。认不出细粒度(含样本
// 太少)就整场只报 hit / miss。上限:真 128 粒度但几次命中恰好相差 1024 的倍数时会少报归因,不会报错归因。
const f128 = (x) => Math.floor(x / 128) * 128;
function classify(rows, fine) {
  return rows.map((r, i) => {
    if (i === 0) return 'first';
    if (!r.reported) return 'unknown';
    if (!r.cached) return 'miss';
    if (!fine) return 'hit';
    const src = rows.slice(0, i).flatMap((e, j) => ([0, 128].includes(f128(e.prompt) - r.cached) ? [j] : []));
    return src.length !== 1 ? 'hit' : src[0] === i - 1 ? 'adjacent' : 'older';
  });
}
const isFine = (allRows) => { const v = allRows.map((r) => r.cached).filter(Boolean); return v.some((x) => (x - v[0]) % 1024 !== 0); };
const FINE = isFine(arms.flatMap((arm) => arm.rows));
if (!FINE) console.log('\n⚠️ 认不出这个上游按 128 细报 cached(粒度更粗或样本太少),下面只分命中 / 未命中,不做归因');
for (const arm of arms) {
  console.log(`\n== ${arm.name === 'on' ? '带 prompt_cache_key' : '不带 prompt_cache_key'}(会话 ${arm.sessionId.slice(0, 8)})`);
  if (arm.rows.length < 2) { console.log('  成功的请求不足两轮,没有可判的后续轮'); continue; }
  const verdicts = classify(arm.rows, FINE);
  const tally = { adjacent: 0, older: 0, hit: 0, miss: 0, unknown: 0 };
  arm.rows.forEach((r, i) => {
    if (i > 0) tally[verdicts[i]]++;
    console.log(`  轮 ${String(r.round).padStart(2)}  prompt ${String(r.prompt).padStart(6)}  cached ${String(r.reported ? r.cached : '-').padStart(6)}  ${verdicts[i]}  ${(r.ms / 1000).toFixed(1)}s`);
  });
  const known = arm.rows.filter((r, i) => i > 0 && r.reported);
  const pct = known.length ? Math.round(100 * known.reduce((s, r) => s + r.cached, 0) / known.reduce((s, r) => s + r.prompt, 0)) : 0;
  console.log(`  后续 ${arm.rows.length - 1} 轮:adjacent ${tally.adjacent} / older ${tally.older} / hit(对不上具体哪一轮)${tally.hit} / miss ${tally.miss}`
    + `${tally.unknown ? ` / 上游没报 ${tally.unknown}` : ''} ｜ 按 token 命中 ${pct}%${tally.unknown ? '(只算报了的轮)' : ''}`);
}
