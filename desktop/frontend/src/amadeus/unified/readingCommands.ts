import type { Command } from '@lcl/engine'
import { activePageScope } from '../store/pageStore'
import { registerMessages, translate } from '../../i18n'

registerMessages({ 'reading.command': { zh: '切换阅读 / 编辑', en: 'Toggle reading / editing' } })
const targets = new Map<string, () => void>()
export function registerReadingToggle(scope: string, toggle: () => void, ownsView: boolean): () => void {
  if (!ownsView) return () => {}
  targets.set(scope, toggle)
  return () => { if (targets.get(scope) === toggle) targets.delete(scope) }
}
export const READING_COMMANDS: Command[] = [{
  id: 'amadeus-toggle-reading', title: () => translate('reading.command'),
  keywords: 'read reading edit mode 阅读 编辑 模式',
  run: () => { targets.get(activePageScope())?.() },
}]
