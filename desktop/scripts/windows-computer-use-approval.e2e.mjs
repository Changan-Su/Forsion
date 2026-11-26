/** Real Electron approval cards with a real Windows CU helper and a local scripted model.
 * Build the desktop and Tangu engine first, then run with CU_BUNDLE set.
 * This switches focus only between this test's isolated desktop and disposable native fixture.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import http from 'node:http';
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';

const require = createRequire(import.meta.url);
const electron = require('./lib/launch-electron.cjs');
const { skipOnboarding } = require('./lib/skip-onboarding.cjs');
const { enterSpace } = require('./lib/uiux-electron.cjs');

if (process.platform !== 'win32') {
  console.log('SKIP Windows native Computer Use approval');
  process.exit(0);
}
assert(process.env.CU_BUNDLE, 'Set CU_BUNDLE to a built Computer Use checkout with its Windows helper.');
const cuDir = path.resolve(process.env.CU_BUNDLE);
const root = path.resolve(fileURLToPath(new URL('..', import.meta.url)));
const engineDir = path.resolve(root, '../tangu-agent');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'forsion-cu-windows-'));
const home = path.join(dir, 'forsion', 'tangu');
fs.mkdirSync(home, { recursive: true });
const log = (file, data) => fs.appendFileSync(path.join(dir, file), JSON.stringify(data) + '\n');
const read = (file) => {
  try {
    return fs.readFileSync(path.join(dir, file), 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
};
const snap = () => read('native.jsonl').at(-1)?.state;
const token = randomUUID();
const model = 'fixture';
let phase,
  fixture,
  engine,
  app,
  port,
  requests = 0;
let phaseData;
const childOptions = { windowsHide: true };
const fileChild = (exe, args, env, output) => {
  const fd = fs.openSync(path.join(dir, output), 'a');
  try {
    return spawn(exe, args, { ...childOptions, env, stdio: ['ignore', fd, fd] });
  } finally {
    fs.closeSync(fd);
  }
};
async function wait(label, test, ms = 18000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const value = await test();
    if (value) return value;
    await delay(100);
  }
  throw Error(label + ' timed out');
}
const textOf = (c) =>
  typeof c === 'string' ? c : Array.isArray(c) ? c.map((p) => p.text || '').join('\n') : '';
function next(body) {
  if (!body.tools?.some((t) => t.function?.name === 'find_roots') || !phaseData) return null;
  const turn = phaseData.step++;
  if (
    phase === 'stale-approval-after-new-topic' &&
    phaseData.oldAction &&
    !phaseData.sentNew &&
    body.messages.some(
      (m) =>
        m.role === 'user' &&
        textOf(m.content).includes('Separate topic. Reply with a short acknowledgement only.')
    )
  ) {
    phaseData.sentNew = true;
    return ['act_ui', phaseData.oldAction];
  }
  if (turn === 0) return ['find_roots', { pid: snap().pid, text: 'Issue26 Native Target' }];
  const outputs = body.messages.filter((m) => m.role === 'tool').map((m) => textOf(m.content));
  if (turn === 1) {
    const result = outputs.at(-1) || '';
    const root = result
      .split('\n')
      .find((line) => line.includes('Issue26 Native Target'))
      ?.match(/@r\d+/)?.[0];
    if (!root) {
      log('model.jsonl', { phase, error: 'root unavailable', result: result.slice(0, 2500) });
      return null;
    }
    return ['observe_ui', { root, mode: 'pixels' }];
  }
  if (turn === 2) {
    const result = outputs.at(-1) || '';
    const stateId = result.match(/State ([0-9a-f-]{36})\./i)?.[1];
    const size = result
      .match(/\[image\].*?(\d+)x(\d+) px/)
      ?.slice(1)
      .map(Number);
    if (!stateId || !size) {
      log('model.jsonl', {
        phase,
        error: 'state or screenshot dimensions unavailable',
        result: result.slice(0, 2500),
      });
      return null;
    }
    const { button, bounds } = snap();
    const [x, y] = button.map((value, i) => Math.round(((value - bounds[i]) * size[i]) / bounds[i + 2]));
    phaseData.oldAction = { stateId, actions: [{ action: 'click', x, y }] };
    return ['act_ui', phaseData.oldAction];
  }
  return null;
}
const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET') {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ object: 'list', data: [{ id: model, object: 'model' }] }));
      return;
    }
    let raw = '';
    for await (const c of req) raw += c;
    const body = JSON.parse(raw);
    const action = next(body);
    if (phase === 'current-approval' && !action && body.tools?.some((t) => t.function?.name === 'act_ui'))
      await delay(1500);
    const id = 'issue26-' + ++requests;
    if (action) log('model.jsonl', { phase, id, name: action[0], arguments: action[1] });
    const base = { id, created: Math.floor(Date.now() / 1000), model };
    const call = action
      ? {
          index: 0,
          id: 'call_' + id,
          type: 'function',
          function: { name: action[0], arguments: JSON.stringify(action[1]) },
        }
      : null;
    const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
    if (!body.stream) {
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          ...base,
          object: 'chat.completion',
          choices: [
            {
              index: 0,
              message: call
                ? { role: 'assistant', content: null, tool_calls: [call] }
                : { role: 'assistant', content: 'Fixture completed.' },
              finish_reason: call ? 'tool_calls' : 'stop',
            },
          ],
          usage,
        })
      );
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const chunk = (delta, reason = null, extra = {}) =>
      res.write(
        'data: ' +
          JSON.stringify({
            ...base,
            object: 'chat.completion.chunk',
            choices: [{ index: 0, delta, finish_reason: reason }],
            ...extra,
          }) +
          '\n\n'
      );
    chunk({ role: 'assistant', content: '' });
    chunk(call ? { tool_calls: [call] } : { content: 'Fixture completed.' });
    chunk({}, call ? 'tool_calls' : 'stop', { usage });
    res.end('data: [DONE]\n\n');
  } catch (e) {
    log('model.jsonl', { error: e.message });
    res.end();
  }
});
async function api(route, method = 'GET', body) {
  const res = await fetch('http://127.0.0.1:' + port + route, {
    method,
    headers: { authorization: 'Bearer ' + token, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(12000),
  });
  const text = await res.text();
  if (!res.ok) throw Error(method + ' ' + route + ' ' + res.status + ' ' + text.slice(0, 400));
  return text ? JSON.parse(text) : undefined;
}
async function sse(id, events) {
  try {
    const stream = await fetch('http://127.0.0.1:' + port + '/agent/runs/' + id + '/events', {
      headers: { authorization: 'Bearer ' + token },
      signal: AbortSignal.timeout(90000),
    });
    if (!stream.ok) throw Error('SSE ' + stream.status);
    const decoder = new TextDecoder();
    let buffer = '';
    for await (const c of stream.body) {
      buffer += decoder.decode(c, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines)
        if (line.startsWith('data:')) {
          const event = JSON.parse(line.slice(5));
          if (
            [
              'approval_request',
              'approval_resolved',
              'tool_call',
              'tool_result',
              'turn_boundary',
              'done',
              'error',
            ].includes(event.type)
          ) {
            const p = event.payload;
            const clean = {
              at: Date.now(),
              type: event.type,
              payload: {
                id: p.id,
                name: p.name,
                approvalId: p.approvalId,
                toolCallId: p.toolCallId,
                parked: p.parked,
                elapsedMs: p.elapsedMs,
                isError: p.isError,
                error: p.error,
                arguments: p.arguments,
                result: typeof p.result === 'string' ? p.result.slice(0, 4000) : undefined,
              },
            };
            events.push(clean);
            log('events.jsonl', { phase, id, ...clean });
          }
          if (['done', 'error'].includes(event.type)) return;
        }
    }
  } catch (e) {
    events.push({ type: 'stream_error', error: e.message });
  }
}

async function checkDesktop() {
  const userData = path.join(dir, 'userdata');
  fs.mkdirSync(userData + '-dev', { recursive: true });
  const url = 'http://127.0.0.1:' + port;
  fs.writeFileSync(
    path.join(userData + '-dev', 'tangu-desktop-config.json'),
    JSON.stringify({
      mode: 'external',
      backendUrl: url,
      token,
      modelId: 'fixture/fixture',
      defaultWorkspaceDir: dir,
    })
  );
  app = await electron.launch({
    args: [`--user-data-dir=${userData}`, '--lang=zh-CN', root],
    cwd: root,
    env: {
      ...process.env,
      TANGU_HOME: path.join(dir, 'desktop-profile'),
      TANGU_BACKEND_URL: url,
      TANGU_CLOUD_URL: 'http://127.0.0.1:9',
      TANGU_HARNESS_QUIET: '0',
    },
    timeout: 60000,
  });
  const win = await app.firstWindow();
  console.log('Desktop started');
  win.setDefaultTimeout(18000);
  await win.waitForSelector('#root');
  assert(await skipOnboarding(win), 'desktop onboarding');
  await win.locator('#tangu-splash').waitFor({ state: 'detached' });
  assert(await enterSpace(win, 'tangu'), 'Tangu space');
  console.log('Tangu Space is ready');
  const workspace = path.join(dir, 'workspace');
  fs.mkdirSync(workspace);
  const { session } = await api('/agent/sessions', 'POST', {
    title: 'Computer Use Windows fixture',
    model_id: 'fixture/fixture',
    app_id: 'tangu',
    project_path: workspace,
    project_name: 'Computer Use Windows fixture',
    agent_config: { execMode: 'host', approvalMode: 'auto-edit', cwd: workspace },
  });
  const mainWindow = await app.browserWindow(win);
  const mainHwnd = await mainWindow.evaluate((w) => Number(w.getNativeWindowHandle().readBigUInt64LE()));
  await mainWindow.evaluate(
    (w, id) => w.webContents.send('window:mainAction', 'open-link', 'forsion://session/' + id),
    session.id
  );
  const chat = win.locator(`[data-chat-surface="chat"][data-session-id="${session.id}"]`);
  await chat.waitFor({ state: 'visible' });
  let submitted;
  const requestsFromUi = [];
  win.on('response', async (response) => {
    if (response.request().method() !== 'POST') return;
    const route = new URL(response.url()).pathname;
    if (!route.startsWith('/agent/runs')) return;
    try {
      const body = response.request().postDataJSON();
      requestsFromUi.push({ route, body, status: response.status() });
      if (route === '/agent/runs') {
        const reply = await response.json();
        submitted = {
          id: reply.runId,
          sessionId: body.session_id,
          tray: body.approval_tray,
          execMode: body.agent_config?.execMode,
        };
      }
    } catch {}
  });
  const input = chat.locator('.t2c-ta').last();
  const primary = win.locator('.approval-card:not(.resolved) .approval-actions .btn.primary').first();
  const chatMini = () => app.windows().find((page) => !page.isClosed() && page.url().includes('window=mini'));
  const autoMiniSeen = [];
  app.on('window', (page) => {
    const record = () => {
      if (page.url().includes('transient=1')) autoMiniSeen.push(page.url());
    };
    page.on('framenavigated', record);
    record();
  });
  async function send(name) {
    phase = name;
    phaseData = { step: 0 };
    submitted = null;
    await input.fill('Issue 26 desktop ' + name);
    await input.press('Enter');
    const run = await wait('desktop POST /agent/runs', () => submitted);
    assert(
      run.id && run.sessionId === session.id && run.tray && run.execMode === 'host',
      'real desktop host approval run'
    );
    const events = [];
    const stream = sse(run.id, events);
    const pending = await wait('desktop act approval', () =>
      events.find((e) => e.type === 'approval_request' && e.payload.name === 'act_ui')
    );
    await primary.waitFor();
    return { ...run, events, stream, pending };
  }
  async function decision(run, action, approval = run.pending) {
    await wait('desktop sent correct decision', () =>
      requestsFromUi.find(
        (req) =>
          req.route === `/agent/runs/${run.id}/approvals/${approval.payload.approvalId}` &&
          req.body.action === action &&
          req.status === 200
      )
    );
  }
  async function prepareForegroundFixture() {
    const ps = `(Get-CimInstance Win32_Process -Filter "ParentProcessId = ${engine.pid} AND Name = 'windows-bridge.exe'").ProcessId`;
    const helperPid = Number(
      execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim()
    );
    assert(Number.isSafeInteger(helperPid) && helperPid > 0, 'exact disposable Windows helper PID');
    fs.writeFileSync(path.join(dir, 'command.txt'), 'cover');
    console.log('Preparing the disposable cover window for the Windows foreground positive control');
    await wait(
      'native cover foreground; activate the test cover if Windows keeps another app active',
      () => snap().front === snap().cover,
      40000
    );
    fs.writeFileSync(path.join(dir, 'command.txt'), 'grant:' + helperPid);
    await wait(
      'foreground cover consented to the specific fixture helper',
      () => snap().grantedPid === helperPid
    );
  }
  const clickAccept = () => primary.click();
  const current = await send('current-approval');
  await win.screenshot({ path: path.join(dir, 'current-approval.png') });
  await prepareForegroundFixture();
  const prior = snap();
  await clickAccept();
  await decision(current, 'approve');
  await wait('native click receipt and target frontmost', () => {
    const state = snap();
    return state.presses === prior.presses + 1 && state.front === state.hwnd && state;
  });
  await current.stream;
  await delay(500);
  const automatic = { opened: autoMiniSeen.length > 0 || !!chatMini(), returned: snap().front === mainHwnd };
  log('desktop-results.jsonl', {
    case: 'current-approval',
    run: current.id,
    session: current.sessionId,
    prior,
    after: snap(),
    automatic,
  });
  console.log('PASS current desktop approval delivered a real foreground click');
  console.log('OBSERVED automatic Mini:', automatic);

  await mainWindow.evaluate((w) => {
    w.show();
    w.focus();
  });
  await win.bringToFront();
  const stale = await send('stale-approval-after-new-topic');
  await input.fill('Separate topic. Reply with a short acknowledgement only.');
  await win.locator('button.t2c-send[aria-haspopup="menu"]').last().click({ button: 'right' });
  await win
    .locator('.t2c-send-menu')
    .getByText(/^(另起话题|Start a new topic)$/)
    .click();
  const newApproval = await wait('separate approval in the new user turn', () =>
    stale.events.find(
      (e) => e.type === 'approval_request' && e.payload.approvalId !== stale.pending.payload.approvalId
    )
  );
  assert(
    requestsFromUi.some(
      (req) =>
        req.route === `/agent/runs/${stale.id}/steer` && req.body.newTopic === true && req.status === 200
    )
  );
  await win.screenshot({ path: path.join(dir, 'stale-approval.png') });
  await prepareForegroundFixture();
  const before = snap(),
    started = Date.now();
  await clickAccept();
  await decision(stale, 'approve');
  const deferred = await wait('old tool disposition', () =>
    stale.events.find(
      (e) =>
        e.type === 'tool_result' && e.payload.id === stale.pending.payload.toolCallId && !e.payload.parked
    )
  );
  assert.match(deferred.payload.result, /The user turn has changed/);
  await delay(250);
  assert.equal(snap().presses, before.presses);
  assert.notEqual(snap().front, before.hwnd);
  assert(
    !read('native.jsonl').some((row) => row.at >= started && row.state.front === before.hwnd),
    'old approval must never focus the target'
  );
  assert(
    !stale.events.some(
      (e) => e.type === 'tool_result' && e.payload.id === newApproval.payload.toolCallId && !e.payload.parked
    )
  );
  await win.locator('.approval-card:not(.resolved) .approval-actions .btn.danger').first().click();
  await decision(stale, 'reject', newApproval);
  await stale.stream;
  log('desktop-results.jsonl', {
    case: 'stale-approval',
    run: stale.id,
    session: stale.sessionId,
    before,
    after: snap(),
    deferred,
    newApproval: newApproval.payload.approvalId,
  });
  console.log('PASS old desktop card did not focus or click. The new card needed its own decision.');

  await win.evaluate((sessionId) => window.tangu.openMini({ sessionId }), stale.sessionId);
  const mini = await wait('manual Mini appeared', chatMini);
  const miniWindow = await app.browserWindow(mini);
  const miniHwnd = await miniWindow.evaluate((w) => Number(w.getNativeWindowHandle().readBigUInt64LE()));
  console.log('Manual Mini HWND', miniHwnd);
  await miniWindow.evaluate((w) => {
    w.show();
    w.focus();
  });
  await wait('manual Mini owns native focus before returning', () => snap().front === miniHwnd, 40000);
  await mini.getByRole('button', { name: /^(在主面板显示|Show in main panel)$/i }).click();
  const surface = win.locator(`[data-chat-surface="chat"][data-session-id="${stale.sessionId}"]`);
  await surface.waitFor({ state: 'visible' });
  await wait('main Electron window owns native focus', () => snap().front === mainHwnd);
  log('desktop-results.jsonl', { case: 'manual-mini', session: stale.sessionId, returned: true });
  console.log('PASS Mini Show in main returned to its originating Chat');
}

try {
  assert(fs.existsSync(path.join(root, 'out/main/main.js')), 'Build the desktop first.');
  assert(fs.existsSync(path.join(engineDir, 'dist/standalone/main.js')), 'Build the Tangu engine first.');
  assert(
    fs.existsSync(path.join(cuDir, 'prebuilt/windows/windows-bridge.exe')),
    'Build the Windows helper first.'
  );
  console.log('ARTIFACTS', dir);
  const fixtureExe = path.join(dir, 'Issue26Fixture.exe');
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET/Framework64/v4.0.30319/csc.exe');
  execFileSync(
    compiler,
    [
      '/nologo',
      '/target:winexe',
      `/out:${fixtureExe}`,
      '/r:System.Windows.Forms.dll',
      '/r:System.Drawing.dll',
      path.join(root, 'scripts/fixtures/computer-use-foreground/windows.cs'),
    ],
    { windowsHide: true }
  );
  fixture = fileChild(fixtureExe, [dir], process.env, 'fixture.log');
  await wait('native fixture', () => snap()?.cover, 30000);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const target = http.createServer();
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  port = target.address().port;
  await new Promise((resolve) => target.close(resolve));
  const env = {
    ...process.env,
    TANGU_HOME: home,
    TANGU_DEFAULT_WORKSPACE: dir,
    TANGU_BROWSER_CDP: 'off',
    TANGU_PLUGINS_DIR: path.join(cuDir, 'tangu-plugins'),
    PI_COMPUTER_USE_WINDOWS_HELPER_PATH: path.join(dir, 'helper', 'windows-bridge.exe'),
    TANGU_PROVIDER_ID: 'fixture',
    TANGU_PROVIDER_BASE_URL: 'http://127.0.0.1:' + server.address().port + '/v1',
    TANGU_PROVIDER_API_KEY: 'fixture-local-only',
    TANGU_PROVIDER_MODELS: model,
  };
  fs.writeFileSync(
    path.join(home, '..', 'config.json'),
    JSON.stringify({
      plugins: {
        global: {
          'computer-use': { __enabled: true, headless: false, browser_use: false, cursor_overlay: false },
        },
      },
    })
  );
  engine = fileChild(
    process.execPath,
    [
      path.join(engineDir, 'dist/standalone/main.js'),
      '--port',
      String(port),
      '--host',
      '127.0.0.1',
      '--data-dir',
      path.join(home, 'state.db'),
      '--sandbox',
      'none',
      '--cloud-url',
      'http://127.0.0.1:9',
      '--token',
      token,
    ],
    env,
    'engine.log'
  );
  await wait('standalone health', () => api('/health').catch(() => null), 30000);
  await checkDesktop();
} catch (error) {
  console.error(error);
  for (const [i, page] of (app?.windows() ?? []).entries()) {
    if (!page.isClosed())
      await page.screenshot({ path: path.join(dir, `failure-${i}.png`), timeout: 3000 }).catch(() => {});
  }
  process.exitCode = 1;
} finally {
  await app?.close().catch(() => {});
  if (fixture?.exitCode === null) {
    fs.writeFileSync(path.join(dir, 'command.txt'), 'close');
    await Promise.race([once(fixture, 'exit'), delay(1500)]);
    if (fixture.exitCode === null) fixture.kill();
  }
  engine?.kill();
  server.closeAllConnections();
  server.close();
}
