/** Optional business runtimes are shipped in plugins; Unit itself remains dependency-free. */
import { mkdir, cp, readFile, writeFile, rm } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { buildLocalEngine } from './build-local-engine.mjs'
const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../desktop/package.json', import.meta.url))
const { build } = require('esbuild')

export async function buildLocalPlugins(output = resolve(root, 'dist/plugins')) {
  for (const id of ['amadeus', 'tangu', 'calendar', 'automation', 'public']) {
    const target = resolve(output, id)
    await mkdir(target, { recursive: true })
    const manifest = JSON.parse(await readFile(resolve(root, 'plugins', id, 'manifest.json'), 'utf8'))
    await cp(resolve(root, 'plugins', id, 'README.md'), resolve(target, 'README.md'))
    if (id === 'amadeus' || id === 'tangu') {
      await build({ entryPoints: [resolve(root, 'plugins', id, 'runtime.ts')], outfile: resolve(target, 'runtime.mjs'), bundle: true,
        platform: 'node', target: 'node20', format: 'esm', tsconfig: resolve(root, '../desktop/tsconfig.json'),
        banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" } })
      manifest.runtime = { apiVersion: 1, main: 'runtime.mjs' }
      if (id === 'tangu') {
        await rm(resolve(target, 'engine'), { recursive: true, force: true })
        const engine = await buildLocalEngine({ output: resolve(target, 'engine'), sqlitePackage: process.env.UNIT_SQLITE_PACKAGE })
        manifest.runtime.dependencies = engine.dependencies
      }
    }
    await writeFile(resolve(target, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  }
  return output
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) console.log(await buildLocalPlugins(process.argv[2]))
