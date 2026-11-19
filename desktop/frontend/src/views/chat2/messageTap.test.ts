// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { installNativeChromeHost } from '@lcl/engine'
import { tapTarget } from './messageTap'

const STREAM = `
  <div class="mb-shell" id="shell" data-native-chrome="">
  <div class="t2-stream-inner">
    <div class="t2-userwrap" id="u1" data-quiet=""><div class="t2-user-col"><div class="t2-user"><span id="u1-text">question</span></div><div class="t2-actions"><button id="u1-copy">copy</button></div></div></div>
    <div class="t2-asst" id="a1" data-quiet="solo"><div class="t2-asst-col">
      <div class="tool-group"><div id="a1-tools">3 tools</div></div>
      <div class="t2-content"><p id="a1-text">answer <a id="a1-link" href="#x">link</a> <code id="a1-code">code</code></p><img id="a1-img" data-viewable=""><div class="code-box"><pre id="a1-pre">x</pre><button id="a1-codecopy">copy</button></div></div>
      <div class="t2-actions"><button id="a1-copy">copy</button></div>
    </div></div>
    <div class="t2-asst" id="a2" data-quiet="last solo"><div class="t2-asst-col"><div class="t2-content"><p id="a2-text">last answer</p></div></div></div>
    <div class="t2-asst" id="plain"><div class="t2-asst-col"><div class="t2-content"><p id="plain-text">a preview's message</p></div></div></div>
  </div>
  <button id="outside">send</button>
  </div>`
const $ = (id: string): HTMLElement => document.getElementById(id)!
const tapped = (): string[] => [...document.querySelectorAll('[data-tapped]')].map((el) => el.id)
/** A finger's tap: the press, then the click. */
const tap = (id: string): void => {
  $(id).dispatchEvent(new Event('pointerdown', { bubbles: true }))
  $(id).dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
}

describe('tapTarget', () => {
  beforeEach(() => { document.body.innerHTML = STREAM })
  it('the text of an answer and the user bubble stand for their message', () => {
    expect(tapTarget($('a1-text'))?.id).toBe('a1')
    expect(tapTarget($('a1-code'))?.id).toBe('a1')
    expect(tapTarget($('a1-pre'))?.id).toBe('a1')
    expect(tapTarget($('u1-text'))?.id).toBe('u1')
  })
  it('links, buttons, the copy key of a code block and images do not', () => {
    for (const id of ['a1-link', 'a1-img', 'a1-codecopy', 'a1-copy', 'u1-copy']) expect(tapTarget($(id))).toBeNull()
  })
  it('nor does anything outside the text: tool rows, the action row', () => {
    expect(tapTarget($('a1-tools'))).toBeNull()
    expect(tapTarget($('outside'))).toBeNull()
  })
  it('a message without marks (not part of a conversation on the phone) is left alone', () => {
    expect(tapTarget($('plain-text'))).toBeNull()
  })
})

describe('a tap on a message', () => {
  let off: (() => void) | undefined
  beforeEach(() => { document.body.innerHTML = STREAM; off = installNativeChromeHost({ spaces: true, render() {} }) })
  afterEach(() => { tap('outside'); off?.(); off = undefined })

  it('shows that message; a second tap or a tap elsewhere puts it back', () => {
    tap('a1-text')
    expect(tapped()).toEqual(['a1'])
    tap('a1-text')
    expect(tapped()).toEqual([])
    tap('a1-text'); tap('outside')
    expect(tapped()).toEqual([])
  })
  it('one message at a time', () => {
    tap('a1-text'); tap('u1-text')
    expect(tapped()).toEqual(['u1'])
  })
  it('its own keys and links do not put it back, and do not show a message that was not showing', () => {
    tap('a1-link')
    expect(tapped()).toEqual([])
    tap('a1-text'); tap('a1-copy'); tap('a1-link'); tap('a1-tools')
    expect(tapped()).toEqual(['a1'])
  })
  it('a tap that a handler already took (default prevented) is not a tap on the message', () => {
    $('a1-text').addEventListener('click', (e) => e.preventDefault(), { once: true })
    tap('a1-text')
    expect(tapped()).toEqual([])
  })
  it('a press that opened the long-press menu is not a tap', () => {
    $('u1-text').dispatchEvent(new Event('pointerdown', { bubbles: true }))
    $('u1-text').dispatchEvent(new Event('contextmenu', { bubbles: true }))
    $('u1-text').dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(tapped()).toEqual([])
  })
  it('with text selected the tap only drops the selection', () => {
    tap('a1-text')
    const range = document.createRange()
    range.selectNodeContents($('a2-text'))
    getSelection()!.removeAllRanges(); getSelection()!.addRange(range)
    tap('u1-text')
    expect(tapped()).toEqual(['a1'])
    getSelection()!.removeAllRanges()
    tap('u1-text')
    expect(tapped()).toEqual(['u1'])
  })
  it('does nothing where no host draws the dock (desktop, the web drawer layout)', () => {
    off?.(); off = undefined
    tap('a1-text')
    expect(tapped()).toEqual([])
  })
  it('nor side by side (a tablet in landscape): nothing is folded away there, and the message that was showing is put back', () => {
    tap('a1-text')
    expect(tapped()).toEqual(['a1'])
    $('shell').setAttribute('data-wide', '')
    tap('u1-text')
    expect(tapped()).toEqual([])
    tap('a1-text')
    expect(tapped()).toEqual([])
    // back to one column: taps count again, and nothing is left open from before
    $('shell').removeAttribute('data-wide')
    expect(tapped()).toEqual([])
    tap('a1-text')
    expect(tapped()).toEqual(['a1'])
  })
  it('a shell without a host\'s dock around the message does not count either', () => {
    $('shell').removeAttribute('data-native-chrome')
    tap('a1-text')
    expect(tapped()).toEqual([])
  })
})
