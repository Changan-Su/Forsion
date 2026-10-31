import { expect, it } from 'vitest'
import { effectivePluginId } from './products'
it('uses stable ASCII plugin IDs independently of localized names and package directories', () => {
  for (const id of ['bluebird', 'diting', 'md-tables', 'sample-bundle']) expect(effectivePluginId('中文目录', id)).toBe(id)
  expect(effectivePluginId('bluebird', '青鸟收藏夹')).toBe('bluebird')
  expect(effectivePluginId('中文目录', '青鸟收藏夹')).toBeNull()
  for (const id of ['../bluebird', 'Bluebird', 'a/b', 'a b']) expect(effectivePluginId('中文目录', id)).toBeNull()
})
