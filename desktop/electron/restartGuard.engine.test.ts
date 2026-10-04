import { it, expect } from 'vitest'
import { createRequire } from 'node:module'
import { createTanguModule } from '../../tangu-agent/src/index'
import { createTanguProfile } from '../../tangu-agent/src/profiles/index'
import { createSqliteHost } from '../../tangu-agent/src/adapters/standalone/sqliteHost'
import { toSqliteDDL } from '../../tangu-agent/src/core/dialectDDL'
import { STANDALONE_SCHEMA } from '../../tangu-agent/src/db/schemaStandalone'
import { query } from '../../tangu-agent/src/core/db'
import { createRun, updateRunStatus } from '../../tangu-agent/src/services/runStore'
import { createDelegateTranscript } from '../../tangu-agent/src/services/delegateTranscript'
import { startBackgroundProcess, killProcess } from '../../tangu-agent/src/tools/processRegistry'
import { readRestartActivity } from './restartGuard'

it('real engine inventory includes queued, running, delegated and local background work, but rejects remote callers', async () => {
  const require = createRequire(import.meta.url)
  const express = require('../../tangu-agent/node_modules/express')
  const { host, db } = createSqliteHost({ dataDir: 'memory', localToken: 'restart-test', userId: 'u1' })
  db.exec(toSqliteDDL(STANDALONE_SCHEMA))
  const mod = createTanguModule({ host, brain: {}, billing: {}, profile: createTanguProfile({ sandboxMode: 'none' }) } as any)
  await mod.runMigration()
  const app = express(); app.use(express.json()); app.use('/', mod.userRouter); app.use('/', mod.dataRouter)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>((r) => server.once('listening', r))
  const url = `http://127.0.0.1:${server.address().port}`
  let child: ReturnType<typeof startBackgroundProcess> | undefined
  let delegate: Awaited<ReturnType<typeof createDelegateTranscript>> | undefined
  try {
    expect(await readRestartActivity(url, 'restart-test')).toEqual({ tasks: 0, processes: 0 })
    await query("INSERT INTO chat_sessions (id,user_id,app_id,title,model_id,kind) VALUES ('s','u1','tangu','Test','m','user')")
    for (const [id, status] of [['r1', 'queued'], ['r2', 'running'], ['r3', 'done']]) {
      await createRun({ id, sessionId: 's', userId: 'u1', appId: 'tangu', modelId: 'm', assistantMessageId: `a-${id}`, input: {} })
      await updateRunStatus(id, status)
    }
    delegate = await createDelegateTranscript('d1', { sessionId: 's', userId: 'u1', appId: 'tangu' } as any, 'Delegate', 'm', 'Task', {})
    child = startBackgroundProcess('s', 'sleep 30', process.cwd())
    expect(typeof child).not.toBe('string')
    expect(await readRestartActivity(url, 'restart-test')).toEqual({ tasks: 3, processes: 1 })
    const denied = await fetch(`${url}/agent/remote/restart-status`, { headers: { Authorization: 'Bearer restart-test', 'x-forsion-remote': JSON.stringify({ via: 'tunnel' }) } })
    expect(denied.status).toBe(403)
    await delegate.finish(); delegate = undefined
    if (child && typeof child !== 'string') killProcess('s', child.id)
    await updateRunStatus('r1', 'done'); await updateRunStatus('r2', 'aborted')
    expect(await readRestartActivity(url, 'restart-test')).toEqual({ tasks: 0, processes: 0 })
  } finally {
    await delegate?.finish()
    if (child && typeof child !== 'string') killProcess('s', child.id)
    server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); db.close()
  }
}, 60000)
