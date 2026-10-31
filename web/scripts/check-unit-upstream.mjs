/** Read-only deployment gate. Run before replacing the currently working Web gateway. */
import { pathToFileURL } from 'node:url'

export async function checkUnitUpstream(origin, fetcher = fetch) {
  const base = new URL(origin)
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('Supply a bare Unit origin')
  const get = async (path) => {
    const response = await fetcher(new URL(path, base), { redirect: 'error', signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`Unit publication is not ready: ${path} HTTP ${response.status}; keep the existing Web container`)
    return response.json()
  }
  const [meta, { plugins }, { spaces }] = await Promise.all([get('/web/unit/meta'), get('/web/unit/plugins'), get('/web/unit/spaces')])
  if (meta.projection !== 'public' || !meta.account || !meta.capabilities?.amadeus || !meta.capabilities?.tangu) throw new Error('The public Unit account/cloud services are not active')
  if (!Array.isArray(plugins) || !plugins.some((p) => p.id === 'forsion-extend' && p.locked === true && typeof p.code === 'string' && p.code.length > 0) || plugins.some((p) => p.id === 'server-admin')) throw new Error('Signed Extend is missing or Admin was published to the public entry')
  if (!Array.isArray(spaces) || !spaces.some((p) => p.slug === 'penzor' || JSON.parse(p.json || '{}').id === 'forsion-penzor')) throw new Error('The public cloud drive Space is missing')
  return { ok: true, version: meta.version, extend: plugins.find((p) => p.id === 'forsion-extend').version }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await checkUnitUpstream(process.argv[2]))) }
  catch (error) { console.error(error.message); process.exitCode = 1 }
}
