// @vitest-environment happy-dom
import { afterEach, expect, it } from 'vitest'
import { pickRoot } from './findInPage'

afterEach(() => document.body.replaceChildren())
it('resolves active persistent content when header focus is outside all Views', () => {
  document.body.innerHTML = '<div class="dv-render-overlay" data-lcl-active="false"><div class="wb-view wb-view--main" id="hidden"></div></div><button id="header">New tab</button><div class="dv-render-overlay" data-lcl-active="true"><div class="wb-view wb-view--main" id="active"></div></div>'
  document.getElementById('header')!.focus()
  expect(pickRoot()).toBe(document.getElementById('active'))
})
it('keeps the focused nested View as the find scope', () => {
  document.body.innerHTML = '<div class="dv-render-overlay" data-lcl-active="true"><div class="wb-view"><div class="wb-view" id="nested"><input></div></div></div>'
  const nested = document.getElementById('nested')!
  nested.getClientRects = () => [{ width: 300, height: 200 }] as unknown as DOMRectList
  nested.querySelector('input')!.focus()
  expect(pickRoot()).toBe(nested)
})
