import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { latestReleasedVersion, parseChangelog } from './src/changelogParse'

const read = (file: string) => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8')

/** Inline at build/dev time so the first painted frame never waits for a module or plugin. */
export function startupAppearanceHtml() {
  const runtime = read('./startupAppearance.js')
  // Same parser as APP_VERSION (src/changelog.ts itself needs Vite's `?raw` and cannot load in a config).
  const version = latestReleasedVersion(parseChangelog(read('../CHANGELOG.md')))
  return {
    name: 'forsion-startup-appearance',
    transformIndexHtml(html: string) {
      // Function replacer: `$'` and friends in the runtime text must not expand to page HTML.
      return html.replace('<!-- forsion-startup-runtime -->', () => `<script>window.FORSION_APP_VERSION=${JSON.stringify(version)};${runtime}</script>`)
    },
  }
}
