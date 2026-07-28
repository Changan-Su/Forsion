/**
 * Forsion Connect SDK（预览态 · local 变体）—— 由 codePreview 本地服务器在 /forsion-connect.js 提供。
 *
 * 与服务端发布态 RPC 变体（server/microserver/connect/public/forsion-connect.js）公开 API 完全一致；
 * 差别只在通道：预览态直接打本地 /__forsion/* 代理（桌面主进程持 auth.json token 转发云端），
 * 发布态经 postMessage 委托外层壳页面。改 API 面时两份都要动（契约见服务端文件头注释）。
 */
export const FORSION_CONNECT_LOCAL_SDK = `
(function () {
  'use strict';
  if (window.forsion) return;

  function jsonOrThrow(r) {
    if (r.ok) return r.json();
    return r.json().catch(function () { return {}; }).then(function (b) {
      throw new Error((b && b.detail) || ('HTTP ' + r.status));
    });
  }

  // 对话模型不在客户端解析:chat 不指名就不传,agent 一律不传,服务端按 Connect 策略现填。
  var modelCache = {};
  function listModels(type) {
    var t = type === 'image' ? 'image_gen' : (type === 'asr' ? 'asr' : 'llm');
    if (!modelCache[t]) {
      modelCache[t] = fetch('/__forsion/models?type=' + t).then(jsonOrThrow).then(function (arr) {
        return (Array.isArray(arr) ? arr : []).map(function (m) { return { id: m.id, name: m.name || m.id, type: t }; });
      });
      modelCache[t].catch(function () { modelCache[t] = null; });
    }
    return modelCache[t];
  }
  function pickImageModel(explicit) {
    if (explicit) return Promise.resolve(explicit);
    return listModels('image').then(function (ms) {
      if (ms[0]) return ms[0].id;
      throw new Error('平台未配置可用的生图模型');
    });
  }

  function getUser() {
    return fetch('/__forsion/user').then(function (r) {
      if (r.status === 401 || r.status === 403) return null;
      if (!r.ok) return null;
      return r.json().then(function (u) {
        return u ? {
          username: u.username || u.nickname || '',
          nickname: u.nickname || '',
          avatar: u.avatar || u.avatarUrl || u.avatar_url || null,
          tier: u.membershipTier || u.membership_tier || 'free'
        } : null;
      });
    }).catch(function () { return null; });
  }

  async function chat(opts) {
    opts = opts || {};
    var messages = Array.isArray(opts.messages) ? opts.messages.slice()
      : opts.prompt ? [{ role: 'user', content: String(opts.prompt) }] : null;
    if (!messages || !messages.length) throw new Error('chat 需要 messages 或 prompt');
    if (opts.system) messages.unshift({ role: 'system', content: String(opts.system) });
    // 页面没指名模型就不传:服务端按 Connect 策略现查现填默认(admin 改默认即时生效,
    // 不受本页加载时缓存的 config 影响);指名模型则原样透传,越白名单由服务端 403。
    var model = opts.model || null;
    var body = { messages: messages, stream: true };
    if (model) body.model_id = model;
    if (typeof opts.temperature === 'number') body.temperature = opts.temperature;
    if (typeof opts.maxTokens === 'number') body.max_tokens = opts.maxTokens;
    var r = await fetch('/__forsion/chat', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    });
    if (!r.ok) {
      var eb = await r.json().catch(function () { return {}; });
      throw new Error((eb && eb.detail) || ('HTTP ' + r.status));
    }
    var reader = r.body.getReader();
    var dec = new TextDecoder();
    var buf = '', text = '', sawDone = false;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      var lines = buf.split('\\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        var payload = line.slice(5).trim();
        if (payload === '[DONE]') { sawDone = true; continue; }
        try {
          var j = JSON.parse(payload);
          if (j.error) throw new Error(typeof j.error === 'string' ? j.error : (j.error.message || 'AI 错误'));
          if (j.model) model = j.model; // 服务端代填默认时,从流块里回读实际模型
          var d = j.choices && j.choices[0] && (j.choices[0].delta && j.choices[0].delta.content ||
            j.choices[0].message && j.choices[0].message.content) || '';
          if (d) { text += d; if (typeof opts.onDelta === 'function') try { opts.onDelta(d); } catch (e) {} }
        } catch (e) {
          if (e instanceof SyntaxError) continue;
          throw e;
        }
      }
    }
    // 服务端成功必发 data: [DONE];没见到 = 流被中断,判失败而非返回截断的部分结果。
    if (!sawDone) throw new Error('AI 响应中断（连接未正常结束）');
    return { text: text, model: model };
  }

  // ── Agent 通道(契约与发布态壳页 doAgent 一致):需求递给云端 worker,上下文/工具服务端托管 ──
  function genSession() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var a = new Uint8Array(16); crypto.getRandomValues(a);
    return Array.prototype.map.call(a, function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }
  async function agentRun(opts) {
    opts = opts || {};
    var input = opts.input != null ? String(opts.input) : '';
    if (!input.trim()) throw new Error('agent 需要 input');
    var session = typeof opts.session === 'string' && opts.session ? opts.session : genSession();
    // 不发 model_id:模型完全由网关按 Connect 策略决定(app_id/agent_config/model 都由代理+网关钉死)
    var r = await fetch('/__forsion/agent', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: session, message: input })
    });
    if (!r.ok) {
      var eb = await r.json().catch(function () { return {}; });
      throw new Error((eb && eb.detail) || ('HTTP ' + r.status));
    }
    var runId = (await r.json()).runId;
    var er = await fetch('/__forsion/agent-events/' + encodeURIComponent(runId));
    if (!er.ok) {
      var eb2 = await er.json().catch(function () { return {}; });
      throw new Error((eb2 && eb2.detail) || ('HTTP ' + er.status));
    }
    // 帧格式 data: {seq,type,payload}:token.delta=文本增量,done.content=权威终稿,error=失败;
    // 代理中断会补 data: {error} 帧(无 type),同样判失败。
    var reader = er.body.getReader();
    var dec = new TextDecoder();
    var buf = '', streamed = '', finalText = null, errMsg = null;
    for (;;) {
      var step = await reader.read();
      if (step.done) break;
      buf += dec.decode(step.value, { stream: true });
      var lines = buf.split('\\n');
      buf = lines.pop();
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i].trim();
        if (!line || line.indexOf('data:') !== 0) continue;
        var ev;
        try { ev = JSON.parse(line.slice(5)); } catch (e) { continue; }
        if (ev.error && !ev.type) { errMsg = String(ev.error); continue; }
        if (ev.type === 'token' && ev.payload && ev.payload.delta) {
          streamed += ev.payload.delta;
          if (typeof opts.onDelta === 'function') try { opts.onDelta(ev.payload.delta); } catch (e) {}
        } else if (ev.type === 'done') {
          // done.content 是权威终稿(哪怕为空串也照信);只有老 worker 缺字段才回退流累计
          finalText = (ev.payload && typeof ev.payload.content === 'string') ? ev.payload.content : streamed;
        } else if (ev.type === 'error') {
          errMsg = (ev.payload && (ev.payload.detail || ev.payload.error)) || 'AI agent 执行失败';
        }
      }
    }
    if (errMsg) throw new Error(errMsg);
    if (finalText == null) throw new Error('AI 响应中断（连接未正常结束）');
    return { text: finalText, session: session };
  }

  async function generateImage(opts) {
    opts = opts || {};
    if (!opts.prompt) throw new Error('generateImage 需要 prompt');
    var model = await pickImageModel(opts.model);
    var body = {
      model_id: model,
      prompt: String(opts.prompt),
      n: Math.max(1, Math.min(4, opts.n || 1)),
      response_format: opts.responseFormat === 'b64' ? 'b64_json' : 'url'
    };
    if (opts.size) body.size = String(opts.size);
    var j = await fetch('/__forsion/images', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }).then(jsonOrThrow);
    var data = (j && j.data) || [];
    return { model: model, images: data.map(function (d) { return { url: d.url || null, b64: d.b64_json || null }; }) };
  }

  window.forsion = {
    mode: 'preview',
    user: function () { return getUser(); },
    login: function () {
      return getUser().then(function (u) {
        if (u) return u;
        throw new Error('预览模式使用桌面端登录态：请在 Forsion Desktop 设置中登录 Forsion 账号');
      });
    },
    models: function (type) { return listModels(type); },
    ai: { chat: chat, agent: agentRun, generateImage: generateImage }
  };
})();
`
