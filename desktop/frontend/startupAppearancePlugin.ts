import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

/** Inline at build/dev time so the first painted frame never waits for a module or plugin. */
export function startupAppearanceHtml() {
  const runtime = read('./startupAppearance.js')
  // First released heading = APP_VERSION (src/changelog.ts, which needs Vite's `?raw` and cannot load here); changelog.test.ts pins the two.
  const version = /^##\s+(?:Forsion\s+)?v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)(?=\s|$)/im.exec(read('../CHANGELOG.md'))?.[1] ?? ''
  return {
    name: 'forsion-startup-appearance',
    transformIndexHtml(html: string) {
      // Function replacer: `$'` and friends in the runtime text must not expand to page HTML.
      return html.replace('<!-- forsion-startup-runtime -->', () => `<script>window.FORSION_APP_VERSION=${JSON.stringify(version)};${runtime}</script>`)
    },
  }
}
