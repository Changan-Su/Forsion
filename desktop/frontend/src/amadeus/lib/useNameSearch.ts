/// <reference path="./pinyinlite.d.ts" />
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { PinyinReadings } from './nameSearch'

let dictionary: PinyinReadings | undefined
let loading: Promise<PinyinReadings | undefined> | undefined
function loadDictionary() {
  // Full covers simplified and traditional characters. Its dictionary is a separate renderer chunk.
  return loading ??= import('pinyinlite/index_full.js').then((module) => dictionary = module.default, () => {
    loading = undefined // A later opening can retry after an offline chunk request.
    return undefined
  })
}

/** Start loading on opening the picker. The input remains live during a cold chunk fetch. */
export function useNameDictionary() {
  const [settled, setSettled] = useState(!!dictionary)
  useEffect(() => {
    if (dictionary) { setSettled(true); return }
    let live = true
    void loadDictionary().then(() => { if (live) setSettled(true) })
    return () => { live = false }
  }, [])
  return { lookup: dictionary, pending: !settled && !dictionary }
}

/** A fast Enter can arrive before the dictionary. Confirm against the resulting rows, but only
 * for the original query/scope. Closing the picker discards the intention with the component. */
export function useNameConfirmation<T>(scope: string, pending: boolean, confirm: (choice: T) => void) {
  const queued = useRef<{ scope: string; choice: T } | null>(null)
  useLayoutEffect(() => {
    const intent = queued.current
    if (!intent) return
    if (intent.scope !== scope) { queued.current = null; return }
    if (!pending) { queued.current = null; confirm(intent.choice) }
  })
  return (choice: T) => {
    if (pending) queued.current = { scope, choice }
    else confirm(choice)
  }
}
