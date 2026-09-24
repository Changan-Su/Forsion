/**
 * Tangu for Chrome —— 后台 service worker(MV3)。
 *
 * 只做一层薄桥:与本机 Tangu 引擎保持一条 WebSocket(127.0.0.1,连接码配对一次),执行一组固定命令。
 *  - 握手是双向的挑战-应答(HMAC-SHA256,密钥 = 连接码里的令牌,令牌本身从不上线):先验明对面真是 Tangu
 *    再干活 —— 否则本机任何抢先占了这个端口的进程都能指挥扩展操作用户已登录的浏览器。
 *  - 读页 / 快照 / 点击 / 输入 / 滚动 / 按键:chrome.scripting 注入到扩展的**隔离世界**执行 ——
 *    后台标签照样能做、不激活标签、不出「正在调试此浏览器」提示条(09-24 实测:hidden 标签点击 / 输入均生效)。
 *  - 执行任意 JS、截图:只有这两件短暂挂 chrome.debugger(页面 CSP 挡不住,但会闪一下提示条)。
 *  - Tangu 自己开的标签一律 active:false 并收进橙色「Tangu」标签组。
 * 逻辑判断(用哪个标签、要不要审批)全在引擎;扩展不做策略,升级扩展的机会就少。
 * 注入函数会被序列化后在页面里执行:不能引用本文件里的其它函数,辅助逻辑一律写在函数体内。
 */
const GROUP_TITLE = 'Tangu';
const GROUP_COLOR = 'orange';
const PING_MS = 20_000; // 有流量 MV3 worker 就不会被回收(Chrome ≥116;实测 75s 无断线)
const LOAD_TIMEOUT_MS = 30_000;
const SCRIPT_TIMEOUT_MS = 15_000; // 冻结 / 休眠的后台标签里脚本可能迟迟不跑
const HANDSHAKE_TIMEOUT_MS = 8_000; // 对面接了连接却迟迟不出挑战(抢占端口的进程)→ 断开重试
const MAX_SCREENSHOT_CHARS = 24 * 1024 * 1024; // 引擎单帧上限 32MB,留余量

let ws = null;
let connStatus = 'idle'; // idle | not-paired | connecting | connected | offline | bad-code
let retryTimer = null;
let retryDelay = 1000;

const hex = (bytes) => [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, '0')).join('');
const newNonce = () => hex(crypto.getRandomValues(new Uint8Array(16)));
async function hmacHex(token, message) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
}

async function getPairing() {
  const { pairing } = await chrome.storage.local.get('pairing');
  return pairing && pairing.port && pairing.token ? pairing : null;
}

async function setStatus(next, extra = {}) {
  connStatus = next;
  await chrome.storage.session.set({ status: next, ...extra });
  const bad = next === 'offline' || next === 'bad-code';
  await chrome.action.setBadgeText({ text: bad ? '!' : '' });
  if (bad) await chrome.action.setBadgeBackgroundColor({ color: '#d97706' });
}

async function connect() {
  clearTimeout(retryTimer);
  retryTimer = null;
  const pairing = await getPairing();
  if (!pairing) { await setStatus('not-paired'); return; }
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  await setStatus('connecting');
  let sock;
  try { sock = new WebSocket(`ws://127.0.0.1:${pairing.port}/tangu-browser`); } catch { scheduleRetry(); return; }
  ws = sock;
  sock.tangu = { token: pairing.token, nonce: newNonce(), serverVerified: false, ready: false, codeRejected: false };
  const handshakeTimer = setTimeout(() => { if (!sock.tangu.ready) sock.close(4003, 'handshake timeout'); }, HANDSHAKE_TIMEOUT_MS);
  sock.onopen = () => sock.send(JSON.stringify({ type: 'hello', nonce: sock.tangu.nonce, version: chrome.runtime.getManifest().version }));
  sock.onmessage = (e) => { void onMessage(sock, e.data); };
  sock.onerror = () => {}; // 之后必有 onclose
  sock.onclose = (e) => {
    clearTimeout(handshakeTimer);
    if (ws !== sock) return; // 换码时关掉的旧连接晚到的关闭事件:状态与重连归新连接管,别覆盖(Codex 09-24)
    ws = null;
    // 「连接码失效」只在确有其事时才显示:对面先证明了自己是 Tangu、又拒了我方(4001),或对面的证明对不上我方的码。
    // 只是状态,照样慢速重试 —— 没验明身份的对面发个 4001 / 占着不说话,不能让扩展从此不再连(Codex 09-24)。
    const rejected = (e.code === 4001 && sock.tangu.serverVerified) || sock.tangu.codeRejected;
    void setStatus(rejected ? 'bad-code' : 'offline');
    if (rejected) retryDelay = 30_000;
    scheduleRetry();
  };
}

function scheduleRetry() {
  if (retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; void connect(); }, retryDelay);
  retryDelay = Math.min(retryDelay * 2, 30_000);
}

async function onMessage(sock, data) {
  let m;
  try { m = JSON.parse(data); } catch { return; }
  const st = sock.tangu;
  if (!st.ready) {
    // 对面先证明它知道令牌(对我方随机数的 HMAC),我方再证明;验明之前收到的任何命令一律丢弃
    if (m.type === 'challenge' && !st.serverVerified) {
      if (typeof m.nonce !== 'string' || m.proof !== await hmacHex(st.token, `server:${st.nonce}`)) { st.codeRejected = true; sock.close(4002, 'server proof mismatch'); return; }
      st.serverVerified = true;
      sock.send(JSON.stringify({ type: 'auth', proof: await hmacHex(st.token, `client:${m.nonce}`) }));
      return;
    }
    if (m.type === 'welcome' && st.serverVerified) { st.ready = true; retryDelay = 1000; await setStatus('connected', { engine: m.engine || '' }); }
    return;
  }
  if (m.id == null || !m.method) return;
  let reply;
  try { reply = { id: m.id, result: await handle(m.method, m.params || {}) }; } catch (err) { reply = { id: m.id, error: String((err && err.message) || err) }; }
  if (sock.readyState === WebSocket.OPEN) sock.send(JSON.stringify(reply));
}

setInterval(() => { if (ws && ws.readyState === WebSocket.OPEN && ws.tangu.ready) ws.send(JSON.stringify({ type: 'ping' })); }, PING_MS); // 握手中途插一个 ping 会被引擎当作坏握手
chrome.alarms.create('tangu-reconnect', { periodInMinutes: 1 }); // worker 被回收后由闹钟唤醒重连
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'tangu-reconnect') void connect(); });
chrome.runtime.onStartup.addListener(() => { void connect(); });
chrome.runtime.onInstalled.addListener(() => { void connect(); });
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes.pairing) return;
  try { if (ws) ws.close(); } catch { /* ignore */ }
  ws = null;
  retryDelay = 1000;
  void connect();
});
void connect();

// ── 标签 / 标签组 ──────────────────────────────────────────────────────────────────────

async function lastNormalWindow() {
  try { return await chrome.windows.getLastFocused({ windowTypes: ['normal'] }); } catch { return null; }
}

async function addToTanguGroup(tabId, windowId) {
  try {
    const [existing] = await chrome.tabGroups.query({ windowId, title: GROUP_TITLE });
    if (existing) { await chrome.tabs.group({ tabIds: [tabId], groupId: existing.id }); return existing.id; }
    const groupId = await chrome.tabs.group({ tabIds: [tabId], createProperties: { windowId } });
    await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: GROUP_COLOR });
    return groupId;
  } catch {
    return -1; // 个别窗口不支持分组(应用窗口等):标签照样在后台,只是不进组
  }
}

async function tanguGroupIds() {
  return new Set((await chrome.tabGroups.query({ title: GROUP_TITLE })).map((g) => g.id));
}

function describeTab(t, focusedId, groups) {
  return {
    id: t.id,
    windowId: t.windowId,
    title: t.title || '',
    url: t.url || t.pendingUrl || '',
    active: !!t.active,
    focused: t.id === focusedId,
    tangu: t.groupId !== -1 && groups.has(t.groupId),
    discarded: !!t.discarded,
  };
}

/**
 * 等一次导航完成:看到 loading 之后的 complete,或网址已变且状态 complete(同文档跳转 —— 只改 # 片段、
 * 同文档后退 —— 不走 loading)。真等满超时就在结果上标 loadTimedOut,不当成功报(Codex 09-24)。
 */
function afterNavigation(tabId, trigger, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    let sawLoading = false;
    let finished = false;
    let startUrl = null;
    const end = (timedOut) => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      clearInterval(poll);
      chrome.tabs.get(tabId).then((t) => resolve(timedOut ? { ...t, loadTimedOut: true } : t), reject);
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') sawLoading = true;
      if (info.status === 'complete' && sawLoading) end(false);
    };
    const poll = setInterval(() => {
      chrome.tabs.get(tabId).then((t) => {
        if (startUrl != null && t.status === 'complete' && !t.pendingUrl && (sawLoading || t.url !== startUrl)) end(false);
      }, () => end(false));
    }, 250);
    const timer = setTimeout(() => end(true), timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId)
      .then((t) => { startUrl = t.url || ''; return trigger(); })
      .catch((e) => { if (finished) return; finished = true; chrome.tabs.onUpdated.removeListener(onUpdated); clearTimeout(timer); clearInterval(poll); reject(e); });
  });
}

/** 新开的标签:它可能在监听挂上之前就加载完了,所以挂上后立刻补查一次。 */
function untilComplete(tabId, timeoutMs = LOAD_TIMEOUT_MS) {
  return new Promise((resolve) => {
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(timer);
      chrome.tabs.get(tabId).then(resolve, () => resolve(null));
    };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') end(); };
    const timer = setTimeout(end, timeoutMs);
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete' && !t.pendingUrl) end(); }, end);
  });
}

/** 点击 / 回车之后可能跳页:短暂观察,开始加载了就等它加载完。 */
function settleAfterAction(tabId) {
  return new Promise((resolve) => {
    let loading = false;
    let finished = false;
    const end = () => {
      if (finished) return;
      finished = true;
      chrome.tabs.onUpdated.removeListener(onUpdated);
      clearTimeout(quiet);
      clearTimeout(hard);
      resolve();
    };
    const onUpdated = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading') { loading = true; clearTimeout(quiet); }
      if (info.status === 'complete' && loading) end();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    const quiet = setTimeout(() => { if (!loading) end(); }, 500); // 会跳页的点击通常百毫秒内就开始加载
    const hard = setTimeout(end, 15_000);
  });
}

function withTimeout(promise, ms, what) {
  return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(`${what} timed out after ${ms}ms`)), ms))]);
}

async function inject(tabId, func, args = []) {
  const tab = await chrome.tabs.get(tabId);
  if (tab.discarded) { // 被内存节省丢弃的标签:后台重载一次,不切到前台
    await chrome.tabs.reload(tabId);
    await untilComplete(tabId);
  }
  const [frame] = await withTimeout(chrome.scripting.executeScript({ target: { tabId }, func, args }), SCRIPT_TIMEOUT_MS, 'page script');
  const r = frame && frame.result;
  if (r && r.ok === false) throw new Error(r.error || 'page script failed');
  return r;
}

/** 动作之后带上标签此刻的网址 / 标题:模型不用再多一轮就知道跳没跳页。 */
async function withPage(tabId, r) {
  try { const t = await chrome.tabs.get(tabId); return { ...r, url: t.url || t.pendingUrl || '', title: t.title || '' }; } catch { return r; }
}

const KEYS = {
  Enter: [13, '\r'], Tab: [9], Escape: [27], Backspace: [8], Delete: [46], Space: [32, ' '],
  ArrowUp: [38], ArrowDown: [40], ArrowLeft: [37], ArrowRight: [39], PageUp: [33], PageDown: [34], Home: [36], End: [35],
};

async function pressTrusted(tabId, key) {
  const spec = KEYS[key];
  if (!spec) throw new Error(`unsupported key ${key}`);
  const [code, text] = spec;
  const base = { key: key === 'Space' ? ' ' : key, code: key === 'Space' ? 'Space' : key, windowsVirtualKeyCode: code, nativeVirtualKeyCode: code };
  return withDebugger(tabId, async (target) => {
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text, unmodifiedText: text } : {}) });
    await chrome.debugger.sendCommand(target, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    return { ok: true };
  });
}

async function withDebugger(tabId, fn) {
  const target = { tabId };
  await chrome.debugger.attach(target, '1.3');
  try { return await fn(target); } finally { try { await chrome.debugger.detach(target); } catch { /* 已断开 */ } }
}

// ── 命令 ───────────────────────────────────────────────────────────────────────────────

async function handle(method, p) {
  switch (method) {
    case 'tabs.list': {
      const win = await lastNormalWindow();
      const [front] = win ? await chrome.tabs.query({ active: true, windowId: win.id }) : [];
      const groups = await tanguGroupIds();
      const tabs = await chrome.tabs.query({});
      return { tabs: tabs.filter((t) => typeof t.id === 'number' && t.id >= 0).map((t) => describeTab(t, front && front.id, groups)) };
    }
    case 'tabs.open': {
      const win = await lastNormalWindow();
      const created = win
        ? await chrome.tabs.create({ url: p.url, active: false, windowId: win.id })
        : (await chrome.windows.create({ url: p.url, focused: false })).tabs[0];
      await addToTanguGroup(created.id, created.windowId);
      const tab = await untilComplete(created.id);
      return { ...describeTab(tab || created, -1, await tanguGroupIds()), loadTimedOut: !tab || tab.status !== 'complete' };
    }
    case 'tabs.navigate': {
      const tab = await afterNavigation(p.tabId, () => chrome.tabs.update(p.tabId, { url: p.url }));
      return { ...describeTab(tab, -1, await tanguGroupIds()), loadTimedOut: !!tab.loadTimedOut };
    }
    case 'tabs.close':
      await chrome.tabs.remove(p.tabId);
      return { ok: true };
    case 'page.read':
      return inject(p.tabId, kitSnapshot, [{ text: p.text !== false, maxText: p.maxText || 20000, max: p.maxRefs || 400 }]);
    case 'page.snapshot':
      return inject(p.tabId, kitSnapshot, [{ text: false, max: p.maxRefs || 600 }]);
    case 'page.click': {
      const r = await inject(p.tabId, kitClick, [p.ref]);
      await settleAfterAction(p.tabId);
      return withPage(p.tabId, r);
    }
    case 'page.type': {
      const r = await inject(p.tabId, kitType, [p.ref, String(p.text ?? ''), !!p.submit]);
      if (p.submit) await settleAfterAction(p.tabId);
      return withPage(p.tabId, r);
    }
    case 'page.press': {
      // 合成 KeyboardEvent 大多不产生默认行为(Backspace 不删字、Tab 不移焦点)→ 用调试接口发可信按键;
      // 挂不上(比如该标签开着 DevTools)才退回合成事件,并如实标注。
      const key = String(p.key || '');
      let r;
      try { r = await pressTrusted(p.tabId, key); } catch { r = { ...(await inject(p.tabId, kitPress, [key])), synthetic: true }; }
      await settleAfterAction(p.tabId);
      return withPage(p.tabId, r);
    }
    case 'page.scroll':
      return inject(p.tabId, kitScroll, [Number(p.dy) || 0]);
    case 'page.back': {
      const tab = await afterNavigation(p.tabId, () => chrome.tabs.goBack(p.tabId), 15_000);
      return { ok: true, url: tab.url, title: tab.title, loadTimedOut: !!tab.loadTimedOut };
    }
    case 'page.eval':
      return withDebugger(p.tabId, async (target) => {
        const r = await withTimeout(
          chrome.debugger.sendCommand(target, 'Runtime.evaluate', { expression: String(p.expression || ''), returnByValue: true, awaitPromise: true }),
          SCRIPT_TIMEOUT_MS, 'evaluate');
        if (r.exceptionDetails) return { ok: false, error: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || r.exceptionDetails.text };
        return { ok: true, result: r.result && r.result.value, type: r.result && r.result.type };
      });
    case 'page.screenshot':
      return withDebugger(p.tabId, async (target) => {
        const r = await withTimeout(
          chrome.debugger.sendCommand(target, 'Page.captureScreenshot', { format: 'png', captureBeyondViewport: !!p.full }),
          SCRIPT_TIMEOUT_MS, 'screenshot');
        if (String(r.data || '').length > MAX_SCREENSHOT_CHARS) return { ok: false, error: 'Screenshot too large — take a viewport screenshot (full_page: false) instead.' };
        return { ok: true, data: r.data };
      });
    default:
      throw new Error(`unknown method ${method}`);
  }
}

// ── 注入到页面(隔离世界)的函数:被序列化执行,只能用函数体内定义的东西 ───────────────────

/** 可交互元素 + 标题 → 「- role "name" [ref=eN]」大纲;refs 存在本页隔离世界里,点击 / 输入按 ref 找回元素。 */
function kitSnapshot(opts) {
  const kit = (globalThis.__tanguKit = { refs: new Map() });
  const clip = (s, max) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > max ? `${t.slice(0, max)}…` : t; };
  const visible = (el) => {
    try { return el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : el.getClientRects().length > 0; } catch { return true; }
  };
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const by = el.getAttribute('aria-labelledby');
    if (by) { const t = by.split(/\s+/).map((id) => (document.getElementById(id) || {}).innerText || '').join(' '); if (t.trim()) return t; }
    if (el.labels && el.labels.length) return el.labels[0].innerText;
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const type = (el.type || '').toLowerCase();
      if (['submit', 'button', 'reset'].includes(type)) return el.value;
      return el.placeholder || el.title || el.name || '';
    }
    if (tag === 'TEXTAREA' || tag === 'SELECT') return el.placeholder || el.title || el.name || '';
    const text = el.innerText;
    if (text && text.trim()) return text;
    const img = el.querySelector && el.querySelector('img[alt]');
    return (img && img.alt) || el.title || '';
  };
  const roleOf = (el) => {
    const explicit = el.getAttribute('role');
    if (explicit) return explicit;
    const tag = el.tagName;
    if (tag === 'A') return 'link';
    if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
    if (tag === 'SELECT') return 'combobox';
    if (tag === 'TEXTAREA') return 'textbox';
    if (tag === 'INPUT') {
      const type = (el.type || 'text').toLowerCase();
      if (type === 'checkbox' || type === 'radio') return type;
      if (['submit', 'button', 'reset', 'image'].includes(type)) return 'button';
      if (type === 'range') return 'slider';
      return type === 'search' ? 'searchbox' : 'textbox';
    }
    if (el.isContentEditable) return 'textbox';
    return 'button';
  };
  const HEADINGS = 'h1,h2,h3,h4,h5,h6';
  const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],'
    + '[role=tab],[role=menuitem],[role=option],[role=switch],[role=combobox],[role=textbox],[role=searchbox],[contenteditable=""],[contenteditable=true],[onclick]';
  const max = (opts && opts.max) || 400;
  const lines = [];
  let n = 0;
  let skipped = 0;
  for (const el of document.querySelectorAll(`${HEADINGS},${INTERACTIVE}`)) {
    if (!visible(el) || el.closest('[aria-hidden="true"]')) continue;
    if (el.matches(HEADINGS)) {
      const t = clip(el.innerText, 120);
      if (t) lines.push(`- heading "${t}" [level=${el.tagName[1]}]`);
      continue;
    }
    if (n >= max) { skipped++; continue; }
    const ref = `e${++n}`;
    kit.refs.set(ref, el);
    const role = roleOf(el);
    let line = `- ${role} "${clip(nameOf(el), 80)}" [ref=${ref}]`;
    if (role === 'link') { const href = el.getAttribute('href') || ''; if (href && !href.startsWith('javascript:')) line += ` url=${clip(el.href || href, 120)}`; }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      const v = el.isContentEditable ? el.innerText : el.value;
      if (v && el.type !== 'password') line += ` value="${clip(v, 60)}"`;
    }
    if ((role === 'checkbox' || role === 'radio') && el.checked) line += ' checked';
    if (el.disabled) line += ' disabled';
    lines.push(line);
  }
  if (skipped) lines.push(`- … ${skipped} more interactive elements not listed (scroll, or read the page text)`);
  const out = { ok: true, title: document.title, url: location.href, refCount: n, snapshot: lines.join('\n') || '(no interactive elements)' };
  if (opts && opts.text) out.text = ((document.body && document.body.innerText) || '').slice(0, opts.maxText || 20000);
  return out;
}

function kitClick(ref) {
  const el = globalThis.__tanguKit && globalThis.__tanguKit.refs.get(ref);
  if (!el || !el.isConnected) return { ok: false, error: `Unknown or stale ref ${ref} — take a new snapshot first` };
  el.scrollIntoView({ block: 'center', inline: 'center' });
  if (typeof el.focus === 'function') el.focus({ preventScroll: true });
  el.click();
  return { ok: true };
}

function kitType(ref, text, submit) {
  const el = globalThis.__tanguKit && globalThis.__tanguKit.refs.get(ref);
  if (!el || !el.isConnected) return { ok: false, error: `Unknown or stale ref ${ref} — take a new snapshot first` };
  el.scrollIntoView({ block: 'center' });
  el.focus();
  if (el.isContentEditable) {
    document.execCommand('selectAll', false);
    document.execCommand('insertText', false, text);
  } else if ('value' in el) {
    // 走原型上的 setter:页面框架(React 等)挂在实例上的值追踪器察觉得到变化,再补 input / change 事件
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(el, text); else el.value = text;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  } else {
    return { ok: false, error: `ref ${ref} is not a text field` };
  }
  let submitted = false;
  if (submit) {
    if (el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); submitted = true; } else {
      const init = { key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true };
      el.dispatchEvent(new KeyboardEvent('keydown', init));
      el.dispatchEvent(new KeyboardEvent('keyup', init));
    }
  }
  const value = el.isContentEditable ? el.innerText : el.value;
  return { ok: true, submitted, value: String(value || '').slice(0, 80) };
}

function kitPress(key) {
  const el = document.activeElement || document.body;
  if (key === 'Enter' && el && el.form && typeof el.form.requestSubmit === 'function') { el.form.requestSubmit(); return { ok: true, submitted: true }; }
  const codes = { Enter: 13, Tab: 9, Escape: 27, Backspace: 8, Delete: 46, Space: 32, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, PageUp: 33, PageDown: 34, Home: 36, End: 35 };
  const init = { key: key === 'Space' ? ' ' : key, code: key, keyCode: codes[key] || 0, which: codes[key] || 0, bubbles: true, cancelable: true };
  el.dispatchEvent(new KeyboardEvent('keydown', init));
  el.dispatchEvent(new KeyboardEvent('keyup', init));
  return { ok: true, submitted: false };
}

function kitScroll(dy) {
  window.scrollBy(0, dy);
  const root = document.scrollingElement || document.documentElement;
  return { ok: true, y: Math.round(window.scrollY), max: Math.max(0, Math.round(root.scrollHeight - window.innerHeight)) };
}
