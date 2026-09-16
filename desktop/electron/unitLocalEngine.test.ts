import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { createLocalEngine, type LocalEngine } from '../../unit/localEngine'

let root: string
let entry: string
const engines: LocalEngine[] = []
let mock: Server
let modelBase: string
const requests: any[] = []

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'unit-local-engine-test-'))
  // Build outside the source tree, so dependencies cannot be accidentally
  // satisfied by ancestor node_modules and no Forsion Server is involved.
  const { buildLocalEngine } = await import('../../unit/build-local-engine.mjs')
  entry = (await buildLocalEngine({ output: join(root, 'engine') })).entryFile
  mock = createServer(async (req, res) => {
    if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end(); return }
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    requests.push(JSON.parse(Buffer.concat(chunks).toString()))
    res.writeHead(200, { 'Content-Type': 'text/event-stream' })
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'UNIT-LOCAL-REPLY' } }] })}\n\n`)
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 3 } })}\n\n`)
    res.end('data: [DONE]\n\n')
  })
  await new Promise<void>((done) => mock.listen(0, '127.0.0.1', done))
  modelBase = `http://127.0.0.1:${(mock.address() as any).port}/v1`
}, 120_000)

afterAll(async () => {
  await Promise.all(engines.map((engine) => engine.stop()))
  if (mock) await new Promise<void>((done) => mock.close(() => done()))
  await rm(root, { recursive: true, force: true })
})

function engine(name: string, initialConfig: Record<string, unknown> = {}, log?: (message: string) => void) {
  const instance = createLocalEngine({ dataDir: join(root, name), entryFile: entry, initialConfig: { sandbox: 'none', ...initialConfig }, log })
  engines.push(instance)
  return instance
}

async function api(instance: LocalEngine, path: string, body?: unknown) {
  const { url, token } = instance.endpoint()
  const response = await fetch(`${url}${path}`, { method: body ? 'POST' : 'GET', headers: {
    Authorization: `Bearer ${token}`, 'Content-Type': 'application/json',
  }, ...(body ? { body: JSON.stringify(body) } : {}) })
  if (!response.ok) throw new Error(`${path} ${response.status}: ${await response.text()}`)
  return response.json()
}

describe('standalone Unit local Tangu capability', () => {
  it('reports a missing executable without leaving a startup or shutdown promise pending', async () => {
    const instance = createLocalEngine({ dataDir: join(root, 'missing-executable'), entryFile: entry, nodePath: join(root, 'missing-node') })
    engines.push(instance)
    await expect(instance.start([])).rejects.toThrow('ENOENT')
    expect(instance.status().state).toBe('crashed')
    await instance.stop()
    expect(instance.status().state).toBe('stopped')
  }, 5000)

  it('starts without Server, account or providers and persists locally across restart', async () => {
    const logs: string[] = []
    const instance = engine('without-server', {}, (message) => logs.push(message))
    await instance.start([])
    expect(instance.status().state).toBe('ready')
    expect((await fetch(`${instance.endpoint().url}/agent/agents`)).status).toBe(401)
    await api(instance, '/agent/memory', { text: 'Unit local persistence fixture' })
    const notification = await api(instance, '/agent/inbox', { title: 'Local notification fixture', body: 'Available without cloud broadcasts.' })
    expect(await api(instance, '/agent/inbox/pull', {})).toMatchObject({ pulled: false, added: 0 })
    // The cloud poller's first kick is 15s after start. Local Inbox remains useful
    // while an unconfigured cloud connection must stay completely idle.
    await new Promise((done) => setTimeout(done, 16_000))
    expect(logs.join('\n')).not.toMatch(/\[inbox\] pull failed|Failed to parse URL/)
    const originalToken = instance.endpoint().token
    await instance.stop()
    expect(instance.endpoint()).toEqual({ url: null, token: '' })
    await instance.start([])
    expect(instance.endpoint().token).not.toBe(originalToken)
    expect((await api(instance, '/agent/memory')).content).toContain('Unit local persistence fixture')
    expect((await api(instance, '/agent/inbox')).messages.some((message: any) => message.id === notification.id)).toBe(true)
    expect(JSON.parse(await readFile(instance.configFile, 'utf8')).cloud).toBeUndefined()
  }, 30_000)

  it('seeds bundled agents and skills, executes using a direct model, and unloads bundle routes', async () => {
    const bundle = join(root, 'bluebird-package')
    await mkdir(join(bundle, 'agents/bluebird/skills/collection'), { recursive: true })
    await mkdir(join(bundle, 'skills/collection'), { recursive: true })
    await mkdir(join(bundle, 'tangu-plugins/collection-runtime'), { recursive: true })
    await writeFile(join(bundle, 'manifest.json'), JSON.stringify({ id: 'bluebird', version: '1.0.0' }))
    await writeFile(join(bundle, 'agents/bluebird/config.toml'), 'name = "Bluebird fixture"\ndeveloper_instructions = "BUNDLE-PERSONA-MARKER"\napproval_mode = "full-auto"\n')
    await writeFile(join(bundle, 'agents/bluebird/skills/collection/SKILL.md'), '---\nname: Collection fixture\ndescription: Local collection skill\n---\nBUNDLE-SKILL-MARKER\n')
    await writeFile(join(bundle, 'skills/collection/SKILL.md'), '---\nname: Collection fixture\ndescription: Local collection skill\n---\nBUNDLE-SKILL-MARKER\n')
    await writeFile(join(bundle, 'tangu-plugins/collection-runtime/tangu-plugin.json'), JSON.stringify({ id: 'collection-runtime', name: 'Collection fixture', version: '1.0.0', apiVersion: 1, entry: 'index.mjs' }))
    await writeFile(join(bundle, 'tangu-plugins/collection-runtime/index.mjs'), 'export default { activate(ctx) { ctx.registerRoutes(({ dataRouter }) => dataRouter.get("/agent/collection-fixture", (_req, res) => res.json({ ok: true }))); } }')
    const instance = engine('with-bundle', { providers: [{ providerId: 'fixture', baseUrl: modelBase, modelIds: ['local-model'] }] })
    await instance.start([bundle])
    expect((await api(instance, '/agent/agents')).agents.some((agent: any) => agent.slug === 'bluebird')).toBe(true)
    expect(await readFile(join(root, 'with-bundle/tangu/agents/bluebird/skills/collection/SKILL.md'), 'utf8')).toContain('BUNDLE-SKILL-MARKER')
    expect(await api(instance, '/agent/collection-fixture')).toEqual({ ok: true })
    await api(instance, '/agent/runs', { session_id: 'unit-local-bluebird', model_id: 'fixture/local-model', message: 'Summarize this supplied transcript.', agent_config: { agentSlug: 'bluebird', execMode: 'host' } })
    await expect.poll(async () => JSON.stringify(await api(instance, '/agent/sessions/unit-local-bluebird/messages')), { timeout: 15_000 }).toContain('UNIT-LOCAL-REPLY')
    expect(JSON.stringify(requests)).toContain('BUNDLE-PERSONA-MARKER')
    await instance.setPackages([])
    const response = await fetch(`${instance.endpoint().url}/agent/collection-fixture`, { headers: { Authorization: `Bearer ${instance.endpoint().token}` } })
    expect(response.status).toBe(404)
    expect((await api(instance, '/agent/agents')).agents.some((agent: any) => agent.slug === 'bluebird')).toBe(true)
    expect(JSON.stringify(await api(instance, '/agent/sessions/unit-local-bluebird/messages'))).toContain('UNIT-LOCAL-REPLY')
  }, 40_000)
})
