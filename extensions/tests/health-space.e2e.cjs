/** Exercise the shipped Space in a disposable desktop plugin sandbox, using a synthetic account. */
const { strict: assert } = require('node:assert');
const { mkdtempSync, mkdirSync, cpSync, writeFileSync } = require('node:fs');
const { createServer } = require('node:net');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const desktop = resolve(process.env.HEALTH_TEST_DESKTOP || join(__dirname, '../../desktop'));
const bundle = resolve(__dirname, '../forsion-health');
const electron = require(join(desktop, 'scripts/lib/launch-electron.cjs'));

(async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'health-e2e-'));
  const socket = '/tmp/forsion-health-' + process.pid + '.sock';
  const server = createServer((s) => s.on('data', () => {}));
  await new Promise((r) => server.listen(socket, r));
  const vault = join(tmp, 'vault');
  mkdirSync(vault);
  cpSync(bundle, join(tmp, 'plugins/forsion-health'), { recursive: true });
  for (const config of ['config', 'config-dev']) {
    const dir = join(tmp, config);
    mkdirSync(dir);
    for (const f of ['amadeus-config.json', 'amadeus-config.dev.json'])
      writeFileSync(join(dir, f), JSON.stringify({ localVault: vault, lastVault: vault }));
    writeFileSync(
      join(dir, 'tangu-desktop-config.json'),
      JSON.stringify({ mode: 'external', backendUrl: 'http://127.0.0.1:1', token: 'fixture' }),
    );
    writeFileSync(join(dir, 'startup-appearance.json'), JSON.stringify({ showSplash: false }));
  }
  let app, win;
  try {
    app = await electron.launch({
      executablePath: require(require.resolve('electron', { paths: [desktop] })),
      args: [desktop, '--user-data-dir=' + join(tmp, 'config')],
      env: {
        ...process.env,
        FORSION_SANDBOX: '1',
        FORSION_SANDBOX_PLUGIN: bundle,
        FORSION_SANDBOX_SOCK: socket,
        FORSION_SANDBOX_TOKEN: 'fixture',
        FORSION_SANDBOX_INFO: JSON.stringify({
          pluginId: 'forsion-health',
          name: '健康',
          version: '0.1.0',
          root: tmp,
          vault,
          ui: { locale: 'zh', storage: {} },
        }),
        TANGU_HOME: join(tmp, 'tangu'),
        FORSION_WORKSPACE_DIR: join(tmp, 'workspace'),
        TANGU_BACKEND_URL: 'http://127.0.0.1:1',
        TANGU_HARNESS_QUIET: '1',
        PI_CU_SOCKET_PATH: join(tmp, 'unused.sock'),
      },
    });
    win = await app.firstWindow();
    await app.evaluate(({ ipcMain }) => {
      const channels = ['auth:status', 'auth:forsionLogin', 'auth:logout', 'cloud:fetch'];
      ipcMain.removeAllListeners('cloud:present');
      ipcMain.on('cloud:present', (e) => {
        e.returnValue = channels;
      });
      for (const c of channels) ipcMain.removeHandler(c);
      ipcMain.handle('auth:status', () => ({
        loggedIn: true,
        cloudUrl: 'http://127.0.0.1:1/api',
        username: 'fixture',
      }));
      let connected = false,
        agentEnabled = false;
      ipcMain.handle('cloud:fetch', (_e, req) => {
        const reply = (json) => ({ status: 200, json });
        if (
          ['/wellness/xiaomi', '/wellness/summary', '/wellness/agent-access'].includes(req.path) &&
          (req.body?.spaceKey !== 'device-fixture' || req.body?.grantId !== 'revision')
        )
          return { status: 403, json: { code: 'device_pairing_required' } };
        switch (req.path) {
          case '/wellness/status':
            return reply({
              configured: true,
              connected,
              agentEnabled,
              accountId: 'fixture',
              grantId: connected ? 'revision' : null,
            });
          case '/wellness/xiaomi/start':
            return reply({ url: 'https://account.xiaomi.com/oauth2/authorize?state=fixture' });
          case '/wellness/xiaomi/confirm':
            if (req.body.proof !== '1234567890ABCDEF') return { status: 400, json: { code: 'invalid_code' } };
            connected = true;
            return reply({ accountId: 'fixture', spaceKey: 'device-fixture', grantId: 'revision' });
          case '/wellness/agent-access':
            agentEnabled = req.body.enabled;
            return reply({});
          case '/wellness/xiaomi':
            if (req.method !== 'DELETE') throw Error('Wrong method');
            connected = false;
            return reply({});
          case '/wellness/summary': {
            const last = Date.parse(req.body.endDate + 'T12:00:00Z');
            return reply({
              days: Array.from({ length: 7 }, (_, i) => ({
                date: new Date(last - (6 - i) * 86400000).toISOString().slice(0, 10),
                steps: [null, 8042, 7161, 6894, 9103, 4310, 7283][i],
                sleepMinutes: i ? 400 + i * 9 : null,
                workouts: i % 3 ? null : 1,
                workoutSeconds: i % 3 ? null : 1800,
              })),
            });
          }
          default:
            return { status: 404, json: {} };
        }
      });
    });
    await win.reload();
    win.setDefaultTimeout(18000);
    const button = (name) => win.getByRole('button', { name, exact: true });
    await button(/^(绑定小米运动健康|Connect Mi Fitness)$/).click();
    assert.match(
      await win.locator('.fh-content a').getAttribute('href'),
      /^https:\/\/account\.xiaomi\.com\/oauth2\/authorize/,
    );
    await win.locator('.fh-content input').fill('1234567890ABCDEF');
    await button(/^(完成绑定|Finish linking)$/).click();
    await win.locator('.fh-table tbody tr').first().waitFor();
    assert.equal(await win.locator('.fh-table tbody tr').count(), 7);
    assert.match(await win.locator('.fh-table tbody tr').first().innerText(), /7,?283/);
    const toggle = win.locator('.fh-content input[type=checkbox]');
    assert.equal(await toggle.isChecked(), false);
    await toggle.check();
    await button(/^(刷新|Refresh)$/).click();
    assert.equal(await toggle.isChecked(), true);
    const date = win.locator('.fh-content input[type=date]');
    await date.fill('2025-03-30');
    await win.locator('.fh-table tbody tr').first().getByText('2025-03-30').waitFor();
    if (process.env.HEALTH_SCREENSHOT) await win.screenshot({ path: process.env.HEALTH_SCREENSHOT });
    await button(/^(解除绑定|Disconnect)$/).click();
    await win
      .locator('button:enabled')
      .filter({ hasText: /^(解除绑定|Disconnect)$/ })
      .click();
    await button(/^(绑定小米运动健康|Connect Mi Fitness)$/).waitFor();
    console.log('PASS: link, seven rows, historical dates, permission persistence, disconnect');
  } catch (e) {
    if (win)
      console.error(
        await win.evaluate(() => window.__forsionSandbox?.status()).catch(() => null),
        (
          await win
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 1200),
      );
    throw e;
  } finally {
    await app?.close();
    server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
