// Forsion setup body. The iframe isolates compatibility DOM helpers and styles, NOT security authority.
if (!ctx.packageFiles)
  throw new Error(
    "Obsidian Bridge requires the Desktop packageFiles host API.",
  );
let mounted = null;
ctx.registerView({
  id: "home",
  title: "Obsidian Bridge",
  async mount(el) {
    if (mounted) {
      el.textContent = "Obsidian Bridge is already open in this window.";
      return () => {};
    }
    const iframe = document.createElement("iframe");
    iframe.title = "Obsidian Bridge";
    iframe.style.cssText =
      "width:100%;height:100%;border:0;display:block;background:transparent";
    const ready = new Promise((resolve) =>
      iframe.addEventListener("load", resolve, { once: true }),
    );
    iframe.srcdoc =
      '<!doctype html><html><head><meta charset="utf-8"></head><body></body></html>';
    el.appendChild(iframe);
    let dead = false,
      runtime = null,
      starting = null,
      writes = Promise.resolve(),
      releaseLease = null;
    const dispose = () => {
      if (dead) return;
      dead = true;
      observer.disconnect();
      runtime?.dispose();
      // Keep serialization in the parent realm: removing an iframe must not discard queued writes.
      // The profile lease stays held until every accepted snapshot reaches the host.
      void (async () => {
        try {
          try { (await starting)?.dispose(); } finally { await writes; }
        } catch (error) {
          console.error("[obsidian-bridge] shutdown", error);
        } finally {
          releaseLease?.();
          iframe.remove();
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
        if (key.startsWith("--"))
          root.style.setProperty(key, style.getPropertyValue(key));
      }
      root.dataset.mode = document.documentElement.dataset.mode || "";
      root.lang = ctx.getLocale?.() === "zh" ? "zh-CN" : "en";
    };
    const observer = new MutationObserver(syncTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: [
        "class",
        "style",
        "data-mode",
        "data-theme",
        "data-skin",
        "data-bg",
      ],
    });
    try {
      await ready;
      if (dead) return dispose;
      // One runtime per Desktop profile, including satellite windows. Prevents whole-blob settings
      // writes from two concurrent Bridge views from overwriting each other.
      if (!navigator.locks)
        throw new Error("Desktop Web Locks support is required.");
      const acquired = await new Promise((resolve, reject) => {
        navigator.locks
          .request(
            "forsion-obsidian-bridge-runtime",
            { ifAvailable: true },
            async (lock) => {
              resolve(!!lock);
              if (lock)
                await new Promise((done) => {
                  releaseLease = done;
                });
            },
          )
          .catch(reject);
      });
      if (!acquired)
        throw new Error("Obsidian Bridge is already open in another window.");
      if (dead) {
        releaseLease?.();
        return dispose;
      }
      // The host restores the vault lazily when this native View mounts.
      for (let i = 0; i < 50 && !ctx.app.vaultRoot?.() && !dead; i++)
        await new Promise((r) => setTimeout(r, 100));
      const code = await ctx.packageFiles.readText("runtime.js");
      if (dead) return dispose;
      syncTheme();
      iframe.contentWindow.eval(code);
      starting = iframe.contentWindow.ForsionObsidianBridge.start({
        locale: ctx.getLocale?.() || "en",
        packageFiles: ctx.packageFiles,
        loadData: () => ctx.loadData(),
        saveData: (value) => {
          if (dead) return Promise.reject(new Error("Bridge is closed"));
          const snapshot = structuredClone(value);
          writes = writes.catch(() => {}).then(() => ctx.saveData(snapshot));
          return writes;
        },
        vaultRoot: () => ctx.app.vaultRoot?.(),
        listPages: () => ctx.app.listPages?.() || Promise.resolve([]),
        readFile: (path) => ctx.app.readFile(path),
        writeFile: (path, text) => ctx.app.writeFile(path, text),
        openFile: (path) => ctx.app.openNote(path, { newTab: true }),
      });
      runtime = await starting;
      if (dead) runtime.dispose();
    } catch (error) {
      dispose();
      el.textContent = String(error);
      throw error;
    }
    return dispose;
  },
});
ctx.registerCommand({
  id: "obsidian-bridge-open",
  title: "Obsidian Bridge",
  run: () => ctx.openView("home"),
});
return () => mounted?.();
