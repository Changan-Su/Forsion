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
  const pause = (): void => {
    figures.forEach((f) =>
      f.querySelector<HTMLMediaElement>('video,audio')?.pause(),
    )
  }
  document.addEventListener(
    'visibilitychange',
    () => {
      if (document.hidden) pause()
    },
    { signal: controllers.signal },
  )
  return () => {
    controllers.abort()
    pause()
    figures.forEach((f) => f.querySelector('iframe')?.remove())
  }
}
