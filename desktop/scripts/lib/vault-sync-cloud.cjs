/**
 * Local fake cloud for vault-sync rigs (never talks to a real server or account).
 *
 * One in-memory Amadeus vault feeds the legacy online engine (Forsion Extend core/amadeus: whole-vault mirror + entry sync):
 * /api/amadeus/vaults, /tree, /file, /asset, /binary, /changes, /events (SSE). Shapes follow server/microserver/amadeus/routes.ts.
 *
 * The new content sync (Extend contentSync) gets its own store under /api/remotesync/content/<ns>: manifest, create node,
 * CAS content upload / download, move, delete, plus the account device table. ⚠️ Unlike the real server, the default namespace
 * does NOT project the Amadeus vault into `Amadeus/<path>`: the two stores are disjoint, so a first new-sync round only uploads
 * this machine's files and never rewrites the legacy vault. Rigs that need the projection must model it themselves.
 *
 * Everything else (account, quota, membership, notices) is forwarded to scripts/lib/fake-forsion-cloud.cjs.
 *
 * Every request is logged in `requests` with every file name it touched (`names`: query path / ref, JSON body path,
 * multipart path, content node names), so a rig can assert "no request ever touched X" across all three APIs.
 */
const http = require('http')
const crypto = require('crypto')
const path = require('path')

const MB = 1024 * 1024
const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex')
const kindOf = (p) => (/\.md$/i.test(p) ? 'page' : /\.db$/i.test(p) ? 'db' : 'binary')
const isText = (k) => k === 'page' || k === 'db'

/**
 * opts.vaultFiles: { [path]: string | Buffer }  the cloud default vault
 * opts.devices:    [[id, name]]                  new-sync account device table
 * opts.desktop:    Genesis desktop dir (fake-forsion-cloud.cjs is the account fallback)
 */
async function startVaultSyncCloud(opts = {}) {
  const now = Date.now()
  const vaultId = opts.vaultId || 'v-main'
  const files = new Map()
  let vaultSeq = 0
  const changes = []
  const sse = new Set()
  const put = (p, data, at) => {
    const kind = kindOf(p)
    const prev = files.get(p)
    const content = isText(kind) ? (Buffer.isBuffer(data) ? data.toString('utf8') : String(data)) : null
    const bytes = isText(kind) ? Buffer.from(content, 'utf8') : (Buffer.isBuffer(data) ? data : Buffer.from(String(data)))
    const f = { path: p, kind, content, bytes, hash: isText(kind) ? sha256(content) : sha256(bytes), size: bytes.length, seq: (prev?.seq ?? 0) + 1, updatedAt: at ?? now }
    files.set(p, f)
    return f
  }
  let i = 0
  for (const [p, data] of Object.entries(opts.vaultFiles || {})) put(p, data, now - (3 + i++) * 3600_000)
  vaultSeq = files.size
  const change = (op, p) => {
    vaultSeq++
    const ev = { seq: vaultSeq, type: kindOf(p), op, path: p, newPath: null, fileSeq: files.get(p)?.seq ?? null, origin: { client: null, actor: 'user' } }
    changes.push(ev)
    for (const res of sse) res.write(`event: change\ndata: ${JSON.stringify(ev)}\n\n`)
  }
  const folderList = () => { const s = new Set(); for (const p of files.keys()) { const segs = p.split('/'); for (let k = 1; k < segs.length; k++) s.add(segs.slice(0, k).join('/')) } return [...s].sort() }
  const vaultBytes = () => [...files.values()].reduce((n, f) => n + f.size, 0)

  const devices = new Map((opts.devices || []).map(([id, name]) => [id, { id, name, lastSeen: new Date(now).toISOString() }]))
  const namespaces = new Map() // ns → [{ id, parentId, name, path, kind, revision, deleted, version?, hash?, size?, bytes? }]

  const requests = []
  let url = '' // set once listening; handlers only run after that
  const account = opts.desktop ? await require(path.join(opts.desktop, 'scripts/lib/fake-forsion-cloud.cjs')).startFakeForsionCloud({ scenario: 'email-only' }) : null
  const iso = (ms) => new Date(ms).toISOString()

  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url || '/', 'http://x')
    const p = u.pathname
    const rec = { at: Date.now(), method: req.method, path: p, query: u.search || '', status: 0, names: [], body: null }
    requests.push(rec)
    for (const k of ['path', 'ref', 'newPath', 'newName', 'from', 'to', 'dest', 'destination']) { const v = u.searchParams.get(k); if (v) rec.names.push(v) }
    const json = (status, body) => { rec.status = status; res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(body)) }
    const body = async () => { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks) }
    try {
      // ── legacy online engine: the Amadeus cloud vault ──
      if (p === '/api/amadeus/vaults') return json(200, { vaults: [{ id: vaultId, name: 'My Vault', sizeBytes: vaultBytes(), lastChangeSeq: vaultSeq, role: 'owner', ownerName: null }] })
      if (p === '/api/amadeus/shared-with-me') return json(200, { items: [] })
      if (p === '/api/amadeus/collab/link-base') return json(200, { webOrigin: url })
      if (p === '/api/amadeus/attachments') return json(200, { attachments: [], totalBytes: 0 })
      const vm = /^\/api\/amadeus\/vaults\/([^/]+)(\/.*)?$/.exec(p)
      if (vm) {
        if (decodeURIComponent(vm[1]) !== vaultId) return json(404, { detail: 'vault not found' })
        const sub = vm[2] || ''
        if (sub === '/tree') {
          const all = [...files.values()].sort((a, b) => a.path.localeCompare(b.path))
          return json(200, {
            pages: all.filter((f) => f.kind === 'page').map((f) => f.path),
            files: all.filter((f) => f.kind !== 'page').map((f) => ({ path: f.path, size: f.size })),
            folders: folderList(),
            entries: all.map((f) => ({ path: f.path, kind: f.kind, seq: f.seq, hash: f.hash, size: f.size, updatedAt: iso(f.updatedAt) })),
            seq: vaultSeq, maxFileBytes: 100 * MB,
          })
        }
        if (sub === '/file' && req.method === 'GET') {
          const f = files.get(u.searchParams.get('path') || '')
          if (!f || !isText(f.kind)) return json(404, { detail: 'not found' })
          return json(200, { content: f.content, seq: f.seq, hash: f.hash, updatedAt: iso(f.updatedAt) })
        }
        if (sub === '/file' && req.method === 'PUT') {
          const x = JSON.parse((await body()).toString() || '{}')
          rec.names.push(String(x.path)); rec.body = String(x.content ?? '')
          const cur = files.get(x.path)
          if (cur && !x.force && Number(x.baseSeq) !== cur.seq) return json(409, { code: 'CONFLICT', seq: cur.seq, content: cur.content })
          if (!cur && Number(x.baseSeq) > 0 && !x.force) return json(409, { code: 'CONFLICT', seq: 0, content: '' })
          const f = put(x.path, String(x.content ?? ''), Date.now())
          change('write', x.path)
          return json(200, { seq: f.seq, hash: f.hash })
        }
        if (sub === '/file' && req.method === 'DELETE') {
          const fp = u.searchParams.get('path') || ''
          if (files.delete(fp)) change('delete', fp)
          return json(200, { ok: true })
        }
        if (sub === '/binary' && req.method === 'POST') {
          const raw = await body()
          const form = await new Request('http://x', { method: 'POST', headers: { 'content-type': req.headers['content-type'] }, body: raw }).formData()
          const fp = String(form.get('path'))
          rec.names.push(fp)
          const f = put(fp, Buffer.from(await form.get('file').arrayBuffer()), Date.now())
          change('write', fp)
          return json(200, { path: fp, size: f.size, seq: f.seq })
        }
        if (sub === '/asset') {
          const f = files.get(u.searchParams.get('ref') || '')
          if (!f) return json(404, { detail: 'not found' })
          rec.status = 200; res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': f.bytes.length }); return res.end(f.bytes)
        }
        if (sub === '/changes') {
          const since = Number(u.searchParams.get('since') || 0)
          return json(200, { changes: changes.filter((c) => c.seq > since), seq: vaultSeq })
        }
        if (sub === '/events') {
          rec.status = 200
          res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
          res.write(`event: hello\ndata: ${JSON.stringify({ seq: vaultSeq })}\n\n`)
          const since = Number(u.searchParams.get('since') || 0)
          for (const c of changes.filter((c) => c.seq > since)) res.write(`event: change\ndata: ${JSON.stringify(c)}\n\n`)
          sse.add(res)
          const ping = setInterval(() => res.write(': ping\n\n'), 15_000)
          req.on('close', () => { clearInterval(ping); sse.delete(res) })
          return
        }
        if (sub === '/file/versions') return json(200, { versions: [] })
        const quota = { collab: 3, publish: 3, maxFileBytes: 100 * MB }
        if (sub === '/shares') return json(200, { shares: [], quota })
        if (sub === '/page-shares' && req.method === 'GET') return json(200, u.searchParams.has('path') ? { share: null, quota } : { shares: [], quota })
        if (sub === '/presence') return json(200, { ok: true })
        if (['/move', '/folders/rename', '/folders/move', '/folders'].includes(sub)) {
          const raw = await body(); try { const x = JSON.parse(raw.toString() || '{}'); for (const k of ['path', 'from', 'to', 'newPath', 'newName', 'dest', 'destination']) if (x[k]) rec.names.push(String(x[k])) } catch { /* not JSON */ }
          return json(200, { ok: true, seq: vaultSeq })
        }
        return json(404, { detail: 'not in fake cloud (amadeus)' })
      }

      // ── new content sync: /api/remotesync/content/<ns>[/nodes/<id>[/content]] ──
      if (p.startsWith('/api/remotesync/content/')) {
        const parts = p.split('/').filter(Boolean)
        const ns = decodeURIComponent(parts[3])
        const clean = ({ bytes, ...n }) => n
        if (ns === 'devices') {
          if (req.method === 'PUT') {
            const x = JSON.parse((await body()).toString() || '{}')
            const id = decodeURIComponent(parts[4] || '')
            devices.set(id, { id, name: x.name, lastSeen: iso(Date.now()) })
            return json(200, { ok: true })
          }
          return json(200, { devices: [...devices.values()] })
        }
        const list = namespaces.get(ns) || []
        namespaces.set(ns, list)
        if (parts.length === 4 && req.method === 'GET') return json(200, { schemaVersion: 1, namespace: ns, folder: ns === 'default' ? 'Forsion' : `Forsion-${ns.slice(7, 15)}`, nodes: list.map(clean) })
        const bytes = await body()
        const v = () => JSON.parse(bytes.toString() || '{}')
        const relink = () => { const of = (n) => (n.parentId ? of(list.find((x) => x.id === n.parentId)) + '/' + n.name : n.name); for (const n of list) n.path = of(n) }
        if (req.method === 'POST') {
          const x = v()
          rec.names.push(String(x.name))
          const same = list.find((n) => !n.deleted && n.parentId === (x.parentId || '') && n.name === x.name)
          if (same) return json(200, clean(same))
          const n = { ...x, id: x.id || crypto.randomUUID(), parentId: x.parentId || '', revision: 1, deleted: false, path: '' }
          list.push(n); relink()
          return json(200, clean(n))
        }
        const n = list.find((x) => x.id === parts[5])
        if (!n) return json(404, { detail: 'missing' })
        rec.names.push(n.path)
        if (parts[6] === 'content') {
          if (req.method === 'GET') { rec.status = 200; res.writeHead(200, { 'Content-Length': n.bytes?.length ?? 0 }); return res.end(n.bytes ?? Buffer.alloc(0)) }
          if ((n.version || 'create') !== req.headers['x-content-version']) return json(409, { detail: 'CAS' })
          n.bytes = bytes; n.hash = sha256(bytes); n.version = `${Number(n.version?.split(':')[0] || 0) + 1}:${n.hash}`; n.size = bytes.length
          return json(200, { version: n.version, hash: n.hash, size: n.size })
        }
        const x = v()
        if (n.revision !== x.revision) return json(409, { detail: 'revision' })
        if (req.method === 'PATCH') { n.parentId = x.parentId; n.name = x.name; rec.names.push(String(x.name)); n.revision++; relink(); return json(200, clean(n)) }
        n.deleted = true
        return json(200, { ok: true })
      }

      // ── Penzor pages the sync page may touch ──
      if (p === '/api/remotesync/vaults') return json(200, { vaults: [], usedBytes: 0, diagnosticsBytes: 0, maxBytes: 2048 * MB, maxFileBytes: 50 * MB })
      if (p === '/api/storage/quota') return json(200, { used: vaultBytes(), quota: 10240 * MB, percentage: 0 })

      // ── everything else: account / quota / notices → fake-forsion-cloud ──
      if (account) {
        rec.forwarded = true
        const raw = await body()
        const t = new URL(account.url)
        const up = http.request({ host: t.hostname, port: t.port, path: req.url, method: req.method, headers: { ...req.headers, host: t.host } }, (ur) => {
          rec.status = ur.statusCode || 502
          res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res)
        })
        up.on('error', () => json(502, { detail: 'account fake down' }))
        return up.end(raw)
      }
      return json(404, { detail: 'not in fake cloud' })
    } catch (e) {
      rec.error = String((e && e.stack) || e)
      if (!res.headersSent) json(500, { detail: String(e) })
    }
  })
  await new Promise((r) => server.listen(0, '127.0.0.1', r))
  url = `http://127.0.0.1:${server.address().port}`
  return {
    url, vaultId, files, devices, namespaces, requests,
    /** Requests whose touched names match `test` (a RegExp over each name). */
    touched: (test) => requests.filter((r) => r.names.some((n) => test.test(n))),
    /** Accepted legacy text writes (PUT /file, 200) whose body contains `token`. */
    writesWith: (token) => requests.filter((r) => r.method === 'PUT' && /\/file$/.test(r.path) && r.status === 200 && (r.body || '').includes(token)),
    /** Every legacy text write attempt carrying `token`, whatever the server answered. */
    attemptsWith: (token) => requests.filter((r) => r.method === 'PUT' && /\/file$/.test(r.path) && (r.body || '').includes(token)),
    close: async () => { for (const r of sse) r.end(); server.closeAllConnections?.(); server.close(); if (account) await account.close().catch(() => {}) },
  }
}

module.exports = { startVaultSyncCloud }
