// A fresh background profile and a local page exercise the published tool entry points.
// Copy only the engine and skill. This fixture must never replace a desktop helper.
import { randomUUID } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';

export function installManagedFixture(bundle, shared) {
  if (!bundle || !existsSync(join(bundle, 'tangu-plugins/computer-use/dist/index.js'))) throw Error('--cu-plugin requires a built Computer Use bundle');
  const dest = join(shared, 'plugins/tangu-computer-use');
  mkdirSync(dest, { recursive: true });
  for (const entry of ['manifest.json', 'skills', 'tangu-plugins']) cpSync(join(bundle, entry), join(dest, entry), { recursive: true });
}

export async function cuManagedLive({ api, run, OUT, tokensOf, ttft }) {
  const plugin = (await api('/agent/plugins')).plugins?.find(p => /computer-use/.test(p.id));
  if (!plugin) return { ok: false, detail: 'Computer Use plugin missing from isolated engine' };
  await api(`/agent/plugins/${plugin.id}/enabled`, { method: 'PUT', body: JSON.stringify({ enabled: true }) });
  const code = randomUUID().slice(0, 8);
  const events = [];
  const page = `<!doctype html><meta charset=utf-8><title>Draft preview</title>
    <label>Draft title <input id="draft"></label><button id="preview">Preview draft</button><output id="status"></output>
    <script>preview.onclick = async e => {
      const statusField = document.querySelector('output');
      const response = await fetch('/preview', {method:'POST', body:JSON.stringify({value:draft.value, trusted:e.isTrusted})});
      statusField.textContent = await response.text();
    };</script>`;
  const server = createServer(async (req, res) => {
    if (req.method === 'POST' && req.url === '/preview') {
      let data = '';
      for await (const chunk of req) data += chunk;
      try { events.push(JSON.parse(data)); } catch { res.writeHead(400); res.end(); return; }
      res.end('Preview code ' + code);
    } else { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(page); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const url = `http://127.0.0.1:${server.address().port}/`;
    const ev = await run(`live-cumanaged-${Date.now()}`,
      `用 Computer Use 在后台打开 ${url}，把草稿标题填成 Blue Finch，点一次 Preview draft，告诉我页面显示的预览码。用网页控件操作。`, 180_000);
    const calls = ev.toolArgs.map(t => t.name);
    const allowed = new Set(['launch_browser', 'act_ui', 'observe_ui', 'inspect_ui', 'search_ui', 'wait_for', 'read_text', 'expand_ui', 'find_roots', 'load_tools', 'use_skill']);
    const ok = ev.done && !ev.error && ev.content.includes(code) && calls.includes('launch_browser') && calls.includes('act_ui')
      && calls.every(name => allowed.has(name)) && events.length === 1 && events[0].trusted === true && events[0].value === 'Blue Finch';
    writeFileSync(join(OUT, 'cumanaged-evidence.json'), JSON.stringify({ calls, toolArgs: ev.toolArgs, events, code, reply: ev.content }, null, 2));
    return { ok: Boolean(ok), detail: `工具 ${calls.join('、')}，预览 ${events.length} 次，预览码${ev.content.includes(code) ? '匹配' : '缺失'}`,
      output: ev.content, ttftMs: ttft(ev), tokens: tokensOf(ev), toolCalls: ev.toolCalls };
  } finally { server.close(); }
}
