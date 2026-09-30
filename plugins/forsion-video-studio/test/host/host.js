// A stand-in for the Forsion desktop host: the same plugin contract (ctx), an in-memory vault, and the
// desktop app's CSP (see host.html). Drives main.js the way pluginStore does: new Function('ctx', src).
window.HOST = (() => {
  const files = new Map();           // vault path → string | Uint8Array
  const watchers = new Map();
  const calls = { notify: [], startChat: [], openFile: [], complete: [] };
  const reg = { fileTypes: [], creators: [], commands: [], slash: [], embeds: [] };
  const enc = new TextEncoder(), dec = new TextDecoder();
  let data = {};
  let mounted = null;
  const app = {
    readFile: async p => { const v = files.get(p); return v === undefined ? null : typeof v === 'string' ? v : dec.decode(v); },
    writeFile: async (p, t) => { files.set(p, String(t)); },
    readBytes: async p => { const v = files.get(p); return v === undefined ? null : typeof v === 'string' ? enc.encode(v) : v; },
    writeBytes: async (p, b) => { files.set(p, b instanceof Uint8Array ? b : new Uint8Array(b)); },
    assetUrl: p => `${location.origin}/vault/${encodeURIComponent(p)}`,
    hostPath: p => `/home/me/Vault/${p}`,
    vaultRoot: () => '/home/me/Vault',
    workFolder: () => 'Forsion Video Studio',
    watchFile: (p, cb) => { watchers.set(p, cb); return () => watchers.delete(p); },
    openFile: p => { calls.openFile.push(p); open(p); },
    notify: m => calls.notify.push(m),
    prompt: async (title, initial) => initial,
  };
  const ctx = {
    app,
    getLocale: () => 'zh',
    notify: m => calls.notify.push(m),
    loadData: async () => data,
    saveData: async d => { data = JSON.parse(JSON.stringify(d)); },
    registerFileType: d => { reg.fileTypes.push(d); return true; },
    registerFileCreator: d => reg.creators.push(d),
    registerCommand: d => reg.commands.push(d),
    registerSlashItem: d => reg.slash.push(d),
    registerEmbedRenderer: d => reg.embeds.push(d),
    tangu: {
      startChat: async o => { calls.startChat.push(o); return { ok: true, sessionId: 's1' }; },
      complete: async o => { calls.complete.push(o); return { text: `${o.selection}！` }; },
    },
  };
  function open(p) {
    const ft = reg.fileTypes.find(f => f.extensions.some(e => p.toLowerCase().endsWith(e)));
    if (!ft) throw new Error(`no file type for ${p}`);
    if (mounted) mounted();
    const el = document.getElementById('view');
    el.replaceChildren();
    mounted = ft.mount(el, { filePath: p }) || null;
  }
  return {
    files, calls, reg, ctx, open, get data() { return data; },
    load(src) { new Function('ctx', src)(ctx); },
    external(p, text) { files.set(p, text); const cb = watchers.get(p); if (cb) cb(); },
    text: p => { const v = files.get(p); return typeof v === 'string' ? v : v ? dec.decode(v) : null; },
  };
})();
