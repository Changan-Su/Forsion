import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Inline at build/dev time so the first painted frame never waits for a module or plugin. */
export function startupAppearanceHtml() {
  const runtime = readFileSync(fileURLToPath(new URL('./startupAppearance.js', import.meta.url)), 'utf8')
  return {
    name: 'forsion-startup-appearance',
    transformIndexHtml(html: string) {
      return html.replace('<!-- forsion-startup-runtime -->', `<script>${runtime}</script>`)
    },
  }
}
