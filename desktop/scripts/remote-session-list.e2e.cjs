/** Isolated Electron + managed engine + paired-device gateway. Never contacts the production cloud. */
const assert = require('node:assert/strict')
const { createHash, randomUUID } = require('node:crypto')
const fs = require('node:fs')
const path = require('node:path')
const { launch, boot, enterSpace } = require('./lib/uiux-electron.cjs')

const cloudUrl = 'http://127.0.0.1:9'
const token = randomUUID()
const instanceId = randomUUID()
const device = { id: randomUUID(), name: 'Fixture phone', tokenHash: createHash('sha256').update(token).digest('hex'), createdAt: Date.now() }

async function main() {
  const { app, win, projectDir, close } = await launch({
    tag: 'remote-session-list',
    beforeLaunch: async ({ userData, home, projectDir }) => {
      fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify({ cloud: { url: cloudUrl }, sandbox: 'auto' }))
      for (const dir of [userData, userData + '-dev']) {
        fs.writeFileSync(path.join(dir, 'tangu-desktop-config.json'), JSON.stringify({
          mode: 'managed', cloudUrl, defaultWorkspaceDir: projectDir,
          unitHostEnabled: true, unitInstanceId: instanceId, unitPairedDevices: [device],
        }))
      }
    },
  })
  try {
    await boot(app, win)
    assert.equal(await enterSpace(win, 'tangu'), true)
    await win.locator('.t2s-side').first().waitFor({ timeout: 6000 })
    await win.waitForFunction(async () => {
      const [engine, unit] = await Promise.all([window.tangu.backendStatus(), window.tangu.unitHostStatus()])
      return engine.state === 'ready' && Boolean(unit.webPort)
    }, null, { timeout: 30_000 })
    const { webPort } = await win.evaluate(() => window.tangu.unitHostStatus())
    const base = `http://127.0.0.1:${webPort}`
    const meta = await fetch(base + '/unit/meta').then(r => r.json())
    assert.equal(meta.instanceId, instanceId)

    const title = '手机创建的健康数据会话'
    const project = 'Tangu 默认项目'
    const request = async (method, route, body) => {
      const res = await fetch(base + '/engine' + route, {
        method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      assert.ok(res.ok, `${method} ${route}: ${res.status} ${res.ok ? '' : await res.text()}`)
      return res.json()
    }
    const previous = await request('GET', '/agent/sessions?app_id=tangu')
    assert.equal(previous.sessions.length, 0)
    const { session } = await request('POST', '/agent/sessions', {
      app_id: 'tangu', title, project_path: projectDir, project_name: project,
    })
    assert.equal(session.agent_config.remoteOrigin.via, 'lan')

    const row = win.locator(`.t2s-srow[data-sel-id="${session.id}"]`).first()
    const group = win.getByRole('button', { name: project, exact: true }).first()
    await group.waitFor({ timeout: 6000 })
    if (!(await row.isVisible())) await group.click()
    await row.waitFor({ timeout: 6000 })
    assert.match(await row.textContent(), new RegExp(title))
    console.log('PASS  Remote POST appears in the workspace without reloading the renderer')

    const renamed = '手机改名后的健康数据会话'
    await request('PATCH', `/agent/sessions/${session.id}`, { title: renamed, title_source: 'user' })
    await row.getByText(renamed, { exact: true }).waitFor({ timeout: 6000 })
    console.log('PASS  Remote PATCH updates the existing workspace row')

    await win.keyboard.press(process.platform === 'darwin' ? 'Meta+P' : 'Control+P')
    await win.locator('.amx-qf-input').fill(renamed)
    await win.locator('.amx-qf-row').filter({ hasText: renamed }).waitFor({ timeout: 6000 })
    assert.equal(await win.locator('.amx-qf-row').filter({ hasText: renamed }).count(), 1)
    console.log('PASS  Quick Find shows one result for the remote session')
  } finally {
    await close()
  }
}

main().catch(error => { console.error(error); process.exitCode = 1 })
