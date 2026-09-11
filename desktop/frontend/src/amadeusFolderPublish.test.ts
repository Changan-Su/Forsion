/** Execute the actual folder-menu click handler with a controlled bridge. This
 * covers the UI entry point, not merely cloudPathFor's already-tested mapping. */
import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cloudPathFor } from './stores/entrySyncStore'
import type { AmadeusEntrySyncVault } from './types'

const source = ts.createSourceFile('amadeusViews.tsx', readFileSync(new URL('./amadeusViews.tsx', import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let handler: ts.Expression | undefined
function visit(node: ts.Node): void {
  if (ts.isJsxElement(node) && node.openingElement.tagName.getText(source) === 'button'
      && node.children.some((child) => child.getText(source).includes("t('amxv.menu.publishFolder')"))) {
    const attr = node.openingElement.attributes.properties.find((p) => ts.isJsxAttribute(p) && p.name.getText(source) === 'onClick')
    if (attr && ts.isJsxAttribute(attr) && attr.initializer && ts.isJsxExpression(attr.initializer)) handler = attr.initializer.expression
  }
  ts.forEachChild(node, visit)
}
visit(source)
if (!handler) throw new Error('Folder publish menu handler not found')
const js = ts.transpile(`(${handler.getText(source)})`, { target: ts.ScriptTarget.ES2022 })
const buildClick = new Function('window', 'menu', 'setMenu', 'navigator', 'useApp', 't', 'entryVaults', 'vaultRoot', 'vaultSide', 'cloudPathFor', 'openCloudSyncDialog', `return ${js}`)
const vaults: AmadeusEntrySyncVault[] = [{ vaultRoot: '/vault', cloudName: 'Cloud notes', entries: [{ path: 'Docs', kind: 'folder' }] }]

async function click(path: string, side: 'local' | 'cloud' = 'local', missing = false) {
  const createPublish = vi.fn(async (_mode: string, _path: string) => {
    if (missing) throw { status: 404 }
    return { url: 'https://example.test/p/token' }
  })
  const toast = vi.fn()
  const openCloudSyncDialog = vi.fn()
  const window = { amadeusCollab: { createPublish }, amadeusSync: {} }
  vi.stubGlobal('window', window)
  const fn = buildClick(window, { path }, vi.fn(), { clipboard: { writeText: vi.fn(async () => {}) } },
    { getState: () => ({ toast }) }, (key: string) => key, vaults, '/vault', side, cloudPathFor, openCloudSyncDialog)
  fn()
  for (let i = 0; i < 8; i++) await Promise.resolve()
  return { createPublish, toast, openCloudSyncDialog }
}
afterEach(() => vi.unstubAllGlobals())

describe('folder context-menu publishing', () => {
  it('publishes the mapped cloud folder from local mode', async () => {
    const { createPublish } = await click('Docs')
    expect(createPublish).toHaveBeenCalledWith('subtree', 'Cloud notes/Docs')
  })
  it('guides an unsynced local folder to sync without publishing an unrelated cloud path', async () => {
    const { createPublish, openCloudSyncDialog } = await click('Private')
    expect(createPublish).not.toHaveBeenCalled()
    expect(openCloudSyncDialog).toHaveBeenCalledWith('Private', 'folder')
  })
  it('keeps an already-cloud path unchanged', async () => {
    const { createPublish } = await click('Cloud notes/Docs', 'cloud')
    expect(createPublish).toHaveBeenCalledWith('subtree', 'Cloud notes/Docs')
  })
  it('reports an unavailable cloud folder without incorrectly declaring that the user is not its owner', async () => {
    const { toast } = await click('Docs', 'local', true)
    expect(toast).toHaveBeenCalledWith('amxv.publish.notUploaded', true)
  })
})
