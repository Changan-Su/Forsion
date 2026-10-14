// Forsion setup body. The iframe isolates DOM/CSS, not security authority.
if (!ctx.packageFiles) throw new Error('Obsidian Bridge requires the Desktop packageFiles host API.');
let mounted = null;
ctx.registerView({
  id: 'home', title: 'Obsidian Bridge',
  mount(el) {
    if (mounted) {
      el.textContent = 'Obsidian Bridge is already open or finishing a settings save.';
      return () => {};
    }
    const iframe = document.createElement('iframe');
    iframe.title = 'Obsidian Bridge';
    iframe.style.cssText = 'width:100%;height:100%;border:0;display:block;background:transparent';
    let dead = false, runtime = null, starting = Promise.resolve(), writes = Promise.resolve();
    let releaseLease = null, codePromise = null, generation = 0, draft = null;
    const disposeRuntime = () => {
      try { runtime?.dispose(); } catch (error) { console.warn('[obsidian-bridge] old document cleanup', error); }
      runtime = null;
    };
    const dispose = () => {
      if (dead) return;
      dead = true; generation++;
      observer.disconnect();
      iframe.removeEventListener('load', onLoad);
      disposeRuntime();
      // Serialization lives in the parent realm, surviving iframe detach/reload.
      // Keep the lease until all accepted snapshots reach the host.
      void (async () => {
        try { try { await starting; } finally { await writes; } }
        catch (error) { console.error('[obsidian-bridge] shutdown', error); }
        finally {
          releaseLease?.(); iframe.remove();
          if (mounted === dispose) mounted = null;
        }
      })();
    };
    mounted = dispose;
    const syncTheme = () => {
      const root = iframe.contentDocument?.documentElement;
      if (!root) return;
      const style = getComputedStyle(document.documentElement);
      for (let i = 0; i < style.length; i++) {
        const key = style[i];
        if (key.startsWith('--')) root.style.setProperty(key, style.getPropertyValue(key));
      }
      root.dataset.mode = document.documentElement.dataset.mode || '';
      root.lang = ctx.getLocale?.() === 'zh' ? 'zh-CN' : 'en';
    };
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true, attributeFilter: ['class','style','data-mode','data-theme','data-skin','data-bg'],
    });
    const acquired = new Promise((resolve, reject) => {
      if (!navigator.locks) return reject(new Error('Desktop Web Locks support is required.'));
      navigator.locks.request('forsion-obsidian-bridge-runtime', { ifAvailable: true }, async lock => {
        resolve(!!lock);
        if (lock && !dead) await new Promise(done => { releaseLease = done; });
      }).catch(reject);
    });
    async function initialize(turn, child) {
      if (!await acquired) throw new Error('Obsidian Bridge is already open in another window.');
      for (let i = 0; i < 50 && !ctx.app.vaultRoot?.() && !dead; i++) await new Promise(r => setTimeout(r, 100));
      if (dead || turn !== generation) return;
      await writes.catch(() => {});
      codePromise ||= ctx.packageFiles.readText('runtime.js');
      const code = await codePromise;
      if (dead || turn !== generation || iframe.contentWindow !== child) return;
      syncTheme(); child.eval(code);
      const instance = await child.ForsionObsidianBridge.start({
        locale: ctx.getLocale?.() || 'en', packageFiles: ctx.packageFiles,
        initialDraft: draft,
        onDraft: value => { if (!dead && turn === generation) draft = structuredClone(value); },
        loadData: () => ctx.loadData(),
        saveData: value => {
          if (dead || turn !== generation) return Promise.reject(new Error('Bridge document is closed'));
          const snapshot = structuredClone(value);
          writes = writes.catch(() => {}).then(() => ctx.saveData(snapshot));
          return writes;
        },
        vaultRoot: () => ctx.app.vaultRoot?.(),
        listPages: () => ctx.app.listPages?.() || Promise.resolve([]),
        readFile: path => ctx.app.readFile(path),
        writeFile: (path, text) => ctx.app.writeFile(path, text),
        openFile: path => ctx.app.openNote(path, { newTab: true }),
      });
      if (dead || turn !== generation) instance.dispose();
      else runtime = instance;
    }
    function onLoad() {
      // Dockview can detach/reinsert the same iframe when changing tabs. Chromium reloads srcdoc,
      // so rehydrate its realm from a parent-owned draft instead of leaving a blank document.
      const turn = ++generation;
      disposeRuntime();
      starting = initialize(turn, iframe.contentWindow);
      void starting.catch(error => {
        if (dead || turn !== generation) return;
        dispose(); el.textContent = String(error);
      });
    }
    iframe.addEventListener('load', onLoad);
    iframe.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    el.appendChild(iframe);
    return dispose;
  },
});
ctx.registerCommand({ id: 'obsidian-bridge-open', title: 'Obsidian Bridge', run: () => ctx.openView('home') });
return () => mounted?.();
