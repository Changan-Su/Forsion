import { viewEventOwners } from './obsidian.js';

const surfaceCss = `:host{display:block;color:var(--text);font-family:var(--font-ui,system-ui);--text-normal:var(--text);--background-primary:var(--bg);--background-secondary:var(--bg-card);--background-modifier-border:var(--border);--mermaid-font:var(--font-ui,system-ui)}*{box-sizing:border-box}canvas{max-width:100%}button,input,select,textarea{font:inherit;color:inherit}`;
export function createNativeRendering(host, runtime) {
  const registrations = new Set();
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
        style.textContent = surfaceCss + '\n' + (entry.styleText || '').replace(/:root\b/g, ':host');
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
          for (const child of children) { try { child.unload(); } catch (error) { runtime.error(error); } }
          children.clear(); root.replaceChildren();
        };
        mounts.add(dispose); block.signal.addEventListener('abort', dispose, {once:true});
        if (block.signal.aborted) { dispose(); return dispose; }
        viewEventOwners.set(container, fn => valid() ? runtime.invoke(entry, () => valid() && untilDisposed(fn()), false, null).catch(runtime.error) : undefined);
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
      active = false; registrations.delete(off);
      const i = entry.cleanup.indexOf(off); if (i !== -1) entry.cleanup.splice(i, 1);
      for (const dispose of [...mounts]) dispose();
      offHost();
    };
    registrations.add(off); entry.cleanup.push(off);
    return processor;
  }
  return {register, diagnostics: () => ({processors: registrations.size}), dispose() { for (const off of [...registrations]) off(); }};
}
