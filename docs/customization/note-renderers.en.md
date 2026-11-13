# Note reading renderers

`ctx.registerNoteRenderer` replaces the Amadeus reading surface while the host retains the editor and save pipeline. It is available on desktop, web and mobile; feature-detect it on older hosts. Reading mode is independent of page locking. The note View provides its toggle; mobile users enter from the more menu and return to editing from the header.

```js
ctx.registerNoteRenderer?.({
  id: 'reading',
  apiVersion: 1,
  mount(element, snapshot, host) {
    // snapshot: { path, markdown, html, revision }, an immutable current-body snapshot.
    // The host's static HTML retains formatting and equations, without editing controls.
    element.className = 'milkdown'
    element.innerHTML = snapshot.html
    const click = (event) => {
      const link = event.target.closest('[data-wiki]')
      if (link && !host.signal.aborted) {
        event.preventDefault()
        host.openLink(link.dataset.wiki, 'wiki')
      }
    }
    element.addEventListener('click', click)
    return () => element.removeEventListener('click', click)
  },
})
```

`mount` may return a disposer, synchronously or asynchronously. The host mounts into a staging container and replaces the current surface only after success. A failed update retains the previous surface. Observe `host.signal` for cancellation; late results cannot replace a newer document. A new body snapshot mounts a fresh surface and then disposes the old one. Keep styles and resources inside the supplied container and release them in the disposer. Do not modify the editor DOM, write files or install global editing handlers.

The most recently registered active renderer wins. Registering the same plugin/id replaces its generation; an older handle cannot revoke a newer registration. Calling the returned handle's `dispose()` or disabling the plugin removes the registration and restores the bundled official module. During package hot reload, the existing reading surface remains until its replacement is ready. If initialization fails, retry the update or disable the plugin to restore the official module.

Before entering reading mode, the host waits for IME composition, captures input that has not reached the debounced cache and completes a strict save. A save failure leaves the note editable. The original editor remains mounted, preserving undo history, selection and the document session across renderer updates. Reading preference belongs to each View and is not written into note frontmatter.

Preserve `data-reading-anchor` attributes for anchor-based scroll restoration. If a custom layout cannot match the anchor, the host restores the previous scroll distance. Keep links accessible, text selectable and headings semantic so host search and outline remain useful. `host.openLink(href, 'wiki' | 'url')` delegates navigation to the host.

This first phase exposes read-only presentation only. Editor schemas, serializers and file formats remain host-owned and cannot be hot-swapped through this API. Unsupported API versions are rejected.

The default module delegates wiki, note, external and attachment links to the host; outline navigation and image double-click preview remain available. Task checkboxes retain their state but cannot be edited. This is a static reading snapshot: embedded app editing controls and iframes are omitted. Interactive plugin content needs its own read-only presentation.
