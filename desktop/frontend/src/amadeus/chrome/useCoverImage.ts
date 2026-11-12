import { useEffect, useRef, useState } from 'react'
import { loadCoverImage } from './coverImageCache'
import { fromAssetUrl } from '@amadeus-shared/assets'

/** Native/mobile vault assets must keep the host's content-version and invalidation behavior. */
function remoteImage(source: string): boolean {
  try {
    if (!/^https?:\/\//i.test(source) || fromAssetUrl(source) !== null) return false
    const host = new URL(source).hostname
    return host !== 'localhost' && !host.endsWith('.localhost') && host !== '127.0.0.1' && host !== '[::1]'
  } catch { return false }
}

export function useCoverImage(source: string, attempt = 0) {
  const [state, setState] = useState({ source: '', attempt: -1, src: '', failed: false, uncached: false, loaded: false })
  const previousAttempt = useRef(attempt)
  useEffect(() => {
    const refresh = previousAttempt.current !== attempt
    previousAttempt.current = attempt
    let active = true
    const controller = new AbortController()
    let objectUrl: string | null = null
    const update = (value: { src: string; failed: boolean; uncached: boolean }): void => {
      if (active) setState({ source, attempt, ...value, loaded: false })
    }
    if (!remoteImage(source)) update({ src: source, failed: false, uncached: false })
    else void loadCoverImage(source, refresh, controller.signal).then(({ blob, persisted }) => {
      if (!active) return
      objectUrl = URL.createObjectURL(blob)
      update({ src: objectUrl, failed: false, uncached: !persisted })
    }, () => {
      if (controller.signal.aborted) return
      // Non-CORS image links can still display through <img>; they cannot be cached by this origin.
      const knownCors = /^https:\/\/(images\.unsplash\.com|picsum\.photos)\//i.test(source)
      update({ src: knownCors ? '' : source, failed: knownCors, uncached: true })
    })
    return () => { active = false; controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [source, attempt])
  const current = state.source === source && state.attempt === attempt
  const src = current ? state.src : ''
  useEffect(() => {
    if (!src) return
    const image = new Image()
    const timer = setTimeout(() => { image.src = ''; setState((s) => s.source === source && s.attempt === attempt ? { ...s, failed: true } : s) }, 12_000)
    image.onload = () => {
      clearTimeout(timer)
      setState((s) => s.source === source && s.attempt === attempt ? { ...s, loaded: true } : s)
    }
    image.onerror = () => { clearTimeout(timer); setState((s) => s.source === source && s.attempt === attempt ? { ...s, failed: true } : s) }
    image.src = src
    return () => { clearTimeout(timer); image.onload = image.onerror = null; image.src = '' }
  }, [source, attempt, src])
  return { src, failed: current && state.failed, uncached: current && state.uncached, loaded: current && state.loaded }
}
