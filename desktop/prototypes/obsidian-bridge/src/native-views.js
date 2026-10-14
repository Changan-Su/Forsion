// Original ItemView DOM lives in a native Forsion View. Shadow roots isolate package CSS,
// while the stable Bridge realm retains prototypes, plugin instances and event ownership.
const baseCss = `:host{display:block;height:100%;color:var(--text);font-family:var(--font-ui,system-ui);font-size:var(--ui-font-body,13px);--text-normal:var(--text);--background-primary:var(--bg);--background-secondary:var(--bg-card);--nav-item-color:var(--text);--nav-item-size:var(--ui-font-body,13px);--nav-item-weight:400;--font-medium:500;--nav-item-background-hover:var(--bg-hover);--nav-item-color-hover:var(--text);--radius-s:var(--radius-sm)}*{box-sizing:border-box}.workspace-leaf-content{height:100%;overflow:auto}.view-content{padding:12px}.view-header:empty{display:none}.nav-buttons-container{display:flex;align-items:center;flex-wrap:wrap}.nav-action-button{cursor:pointer;border-radius:var(--radius-sm);color:var(--text-muted);padding:4px}.nav-action-button:hover{background:var(--bg-hover);color:var(--text)}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}svg{width:20px;height:20px}`;

export function createNativeViews(host, runtime, appForEntry) {
  const types = new Map(), leaves = new Set();
  let disposed = false;
  const valid = record => !disposed && record.entry.alive && record.entry.epoch === record.epoch && types.get(record.type) === record;
  function register(entry, type, create) {
    if (typeof type !== 'string' || !type || typeof create !== 'function') throw Error('Invalid view declaration');
    if (types.has(type)) throw Error(`View type already registered: ${type}`);
    // Register the stable type at plugin load, so persisted layouts never depend on a
    // previous session's ephemeral leaf counter or on running a command first.
    const record = { type, entry, epoch: entry.epoch, create, id: `obsidian-view-${type}`, leaf: null };
    types.set(type, record);
    try {
      record.off = host.registerNativeView({
        id: record.id, title: entry.manifest?.name || type, icon: 'file',
        mount(el) {
          if (!valid(record)) return;
          const leaf = record.leaf || getLeaf();
          if (!leaf.record) leaf.initialize(record, {});
          return leaf.mount(el);
        },
      });
      if (typeof record.off !== 'function') throw Error('Disposable native views require a newer Desktop host');
    } catch (error) { types.delete(type); throw error; }
    const off = () => {
      if (types.get(type) !== record) return;
      types.delete(type);
      const ownerIndex = entry.cleanup.indexOf(off);
      if (ownerIndex !== -1) entry.cleanup.splice(ownerIndex, 1);
      record.leaf?.detach();
      record.off();
    };
    entry.cleanup.push(off);
    return off;
  }
  function getLeaf(location = 'main') {
    if (disposed) throw Error('View host disposed');
    const leaf = {
      location, view: null, record: null, closed: false, state: null, mounted: false, app: null,
      invoke(fn) {
        if (leaf.closed || !leaf.mounted || !leaf.record || !valid(leaf.record)) return;
        let captured;
        try { captured = host.captureEditor?.() || null; }
        catch (error) { runtime.error(error); return; }
        return runtime.invoke(leaf.record.entry, () => {
          if (leaf.closed || !leaf.mounted || !valid(leaf.record)) return;
          return fn();
        }, !!captured, captured).catch(runtime.error);
      },
      initialize(record, state) {
        if (record.leaf && record.leaf !== leaf) throw Error('Multiple leaves of one view type are not supported yet');
        leaf.record = record; leaf.id = record.id; leaf.app = appForEntry(record.entry);
        leaf.state = state; leaf.view = record.create(leaf);
        if (!leaf.view?.containerEl) throw Error('View factory did not return an ItemView');
        leaf.view.containerEl.dataset.type = record.type;
        record.leaf = leaf; leaves.add(leaf);
        leaf.ready = new Promise((resolve, reject) => { leaf.resolveReady = resolve; leaf.rejectReady = reject; });
        leaf.ready.catch(() => {});
      },
      mount(el) {
        const record = leaf.record;
        if (leaf.closed || !valid(record)) return;
        leaf.mountCleanup?.(); leaf.mounted = true;
        const root = el.shadowRoot || el.attachShadow({ mode: 'open' });
        const style = document.createElement('style');
        style.textContent = baseCss + '\n' + (record.entry.styleText || '').replace(/:root\b/g, ':host');
        root.append(style, leaf.view.containerEl);
        const theme = () => {
          const dark = el.ownerDocument.documentElement.dataset.mode === 'dark';
          leaf.view.containerEl.classList.toggle('theme-dark', dark);
          leaf.view.containerEl.classList.toggle('theme-light', !dark);
        };
        const themeObserver = new MutationObserver(theme);
        themeObserver.observe(el.ownerDocument.documentElement, { attributes: true, attributeFilter: ['data-mode'] });
        theme();
        const resizeObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
          if (leaf.mounted && !leaf.closed) leaf.view.onResize?.();
        }) : null;
        resizeObserver?.observe(el);
        let cleaned = false;
        const cleanup = () => {
          if (cleaned) return;
          cleaned = true;
          themeObserver.disconnect(); resizeObserver?.disconnect();
          leaf.mounted = false; root.replaceChildren();
          if (leaf.mountCleanup === cleanup) leaf.mountCleanup = null;
        };
        leaf.mountCleanup = cleanup;
        // Unmount can mean sidebar collapse or Space navigation. Retain the view's
        // state and DOM; explicit detach/disable owns onClose and Component.unload.
        if (!leaf.opening) {
          leaf.opening = (async () => {
            await leaf.view.load?.();
            if (leaf.closed || !valid(record)) throw Error('View closed while opening');
            await leaf.view.setState?.(leaf.state, { history: false });
            if (leaf.closed || !valid(record)) throw Error('View closed while restoring state');
            await leaf.view.onOpen?.();
            if (leaf.closed || !valid(record)) throw Error('View closed while opening');
            leaf.view.onResize?.(); leaf.resolveReady();
          })().catch(error => { leaf.rejectReady(error); leaf.detach(); runtime.error(error); });
        } else leaf.view.onResize?.();
        return cleanup;
      },
      getViewState() { return { type: leaf.record?.type || 'empty', state: leaf.view?.getState?.() ?? leaf.state ?? {} }; },
      setViewState(spec) {
        const task = (async () => {
          if (leaf.closed) throw Error('Leaf closed');
          const record = types.get(spec?.type);
          if (!record || !valid(record)) throw Error(`Unsupported view: ${spec?.type}`);
          if (leaf.view) {
            if (leaf.record !== record) throw Error('Changing an existing leaf type is not supported yet');
            await leaf.view.setState?.(spec.state || {}, { history: false });
          } else leaf.initialize(record, spec.state || {});
          if (leaf.closed || !valid(record)) throw Error('View closed while restoring state');
          host.openNativeView(leaf.id, leaf.location);
          await leaf.ready;
        })();
        return runtime.track(task);
      },
      async openFile(file) {
        if (leaf.closed) throw Error('Leaf closed');
        const navigate = () => host.openNote(file.path, { newTab: true });
        if (runtime.context) runtime.context.after.push(navigate);
        else await navigate();
      },
      detach() {
        if (leaf.closed) return;
        leaf.closed = true; leaves.delete(leaf); leaf.mountCleanup?.();
        leaf.rejectReady?.(Error('View closed before mounting completed'));
        try { Promise.resolve(leaf.view?.onClose?.()).catch(runtime.error); }
        catch (error) { runtime.error(error); }
        try { leaf.view?.unload?.(); } catch (error) { runtime.error(error); }
        leaf.view?.containerEl?.remove();
        if (leaf.record?.leaf === leaf) leaf.record.leaf = null;
        if (leaf.id) host.closeNativeView?.(leaf.id);
      },
    };
    return leaf;
  }
  return {
    register, getLeaf,
    getLeavesOfType: type => [...leaves].filter(leaf => !leaf.closed && leaf.record.type === type),
    iterateAllLeaves: fn => { for (const leaf of [...leaves]) if (!leaf.closed) fn(leaf); },
    revealLeaf: leaf => { if (!leaf?.closed && leaves.has(leaf)) host.openNativeView(leaf.id, leaf.location); },
    detachLeavesOfType: type => { for (const leaf of [...leaves]) if (leaf.record.type === type) leaf.detach(); },
    diagnostics: () => [...leaves].map(leaf => ({ id: leaf.id, type: leaf.record.type, location: leaf.location, mounted: leaf.mounted })),
    dispose() { disposed = true; for (const leaf of [...leaves]) leaf.detach(); for (const record of types.values()) record.off?.(); types.clear(); },
  };
}
