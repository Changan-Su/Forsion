/**
 * 「可编剧的假引擎」:真 Electron e2e 的受控后端(scripts/*.e2e.cjs 共用)。
 *
 * 为什么需要它:聊天面的绝大多数行为是**引擎事件驱动**的(工具卡/审批/计划/用量/压缩/上下文分解),
 * 靠真引擎测就得等真模型——慢、贵、不确定。这里把 `POST /agent/runs` + SSE 换成按剧本回放:
 * 一次 run 喂一串写死的事件,于是「渲染进程收到这串事件后该长什么样」变成可断言的确定事实。
 * 桩同时**记录 UI 发来的请求**(答询问/批审批/回退等),反向断言接线(发的是不是那串 wire 约定)。
 *
 * 边界:它不证引擎自己对不对(那由 tangu-agent 的 vitest 覆盖),只证「渲染进程把事件接对了」。
 */
const http = require('http')

/**
 * 事件流写法:{ type, payload, delay? }。seq 自动递增,末尾自动补 done(除非剧本自带 done/error)。
 * 特殊事件 `{ type: '__hold' }`:**不补 done、连接不关** —— 真引擎在等审批/等询问答案时正是这个样子
 * (工具阻塞在 requestInquiry 上,run 还没结束)。补 done 会让 UI 把待答询问判成 expired,
 * 计划卡的按钮当场消失 —— 那是剧本不真实,不是产品 bug(2026-08-18 第一版就栽在这)。
 * 答案 POST 到达后,桩自动补 inquiry_result + done 收尾,与真引擎同序。
 */
function sseLines(events) {
  let seq = 0
  return events.map((e) => ({ seq: ++seq, type: e.type, payload: e.payload || {}, delay: e.delay || 0 }))
}

/**
 * 起一个桩后端。返回 { url, seen, queue, close }。
 *  - queue.push(events):给下一次 run 排一份剧本(不排=只回一条 done)
 *  - seen:UI 发来的请求记录(runs/inquiries/approvals/search/checkpoints/restore/messagesDeleted)
 *  - data:可改的静态数据(sessions/messages/models/searchHits/checkpoints)
 */
async function startStubEngine(data = {}) {
  const seen = {
    runs: [], inquiries: [], approvals: [], approvalRules: [], search: [], checkpoints: 0, restore: [], messagesDeleted: [],
  };
  const queue = [];
  const state = {
    sessions: data.sessions || [],
    messages: data.messages || [],
    models: data.models || [{ id: 'm1', name: 'Stub', provider: 'stub', contextWindow: 128_000 }],
    searchHits: data.searchHits || [],
    approvalRules: data.approvalRules || { base: 'auto-edit', allow: [], ask: ['run_bash:npm publish'], deny: [] },
    failApprovalRules: false,
    checkpoints: data.checkpoints || [],
    restoreReport: data.restoreReport || { restored: [], deleted: [], skipped: [], conflicts: [], failed: [] },
    /** 置 true 后检索端点回 500(测「失败 ≠ 无结果」)。 */
    failSearch: false,
  };
  const runs = new Map(); // runId -> events
  const open = new Map(); // runId -> 挂住的 SSE 响应(等审批/询问)

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = u.pathname;
    const json = (body, code = 200) => {
      res.writeHead(code, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const body = async () => {
      let raw = '';
      for await (const c of req) raw += c;
      try { return JSON.parse(raw || '{}'); } catch { return { __raw: raw }; }
    };

    // ── run 生命周期 ──
    if (p === '/agent/runs' && req.method === 'POST') {
      const b = await body();
      const id = `r${seen.runs.length + 1}`;
      seen.runs.push({ runId: id, message: b.message, sessionId: b.session_id, agentConfig: b.agent_config });
      runs.set(id, sseLines(queue.shift() || []));
      return json({ runId: id, assistantMessageId: `a-${id}`, userMessageId: `u-${id}` });
    }
    if (/^\/agent\/runs\/[^/]+\/events$/.test(p)) {
      const id = p.split('/')[3];
      const events = (runs.get(id) || []).filter((e) => e.type !== '__hold');
      const hold = (runs.get(id) || []).some((e) => e.type === '__hold');
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      for (const e of events) {
        if (e.delay) await new Promise((r) => setTimeout(r, e.delay));
        res.write(`data: ${JSON.stringify({ seq: e.seq, type: e.type, payload: e.payload })}\n\n`);
      }
      if (hold) { open.set(id, { res, seq: events.length }); return; } // 挂住:等答案来了再收尾
      if (!events.some((e) => e.type === 'done' || e.type === 'error')) {
        res.write(`data: ${JSON.stringify({ seq: events.length + 1, type: 'done', payload: {} })}\n\n`);
      }
      return res.end();
    }
    if (/^\/agent\/runs\/[^/]+\/inquiries\/[^/]+$/.test(p)) {
      const b = await body();
      const runId = p.split('/')[3];
      const inquiryId = p.split('/').pop();
      seen.inquiries.push({ inquiryId, answer: b.answer });
      // 与真引擎同序:兑现 → 广播 inquiry_result → run 收尾
      const o = open.get(runId);
      if (o) {
        o.res.write(`data: ${JSON.stringify({ seq: ++o.seq, type: 'inquiry_result', payload: { inquiryId, answer: b.answer } })}\n\n`);
        o.res.write(`data: ${JSON.stringify({ seq: ++o.seq, type: 'done', payload: {} })}\n\n`);
        o.res.end();
        open.delete(runId);
      }
      return json({ ok: true });
    }
    // custom 审批档规则(H2):内存里存一份,PUT 后 GET 读得回来 —— 编辑器的往返靠它
    if (p === '/agent/approval-rules') {
      // 读失败开关(同 failSearch):验「读不到时绝不渲染表单」——空表单与「从没配过」长得一样,
      // 一点保存就把 deny 名单整片清空落盘。
      if (state.failApprovalRules) return json({ detail: 'boom' }, 500);
      if (req.method === 'PUT') {
        const b = await body();
        state.approvalRules = { ...state.approvalRules, ...b };
        seen.approvalRules.push(b);
        return json({ ok: true, rules: state.approvalRules });
      }
      return json(state.approvalRules);
    }
    if (/^\/agent\/runs\/[^/]+\/approvals\/[^/]+$/.test(p)) {
      const b = await body();
      seen.approvals.push({ approvalId: p.split('/').pop(), ...b });
      return json({ ok: true });
    }

    // ── 会话面 ──
    if (p === '/agent/sessions/search') {
      seen.search.push({ q: u.searchParams.get('q'), limit: u.searchParams.get('limit') });
      if (state.failSearch) return json({ detail: 'boom' }, 500); // 供 UI 断言「失败 ≠ 无结果」
      const q = (u.searchParams.get('q') || '').toLowerCase();
      return json({ hits: q ? state.searchHits.filter((h) => JSON.stringify(h).toLowerCase().includes(q)) : [] });
    }
    if (/^\/agent\/sessions\/[^/]+\/checkpoints$/.test(p)) {
      seen.checkpoints += 1;
      return json({ checkpoints: state.checkpoints });
    }
    if (/^\/agent\/sessions\/[^/]+\/checkpoints\/restore$/.test(p)) {
      seen.restore.push(await body());
      return json(state.restoreReport);
    }
    if (/^\/agent\/sessions\/[^/]+\/messages\/delete$/.test(p)) {
      const b = await body();
      seen.messagesDeleted.push(b.ids || []);
      return json({ ok: true, deleted: (b.ids || []).length });
    }
    if (p === '/agent/sessions' && req.method === 'GET') return json({ sessions: state.sessions });
    if (p === '/agent/sessions' && req.method === 'POST') {
      const s = { ...state.sessions[0], id: `s-new-${state.sessions.length}`, title: 'New Chat' };
      state.sessions = [s, ...state.sessions];
      return json({ session: s });
    }
    if (/^\/agent\/sessions\/[^/]+\/messages$/.test(p)) return json({ messages: state.messages });
    if (/^\/agent\/sessions\/[^/]+\/config$/.test(p)) return json({ agent_config: { execMode: 'host', approvalMode: 'auto-edit' } });
    if (/^\/agent\/sessions\/[^/]+\/background$/.test(p)) return json({ background: [] });
    if (p === '/agent/models') return json({ models: state.models, defaultModelId: state.models[0]?.id });
    // 通道轮询(15s):不给这个端点的话 catch-all 缺 channels 字段,毒化 channelsStore → 侧栏崩「not iterable」
    if (p === '/agent/channels') return json({ channels: [], available: false });

    // 其余给「空但结构正确」的应答:桌面启动会摸不少端点,少一个就卡在加载态。
    return json({
      ok: true, items: [], list: [], data: [], skills: [], agents: [], tools: [], commands: [],
      engines: [], providers: [], background: [], messages: [], sessions: [], checkpoints: [], hits: [],
    });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    seen,
    state,
    /** 给下一次 run 排剧本。 */
    script: (events) => queue.push(events),
    close: () => { for (const o of open.values()) { try { o.res.end() } catch { /* ignore */ } } server.close(); },
  };
}

module.exports = { startStubEngine };
