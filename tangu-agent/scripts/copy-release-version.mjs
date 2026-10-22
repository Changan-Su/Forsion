// tsc resolves the declaration of the shared JS contract; ship its implementation alongside the compiled engine.
import { copyFile, mkdir } from 'node:fs/promises'
const destination = new URL('../dist/contracts/', import.meta.url)
await mkdir(destination, { recursive: true })
for (const name of ['releaseVersion.mjs', 'releaseVersion.d.mts']) {
  await copyFile(new URL(`../src/contracts/${name}`, import.meta.url), new URL(name, destination))
}
