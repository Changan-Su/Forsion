import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { resolve, dirname } from 'node:path'
const root = dirname(fileURLToPath(import.meta.url))
const require = createRequire(new URL('../desktop/package.json', import.meta.url))
const { build } = require('esbuild')
await build({ entryPoints: [resolve(root, 'main.ts')], outfile: resolve(root, 'dist/main.mjs'),
  bundle: true, platform: 'node', target: 'node20', format: 'esm',
  tsconfig: resolve(root, '../desktop/tsconfig.json') })
console.log('[unit] Built standalone Node runtime (no Electron or runtime npm dependencies).')
