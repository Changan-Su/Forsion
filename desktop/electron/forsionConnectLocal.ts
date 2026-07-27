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

  var confP = null, modelCache = {};
  function connectConfig() {
    if (!confP) confP = fetch('/__forsion/config').then(function (r) { return r.ok ? r.json() : {}; }).catch(function () { return {}; });
    return confP;
  }
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
  function pickChatModel(explicit) {
    if (explicit) return Promise.resolve(explicit);
    return connectConfig().then(function (c) {
      if (c && c.defaultModel) return c.defaultModel;
      return listModels('llm').then(function (ms) {
        if (ms[0]) return ms[0].id;
        throw new Error('平台未配置可用的对话模型');
      });
    });
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
    var model = await pickChatModel(opts.model);
    var body = { model_id: model, messages: messages, stream: true };
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
    ai: { chat: chat, generateImage: generateImage }
  };
})();
`
