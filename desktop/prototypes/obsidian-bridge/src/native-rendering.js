import { viewEventOwners } from './obsidian.js';
import publishedCss from '../../../frontend/src/amadeus/plugins/publishingEditor.css?inline';

const surfaceCss = `:host{display:block;color:var(--text);font-family:var(--font-ui,system-ui);--text-normal:var(--text);--background-primary:var(--bg);--background-secondary:var(--bg-card);--background-modifier-border:var(--border);--mermaid-font:var(--font-ui,system-ui)}*{box-sizing:border-box}canvas{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}`;
const markdownCss = publishedCss.replaceAll('.amx-publishing-editor', ':host') + `
:host{font-family:var(--font-body,system-ui);line-height:var(--reading-line-height,1.6)}
a{color:var(--accent-ink,var(--accent))}img{max-width:100%}.svg-icon{width:1.15em;height:1.15em;display:block;flex-shrink:0}
.callout{border:1px solid var(--border);border-radius:var(--radius-sm);padding:12px;background:color-mix(in srgb,var(--accent) 7%,var(--bg))}
.callout-title{padding-right:30px;display:flex;align-items:center;gap:8px;font-weight:600;color:var(--accent-ink,var(--text))}
.callout-title-inner{flex:1;min-width:0}.callout-title-inner>p{margin:0}.callout-fold{margin-left:auto}.is-collapsible>.callout-title{cursor:pointer}
.callout-content{overflow:hidden}.callout-content>:last-child{margin-bottom:0}.callout.is-collapsed .callout-fold{transform:rotate(-90deg)}
`;
export function createNativeRendering(host, runtime) {
  const registrations = new Set(), definitions = new Map();
  function render(entry, markdown, el, sourcePath, component, app) {
    if (!host.renderMarkdown) return Promise.reject(Error('Host Markdown rendering is unavailable'));
    if (!component?.register || !el?.appendChild || typeof markdown !== 'string') return Promise.reject(Error('MarkdownRenderer requires Markdown, an element and a lifecycle component'));
    const epoch = entry.epoch;
    let disposed = false, finishDisposed;
    const cancelled = new Promise(resolve => { finishDisposed = resolve; });
    const nodes = [], listeners = [];
    const valid = () => !disposed && !component._unloaded && entry.alive && entry.epoch === epoch;
    const dispose = () => {
      if (disposed) return;
      disposed = true; finishDisposed();
      for (const [node, listener] of listeners) node.removeEventListener('click', listener);
      for (const node of nodes) node.remove();
    };
    component.register(dispose);
    const work = (async () => {
      if (!valid()) return;
      const output = host.renderMarkdown(markdown);
      const html = typeof output === 'string' ? output : await output;
      if (!valid()) return;
      // Parse in the original plugin realm so Obsidian's DOM helpers remain available.
      const template = document.createElement('template'); template.innerHTML = html;
      for (const anchor of template.content.querySelectorAll('a[href]')) {
        const href = anchor.getAttribute('href');
        if (!href || /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href)) continue;
        const click = event => {
          event.preventDefault();
          if (!valid()) return;
          void runtime.invoke(entry, () => {
            let link = href;
            try { link = decodeURIComponent(href); } catch { /* A literal percent is valid in a note filename. */ }
            if (valid()) return app.workspace.openLinkText(link, sourcePath, event.metaKey || event.ctrlKey);
          }, false, null).catch(runtime.error);
        };
        anchor.addEventListener('click', click);listeners.push([anchor, click]);
      }
      // Plugins may unwrap a paragraph and promote its children (for example a
      // rendered title). Retain every generated node so teardown still owns it.
      const remember = node => { nodes.push(node); for (const child of node.childNodes) remember(child); };
      for (const node of template.content.childNodes) remember(node);
      el.append(template.content);
    })();
    return runtime.track(Promise.race([work, cancelled]));
  }

  function register(entry, language, processor) {
    if (typeof language !== 'string' || !language || typeof processor !== 'function') throw Error('Invalid Markdown code block processor');
    const epoch = entry.epoch, mounts = new Set();
    let active = true;
    const live = () => active && entry.alive && entry.epoch === epoch;
    const offHost = host.registerCodeBlockRenderer({
      id: `${entry.manifest.id}:${language}`,
      language,
      async mount(el, block) {
        if (!live()) throw Error('Markdown processor is disabled');
        const root = el.shadowRoot || el.attachShadow({mode:'open'});
        const container = document.createElement('div');
        container.className = 'markdown-preview-view markdown-rendered';
        const style = document.createElement('style');
        style.textContent = surfaceCss + '\n' + markdownCss + '\n' + (entry.styleText || '').replace(/:root\b/g, ':host');
        root.append(style, container);
        const children = new Set();
        let disposed = false, finishDisposed;
        const disposedPromise = new Promise(resolve => { finishDisposed = resolve; });
        // Retire only this mount's work. A plugin may never settle its async
        // processor/child load, but it must not retain the shared command queue.
        const untilDisposed = work => Promise.race([Promise.resolve(work), disposedPromise]);
        const valid = () => !disposed && !block.signal.aborted && live();
        const dispose = () => {
          if (disposed) return;
          disposed = true; finishDisposed(); mounts.delete(dispose);
          block.signal.removeEventListener('abort', dispose);
          viewEventOwners.delete(container);
          viewEventOwners.delete(root);
          for (const child of children) { try { child.unload(); } catch (error) { runtime.error(error); } }
          children.clear(); root.replaceChildren();
        };
        mounts.add(dispose); block.signal.addEventListener('abort', dispose, {once:true});
        if (block.signal.aborted) { dispose(); return dispose; }
        viewEventOwners.set(container, fn => valid() ? runtime.invoke(entry, () => valid() && untilDisposed(fn()), false, null).catch(runtime.error) : undefined);
        viewEventOwners.set(root, viewEventOwners.get(container));
        const context = {
          sourcePath: block.pagePath,
          frontmatter: undefined,
          getSectionInfo: () => null, // no fabricated source offsets
          addChild(child) {
            if (!valid()) { child.unload(); return; }
            children.add(child);
            // Plugins may call onload() themselves from reload(), bypassing
            // Component.load(). Keep those continuations inside the mount lifetime.
            const onload = child.onload;
            if (typeof onload === 'function') {
              child._loadHandlesLateTeardown = true;
              child.onload = (...args) => {
                if (!valid() || child._unloaded) return;
                const loading = onload.apply(child, args);
                if (loading?.then) return Promise.resolve(loading).finally(() => {
                  if (!valid() || child._unloaded) child.onunload?.();
                });
                return loading;
              };
            }
            const loading = child.load();
            const completion = Promise.resolve(loading).then(() => { if (!valid()) child.unload(); });
            runtime.track(untilDisposed(completion)).catch(runtime.error);
          },
        };
        try {
          await runtime.invoke(entry, () => valid() && untilDisposed(processor(block.source, container, context)), false, null);
          if (!valid()) dispose();
          return dispose;
        } catch (error) { dispose(); throw error; }
      },
    });
    const off = () => {
      if (!active) return;
      active = false; registrations.delete(off); definitions.delete(off);
      const i = entry.cleanup.indexOf(off); if (i !== -1) entry.cleanup.splice(i, 1);
      for (const dispose of [...mounts]) dispose();
      offHost();
    };
    definitions.set(off, {entry, epoch, language, processor});
    registrations.add(off); entry.cleanup.push(off);
    return processor;
  }
  return {register, render, unregister(entry, epoch, value) { for (const [off, def] of definitions) if (def.entry === entry && def.epoch === epoch && (def.language === value || def.processor === value)) off(); }, diagnostics: () => ({processors: registrations.size}), dispose() { for (const off of [...registrations]) off(); }};
}
