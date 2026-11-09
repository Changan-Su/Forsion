import { expect, it } from 'vitest'
import { bindRecipeToPlugin, effectivePluginId } from './products'
it('uses stable ASCII plugin IDs independently of localized names and package directories', () => {
  for (const id of ['bluebird', 'diting', 'md-tables', 'sample-bundle']) expect(effectivePluginId('中文目录', id)).toBe(id)
  expect(effectivePluginId('bluebird', '青鸟收藏夹')).toBe('bluebird')
  expect(effectivePluginId('中文目录', '青鸟收藏夹')).toBeNull()
  for (const id of ['../bluebird', 'Bluebird', 'a/b', 'a b']) expect(effectivePluginId('中文目录', id)).toBeNull()
})

it('points a marketplace bundle\'s Space recipe at the views its runtime id registers', () => {
  const market = 'market-12345678-1234-4234-8234-123456789abc'
  const recipe = JSON.stringify({ layout: { main: [{ type: 'plugin:demo:chat' }, { type: 'plugin:demo-two:list' }, { type: 'plugin:demo:detail/preview' }, { type: 'plugin:demo:工作台' }] }, requires: { views: ['plugin:demo:chat'] }, name: 'plugin:demo: in text' })
  const bound = JSON.parse(bindRecipeToPlugin(recipe, 'demo', market))
  expect(bound.layout.main.map((x: { type: string }) => x.type)).toEqual([`plugin:${market}:chat`, 'plugin:demo-two:list', `plugin:${market}:detail/preview`, `plugin:${market}:工作台`])
  expect(bound.requires.views).toEqual([`plugin:${market}:chat`])
  expect(bound.name).toBe('plugin:demo: in text')
  expect(bindRecipeToPlugin(recipe, 'demo', 'demo')).toBe(recipe)
  expect(bindRecipeToPlugin(recipe, '../x', market)).toBe(recipe)
})
