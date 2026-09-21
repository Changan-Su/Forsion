/** Pick the file ChatView should auto-reference from the native main area.
 *
 * A Space can keep several Dockview groups visible at once. Focus may be on a plugin or ChatView
 * panel with no file, while an Amadeus document is still visible next to it. A fileless focused
 * panel must therefore not erase the companion document from the reference chain. */
export interface MainReferenceTab {
  type: string
  active: boolean
  front: boolean
  filePath?: string
}

export function mainReferenceKey(tabs: readonly MainReferenceTab[]): string {
  const active = tabs.find((tab) => tab.active)
  const candidate = (active?.filePath ? active : undefined)
    ?? tabs.find((tab) => tab.front && tab.filePath)
    ?? tabs.find((tab) => tab.type === 'amadeus-editor' && tab.filePath)
    ?? tabs.find((tab) => tab.filePath)
  if (!candidate) return ''
  if (candidate.type === 'amadeus-editor') return candidate.filePath ? `note:${candidate.filePath}` : 'note'
  return candidate.filePath ? `file:${candidate.filePath}` : ''
}
