import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { expect, it } from 'vitest'

// Test the real host gate without mounting the workspace/editor dependency graph.
const source = ts.createSourceFile('amadeusViews.tsx', readFileSync(new URL('./amadeusViews.tsx', import.meta.url), 'utf8'),
  ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)
let gate: ts.Expression | undefined
function visit(node: ts.Node): void {
  if (ts.isVariableDeclaration(node) && node.name.getText(source) === 'onlineCollab') gate = node.initializer
  ts.forEachChild(node, visit)
}
visit(source)
if (!gate) throw new Error('Online picker gate not found')
const onlineCollab = new Function('cloudBridge', 'vaultSide', 'window', `return ${gate.getText(source)}`)

it('offers the online picker on the web and the mobile cloud bridge', () => {
  const collab = {}
  expect(onlineCollab(true, 'cloud', { tangu: { cloudWeb: true }, amadeusCollab: collab })).toBe(collab)
  expect(onlineCollab(true, 'cloud', { tangu: { cloudWeb: true, mobile: true }, amadeusCollab: collab })).toBe(collab)
})

it('keeps the native local vault and desktop mirror out of the online picker even if collab is installed', () => {
  const collab = {}
  expect(onlineCollab(true, 'local', { tangu: { cloudWeb: true, mobile: true }, amadeusCollab: collab })).toBeUndefined()
  expect(onlineCollab(false, 'cloud', { amadeusCollab: collab })).toBeUndefined()
})
