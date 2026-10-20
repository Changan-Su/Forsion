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
 * and fall back to native controls when the browser refuses autoplay (low-power mode etc.).
 * Whoever started it, a loop pauses off screen or in a hidden tab; one the viewer started resumes when back. */
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
  const reduce =
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const watch = typeof IntersectionObserver !== 'undefined'
  // Without IntersectionObserver the autoplay attribute alone keeps the loops running.
  if (!watch && !reduce) return idle
  // auto = loops this player starts by itself; the rest (reduced motion, refused) only the viewer starts.
  const auto = new Set<HTMLVideoElement>(reduce ? [] : videos),
    onScreen = new Set<HTMLVideoElement>(watch ? [] : videos),
    resume = new Set<HTMLVideoElement>()
  if (reduce) videos.forEach(manual)
  const sync = (): void => {
    for (const v of videos) {
      if (!onScreen.has(v) || document.hidden) {
        if (!v.paused) {
          v.pause()
          if (!auto.has(v)) resume.add(v)
        }
        continue
      }
      if (!v.paused || !(auto.has(v) || resume.delete(v))) continue
      if (auto.has(v)) v.muted = true // autoplay is only allowed muted
      v.play()?.catch((e: unknown) => {
        // AbortError = a pause() overtook this play() while scrolling past; not a refusal.
        if ((e as { name?: string })?.name === 'AbortError' || signal.aborted)
          return
        if (auto.delete(v)) manual(v)
      })
    }
  }
  const observer = watch
    ? new IntersectionObserver((entries) => {
        for (const e of entries) {
          const v = e.target as HTMLVideoElement
          if (e.isIntersecting) onScreen.add(v)
          else onScreen.delete(v)
        }
        sync()
      })
    : null
  // Playback is driven from here: an off-screen loop must not keep decoding until the first callback.
  for (const v of videos) {
    v.removeAttribute('autoplay')
    observer?.observe(v)
  }
  return {
    sync,
    dispose() {
      observer?.disconnect()
      videos.forEach((v) => v.pause())
    },
  }
}
