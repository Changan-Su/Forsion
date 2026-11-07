/** TLS stays end-to-end. Only the updater partition on the disposable VM uses this loopback proxy. */
const assert = require('node:assert/strict')
const http = require('node:http')
const net = require('node:net')
const { once } = require('node:events')
const { setTimeout: delay } = require('node:timers/promises')

const allowed = new Set(['forsion.net', 'dl.forsion.net', 'github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com'])
const cdn = new Map([['dl.forsion.net', 'website'], ['release-assets.githubusercontent.com', 'github'], ['objects.githubusercontent.com', 'github']])
const faultAfter = 8 * 1024 * 1024
const initialRate = 1024 * 1024

async function startUpdateProxy(primary, action) {
  const sockets = new Set()
  const events = []
  let delivered = 0
  let faulted = false
  const server = http.createServer((_req, res) => res.writeHead(405).end())
  server.on('connect', (req, client, head) => {
    const host = /^([a-z0-9.-]+):443$/i.exec(req.url)?.[1].toLowerCase()
    if (!allowed.has(host)) { client.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return }
    const affected = cdn.get(host) === primary
    if (affected && faulted && action === 'drop') { client.destroy(); return }
    const upstream = net.connect(443, host)
    sockets.add(client); sockets.add(upstream)
    client.on('error', () => upstream.destroy())
    upstream.on('error', () => client.destroy())
    client.once('close', () => { sockets.delete(client); upstream.destroy() })
    upstream.once('close', () => { sockets.delete(upstream); client.destroy() })
    upstream.once('connect', () => {
      events.push({ action: 'connect', host, at: Date.now() })
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      client.pipe(upstream)
      if (!affected) { upstream.pipe(client); return }
      void (async () => {
        for await (const chunk of upstream) {
          if (action !== 'throttle' && delivered >= faultAfter) {
            if (!faulted) events.push({ action, host, at: Date.now(), encryptedBytes: delivered })
            faulted = true
            if (action === 'stall') await once(client, 'close')
            break
          }
          delivered += chunk.length
          if (!client.write(chunk)) await Promise.race([once(client, 'drain'), once(client, 'close')])
          await delay(Math.ceil(chunk.length * 1000 / initialRate))
        }
      })().catch(() => {}).finally(() => { client.destroy(); upstream.destroy() })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  assert.equal(server.address().address, '127.0.0.1')
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    events,
    close: () => {
      for (const socket of sockets) socket.destroy()
      server.close()
    },
  }
}

module.exports = { startUpdateProxy }
