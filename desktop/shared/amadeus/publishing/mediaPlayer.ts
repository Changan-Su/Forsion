/** Activate media emitted by publicMarkdown. Shared by publishing previews and websites. */
export function mountPublishedMedia(
  root: HTMLElement,
  locale: 'zh' | 'en' = 'en',
): () => void {
  const zh = locale === 'zh'
  const figures = Array.from(
    root.querySelectorAll<HTMLElement>('[data-amadeus-media]'),
  )
  const controllers = new AbortController()
  const pauseOthers = (current: HTMLElement): void => {
    figures.forEach((f) => {
      if (f !== current)
        f.querySelector<HTMLMediaElement>('video,audio')?.pause()
    })
  }
  for (const figure of figures) {
    const button = figure.querySelector<HTMLButtonElement>('button')!,
      stage = figure.querySelector<HTMLElement>('.md-media-stage')!
    button.addEventListener(
      'click',
      () => {
        const error = figure.querySelector<HTMLElement>('.md-media-error')!
        error.hidden = true
        if (figure.dataset.amadeusMedia === 'platform') {
          if (stage.querySelector('iframe')) {
            stage.querySelector('iframe')!.remove()
            stage.classList.remove('playing')
            button.textContent = zh ? '播放' : 'Play'
            return
          }
          pauseOthers(figure)
          const frame = document.createElement('iframe')
          frame.src = figure.dataset.src!
          frame.title =
            figure.querySelector('figcaption span')?.textContent || 'Video'
          frame.allow =
            'accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen'
          frame.allowFullscreen = true
          frame.referrerPolicy = 'strict-origin-when-cross-origin'
          stage.appendChild(frame)
          stage.classList.add('playing')
          button.textContent = zh ? '关闭播放器' : 'Close player'
          return
        }
        let video = stage.querySelector<HTMLMediaElement>('video,audio')
        if (!video) {
          video = document.createElement(
            figure.dataset.amadeusMedia === 'audio' ? 'audio' : 'video',
          )
          video.setAttribute('controls', '')
          video.setAttribute('playsinline', '')
          video.preload = 'none'
          video.src = figure.dataset.src!
          stage.appendChild(video)
          video.addEventListener(
            'playing',
            () => {
              stage.classList.add('playing')
              button.textContent = zh ? '暂停' : 'Pause'
            },
            { signal: controllers.signal },
          )
          video.addEventListener(
            'pause',
            () => {
              button.textContent = video!.ended
                ? zh
                  ? '重播'
                  : 'Replay'
                : zh
                  ? '继续播放'
                  : 'Resume'
            },
            { signal: controllers.signal },
          )
          video.addEventListener(
            'loadedmetadata',
            () => {
              if (
                    video instanceof HTMLVideoElement &&
                video.videoHeight
              )
                stage.style.aspectRatio = `${video.videoWidth}/${video.videoHeight}`
            },
            { signal: controllers.signal },
          )
        }
        if (!video.paused) {
          video.pause()
          return
        }
        pauseOthers(figure)
        video.play().catch(() => {
          error.hidden = false
          stage.classList.remove('playing')
        })
      },
      { signal: controllers.signal },
    )
  }
  const demos = mountDemoVideos(root, controllers.signal)
  const pause = (): void => {
    figures.forEach((f) =>
      f.querySelector<HTMLMediaElement>('video,audio')?.pause(),
    )
  }
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) pause()
      demos.sync()
    },
    { signal: controllers.signal },
  )
  return () => {
    controllers.abort()
    pause()
    demos.dispose()
    figures.forEach((f) => f.querySelector('iframe')?.remove())
  }
}

/** `![alt](clip.mp4)` demo loops: play only while on screen, never under reduced motion,
 * and fall back to native controls when the browser refuses autoplay (low-power mode etc.). */
function mountDemoVideos(
  root: HTMLElement,
  signal: AbortSignal,
): { sync(): void; dispose(): void } {
  const videos = Array.from(
    root.querySelectorAll<HTMLVideoElement>('video[data-amadeus-demo]'),
  )
  const idle = { sync() {}, dispose() {} }
  if (!videos.length) return idle
  const manual = (v: HTMLVideoElement): void => {
    v.removeAttribute('autoplay')
    v.pause()
    v.controls = true
  }
  if (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  ) {
    videos.forEach(manual)
    return { sync() {}, dispose: () => videos.forEach((v) => v.pause()) }
  }
  // Without IntersectionObserver the autoplay attribute alone keeps the loops running.
  if (typeof IntersectionObserver === 'undefined') return idle
  const onScreen = new Set<HTMLVideoElement>(),
    refused = new Set<HTMLVideoElement>()
  const sync = (): void => {
    for (const v of videos) {
      if (refused.has(v)) continue
      if (!onScreen.has(v) || document.hidden) {
        v.pause()
        continue
      }
      if (!v.paused) continue
      v.muted = true // autoplay is only allowed muted
      v.play()?.catch((e: unknown) => {
        // AbortError = a pause() overtook this play() while scrolling past; not a refusal.
        if ((e as { name?: string })?.name === 'AbortError' || signal.aborted)
          return
        refused.add(v)
        manual(v)
      })
    }
  }
  const observer = new IntersectionObserver((entries) => {
    for (const e of entries) {
      const v = e.target as HTMLVideoElement
      if (e.isIntersecting) onScreen.add(v)
      else onScreen.delete(v)
    }
    sync()
  })
  // Playback is driven from here: an off-screen loop must not keep decoding until the first callback.
  for (const v of videos) {
    v.removeAttribute('autoplay')
    observer.observe(v)
  }
  return {
    sync,
    dispose() {
      observer.disconnect()
      videos.forEach((v) => v.pause())
    },
  }
}
