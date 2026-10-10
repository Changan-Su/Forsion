/** Opt-in live probe (`--only account`): can the model answer "how much do I have left" — both the Forsion account
 *  allowance (forsion_account) and this conversation's own budget (session_status) — and do account actions go
 *  through a per-call approval even in a chat session and under full access (capabilities.approval: 'always').
 *
 *  The engine's cloud URL points at the fake Forsion cloud below, so the numbers are known: the quota must come
 *  back as percentages (37% today, <1% this week), and the raw point counts must not show up in any reply.
 *  Negative controls (run them when touching this): drop `'forsion_account'` from CHAT_PRESET_DEFERRED → legs 1 / 4 go red
 *  (the chat face has no account tool); remove `!alwaysAsk` from the non-host early return in gateToolCall → leg 4 goes red
 *  (the card is spent with no approval card). */
import { createServer } from 'node:http';

const QUOTA = {
  dailyLimit: 81_337, dailyRemaining: 30_219, weeklyLimit: 406_685, weeklyRemaining: 2_033, weeklyResetAt: '2026-10-12', tier: 'pro', resetCards: 2,
  background: { sharePercent: 20, dailyLimit: 16_267, dailyRemaining: 16_267, weeklyLimit: 81_335, weeklyRemaining: 40_668, autoMain: false, modelId: 'bg-model' },
};
const RAW = [81_337, 30_219, 406_685, 2_033, 16_267, 40_668].flatMap((n) => [String(n), n.toLocaleString('en-US')]);

/** Fake Forsion cloud: only the account routes; everything else 404s. `seen` is every authenticated request. */
export async function startFakeCloud(token) {
  const seen = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      const path = String(req.url || '').split('?')[0];
      const send = (status, json) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(json)); };
      if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'unauthorized' });
      seen.push({ method: req.method, path, body });
      const key = `${req.method} ${path}`;
      if (key === 'GET /api/token-quota/my') return send(200, QUOTA);
      if (key === 'GET /api/brain/users/me') return send(200, { id: 'u-live', username: 'livetester', nickname: 'Live Tester', membershipTier: 'pro' });
      if (key === 'GET /api/membership/my') return send(200, { membership: { tier: 'pro', status: 'active', expiresAt: '2026-11-03T00:00:00.000Z', autoRenew: true, plan: { name: 'Pro' } } });
      if (key === 'GET /api/credits/balance') return send(200, { balance: 1234 });
      if (key === 'POST /api/token-quota/reset-card/use') return send(200, { success: true, resetCards: 1, quota: { ...QUOTA, dailyRemaining: QUOTA.dailyLimit, weeklyRemaining: QUOTA.weeklyLimit } });
      if (key === 'POST /api/token-quota/background/convert') return send(200, { success: true, converted: { daily: 1, weekly: 1 }, quota: QUOTA });
      return send(404, { error: 'not_found' });
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.unref();
  return { url: `http://127.0.0.1:${server.address().port}`, seen, posts: (path) => seen.filter((r) => r.method === 'POST' && r.path === path) };
}

const CHAT = { preset: 'chat', execMode: 'sandbox', cwd: undefined };
const called = (ev, name) => ev.toolCalls.includes(name) && ev.toolResults.some((r) => r.name === name && !r.isError);
const leaked = (text) => RAW.filter((n) => text.includes(n));

export async function accountLive({ run, api, sleep, cloud }) {
  const legs = [];
  const leg = (name, ok, why, ev) => { legs.push({ name, ok, why, ev }); return ok; };
  const sid = (k) => `live-account-${k}-${Date.now()}`;

  // 1. The utterance from the bug report, in a chat session: it must look something up, not say it cannot see it.
  {
    const ev = await run(sid('orig'), '我还剩多少token', 180_000, CHAT);
    const acct = called(ev, 'forsion_account'); const sess = called(ev, 'session_status');
    const grounded = (acct && /37\s*%/.test(ev.content)) || (sess && /\d[\d,.]*\s*(k|K|万|tokens?|%)/.test(ev.content));
    leg('原话「我还剩多少token」(聊天会话)', !ev.error && (acct || sess) && grounded && !leaked(ev.content).length,
      ev.error || `查了 ${[acct && '账号', sess && '本对话'].filter(Boolean).join(' + ') || '✗ 什么都没查'};${grounded ? '答的是查到的数' : '✗ 回复里没有查到的数'}${leaked(ev.content).length ? `;✗ 出现点数 ${leaked(ev.content)}` : ''}`, ev);
  }
  // 2. Account allowance: percentages only, plus cards and points.
  {
    const ev = await run(sid('quota'), '我的 Forsion 账号今天和这周的 AI 额度各还剩多少?额度重置卡有几张?积分有多少?', 180_000);
    const c = ev.content;
    const today = /37\s*%/.test(c); const week = /(<|＜|不到|不足|小于|低于|少于|less than)\s*1\s*%/i.test(c);
    const cards = /2\s*张|两张|2 cards?|:\s*2\b|：\s*2\b/.test(c); const points = /1[,，]?234/.test(c);
    leg('账号额度:只报百分比,另报重置卡与积分', !ev.error && called(ev, 'forsion_account') && today && week && cards && points && !leaked(c).length,
      ev.error || `${called(ev, 'forsion_account') ? '调了 forsion_account' : '✗ 没调 forsion_account'};今日 37% ${today ? '✓' : '✗'} 本周 <1% ${week ? '✓' : '✗'} 卡 2 张 ${cards ? '✓' : '✗'} 积分 1234 ${points ? '✓' : '✗'}${leaked(c).length ? `;✗ 出现点数 ${leaked(c)}` : ''}`, ev);
  }
  // 3. This conversation's own budget, and the HTTP interface reading the same numbers while the run is live.
  {
    const s = sid('session');
    let live = null; let stop = false;
    const poll = (async () => { while (!stop && !live) { const r = await api(`/agent/sessions/${s}/status`).catch(() => null); if (r?.active) live = r.run; else await sleep(250); } })();
    const ev = await run(s, '这段对话的上下文窗口现在用了多少、还剩多少?按现在的速度你还能跑多少步?', 180_000);
    stop = true; await poll;
    const res = ev.toolResults.find((r) => r.name === 'session_status' && !r.isError)?.full || '';
    const win = Number((res.match(/of ([\d,]+) tokens in use/) || [])[1]?.replace(/,/g, '')) || 0;
    const k = win ? String(Math.round(win / 1000)) : '';
    const cited = !!k && (ev.content.replace(/[,，]/g, '').includes(String(win)) || ev.content.includes(k));
    const after = await api(`/agent/sessions/${s}/status`).catch(() => null);
    leg('本对话的上下文 / 步数:工具答得出,接口同一份数', !ev.error && !!res && cited && !!live && live.context?.window === win && after?.active === false,
      ev.error || `${res ? `session_status 给出窗口 ${win}` : '✗ 没调 session_status'};回复${cited ? '引用了窗口大小' : '✗ 没引用窗口大小'};接口 run 中 ${live ? `active(window ${live.context?.window},step ${live.iteration})` : '✗ 没读到'}、结束后 ${after?.active === false ? 'inactive' : `✗ ${JSON.stringify(after)?.slice(0, 80)}`}`, ev);
  }
  // 4. Spending a reset card from a chat session under full access: one approval card (reason 'always'), then exactly one POST.
  {
    const path = '/api/token-quota/reset-card/use';
    const before = cloud.posts(path).length;
    let sentBeforeAnswer = null;
    const ev = await run(sid('card'), '帮我用一张额度重置卡,把 AI 额度恢复满。', 180_000, { ...CHAT, approvalMode: 'full-auto' }, undefined,
      () => { sentBeforeAnswer = cloud.posts(path).length - before; return 'approve'; });
    const ask = ev.approvalList.find((a) => a.name === 'forsion_account_action');
    const sent = cloud.posts(path).length - before;
    leg('用重置卡(聊天会话 + 完全通行):照样弹卡,批准后只发一次', !ev.error && !!ask && ask.reason === 'always' && sentBeforeAnswer === 0 && sent === 1,
      ev.error || `${ask ? `弹卡(原因 ${ask.reason})` : '✗ 没弹卡'};批准前已发 ${sentBeforeAnswer ?? '-'} 次;共发 ${sent} 次`, ev);
  }
  // 5. Rejected on the card → nothing is sent, and the reply does not claim it was done.
  {
    const path = '/api/token-quota/background/convert';
    const before = cloud.posts(path).length;
    const ev = await run(sid('move'), '把我 30% 的 AI 额度挪到后台额度。', 180_000, { approvalMode: 'full-auto' }, undefined, () => 'reject');
    const ask = ev.approvalList.find((a) => a.name === 'forsion_account_action');
    const sent = cloud.posts(path).length - before;
    const claimed = /(已经?|成功)(帮你|为你)?(挪|转|移)/.test(ev.content) && !/没有|未|没能|拒绝|取消|未能/.test(ev.content);
    leg('挪额度被用户拒绝:不发请求,不谎称做了', !ev.error && !!ask && ask.reason === 'always' && sent === 0 && !claimed,
      ev.error || `${ask ? `弹卡(原因 ${ask.reason})` : '✗ 没弹卡'};发了 ${sent} 次${claimed ? ';✗ 回复声称已挪' : ''}`, ev);
  }

  const bad = legs.filter((l) => !l.ok);
  return {
    ok: !bad.length,
    detail: legs.map((l, i) => `${i + 1}${l.ok ? '✓' : '✗'} ${l.name}:${l.why}`).join(' ‖ '),
    output: legs.map((l, i) => `【${i + 1} ${l.name}】\n${l.ev.content}`).join('\n\n'),
    toolCalls: legs.flatMap((l) => l.ev.toolCalls),
    tokens: legs.reduce((a, l) => a + (l.ev.usages?.reduce((x, u) => x + (Number(u.prompt) || 0) + (Number(u.completion) || 0), 0) || 0), 0) || null,
    accountLegs: legs.map((l) => ({ name: l.name, ok: l.ok, why: l.why, tools: l.ev.toolCalls, approvals: l.ev.approvalList })),
    cloudRequests: cloud.seen.map((r) => `${r.method} ${r.path}`),
  };
}
