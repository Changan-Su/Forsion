// Setup body: a stable hidden iframe owns plugin lifetimes; Amadeus owns every editable document.
if (!ctx.packageFiles || !ctx.app.captureEditor) throw new Error('Obsidian Bridge requires the native Desktop editor API.');
const zh = ctx.getLocale?.() === 'zh';
let dead = false, runtime = null, writes = Promise.resolve(), commands = [], releaseLease = null;
let starting = null, openRequested = false;
const dialog = document.createElement('dialog');
dialog.setAttribute('aria-label', 'Obsidian Bridge');
dialog.style.cssText = 'width:min(1100px,92vw);height:min(780px,88vh);padding:0;border:1px solid var(--border);border-radius:var(--radius-lg,12px);background:var(--bg);color:var(--text)';
const frame = document.createElement('iframe');
frame.title = 'Obsidian Bridge';
frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
dialog.append(frame); document.body.append(dialog);
const clearCommands = () => { commands.splice(0).forEach(off => off?.()); };
const closeManager = () => { openRequested = false; if (dialog.open) dialog.close(); };
const notifyError = e => { console.error('[obsidian-bridge]', e); if (!dead) ctx.app.notify(String(e?.message || e)); };
function syncTheme() {
  const root = frame.contentDocument?.documentElement;
  if (!root) return;
  const style = getComputedStyle(document.documentElement);
  for (let i = 0; i < style.length; i++) { const key = style[i]; if (key.startsWith('--')) root.style.setProperty(key, style.getPropertyValue(key)); }
  root.dataset.mode = document.documentElement.dataset.mode || '';
  root.lang = zh ? 'zh-CN' : 'en';
}
const observer = new MutationObserver(syncTheme);
observer.observe(document.documentElement, { attributes:true, attributeFilter:['class','style','data-mode','data-theme','data-skin','data-bg'] });
async function initialize() {
  const acquired = await new Promise((resolve, reject) => {
    if (!navigator.locks) return reject(new Error('Desktop Web Locks support is required.'));
    navigator.locks.request('forsion-obsidian-bridge-runtime', { ifAvailable:true }, async lock => {
      resolve(!!lock);
      if (lock && !dead) await new Promise(done => { releaseLease = done; });
    }).catch(reject);
  });
  if (!acquired) throw new Error('Obsidian Bridge is already running in another window.');
  if (dead) return;
  const code = await ctx.packageFiles.readText('runtime.js');
  if (dead) return;
  syncTheme(); frame.contentWindow.eval(code);
  await startRuntime();
}
async function startRuntime() {
  await writes.catch(() => {});
  if (dead) return;
  const instance = await frame.contentWindow.ForsionObsidianBridge.start({
    locale:ctx.getLocale?.() || 'en', packageFiles:ctx.packageFiles,
    isMac:document.documentElement.dataset.platform === 'mac',
    vaultRoot:() => ctx.app.vaultRoot?.(), loadData:() => ctx.loadData(),
    saveData:value => {
      if (dead) return Promise.reject(new Error('Bridge is closed'));
      const snapshot = structuredClone(value);
      writes = writes.catch(() => {}).then(() => ctx.saveData(snapshot));
      return writes;
    },
    captureEditor:() => { if (dead) return null; return ctx.app.captureEditor(); },
    readFile:p=>ctx.app.readFile(p), listPages:()=>ctx.app.listPages?.()||[],
    writeFileChecked:(...args)=>{ if(dead)return Promise.reject(new Error("Bridge closed"));const p=ctx.app.writeFileChecked(...args);writes=Promise.all([writes.catch(()=>{}),p]).then(()=>{});return p; },
    patchNoteProperties:(...args)=>ctx.app.patchNoteProperties(...args),
    onVaultChange:cb=>ctx.app.onVaultChange?.(cb), subscribePage:cb=>ctx.app.subscribePage?.(cb),
    openNote:(...args)=>ctx.app.openNote(...args),
    openManager,
    closeManager,
    onError:notifyError,
    registerNativeView:def => ctx.registerView(def),
    openNativeView:(id,location) => { if (!dead) ctx.openView(id,{location}); },
    closeNativeView:id => ctx.closeView?.(id),
    onCommands:list => {
      clearCommands(); if (dead) return;
      for (const c of list) commands.push(ctx.registerCommand({
        id:`obsidian-bridge:${c.plugin}:${c.id}`, title:`Obsidian · ${c.pluginName}: ${c.name}`,
        keywords:`Obsidian Bridge ${c.id}`,
        hotkeys:c.hotkeys,
        hotkeyWhen:event => {
          if (dead || !runtime || refreshing || dialog.open || (event.repeat && !c.repeatable) || !runtime.canRun(c.plugin,c.id)) return false;
          // The current bridge command buffer requires a native note. Never edit a retained note
          // while the user is typing into a settings/search field or another editor surface.
          const target = event.target;
          if (!(target instanceof Element) || !target.closest('.ProseMirror[contenteditable="true"]') || target.closest('input,textarea,select,[contenteditable="false"]')) return false;
          if (runtime.diagnostics().vaultKey !== (ctx.app.vaultRoot?.() || '')) return false;
          try { return !!ctx.app.captureEditor(); } catch { return false; }
        },
        run:async () => { try { const captured = ctx.app.captureEditor(); await ensureVault(); if (!dead) await runtime?.run(c.plugin,c.id,captured); } catch (e) { notifyError(e); } },
      }));
    },
  });
  if (dead) instance.dispose(); else runtime = instance;
  if (openRequested && !dead && !dialog.open) dialog.showModal();
}
frame.addEventListener('load', () => { if (!starting) { starting = initialize(); void starting.catch(notifyError); } });
frame.srcdoc = '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
let refreshing = null;
const vaultWatch = setInterval(() => { if (!dead && runtime) void ensureVault().catch(notifyError); }, 500);
async function ensureVault() {
  if (refreshing) return refreshing;
  if (!runtime || runtime.diagnostics().vaultKey === (ctx.app.vaultRoot?.() || '')) return;
  runtime.dispose(); runtime = null; clearCommands();
  refreshing = startRuntime().finally(() => { refreshing = null; });
  return refreshing;
}
function openManager() {
  openRequested = true;
  void ensureVault().then(() => { if (!dead && runtime && !dialog.open) dialog.showModal(); }).catch(notifyError);
}
ctx.registerCommand({ id:'obsidian-bridge-open',title:'Obsidian Bridge',run:openManager });
ctx.registerView({ id:'home',title:'Obsidian Bridge',mount(el) {
  const text = document.createElement('p'); text.textContent = zh ? '在 Amadeus 笔记中点击左下角命令面板按钮，搜索 Obsidian 执行原生编辑命令。' : 'In an Amadeus note, open the command palette using the lower-left button and search Obsidian.';
  const button = document.createElement('button'); button.textContent = zh ? '管理插件与设置' : 'Manage plugins and settings'; button.onclick = openManager;
  el.append(text,button); return () => { text.remove(); button.remove(); };
} });
return () => {
  dead = true; clearInterval(vaultWatch); clearCommands(); observer.disconnect(); closeManager(); runtime?.dispose();
  void (async () => { try { try { await starting; await refreshing; } finally { await writes; } } catch (e) { console.warn('[obsidian-bridge] shutdown',e); } finally { releaseLease?.(); dialog.remove(); } })();
};
