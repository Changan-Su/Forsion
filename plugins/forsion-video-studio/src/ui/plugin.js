// Forsion Video Studio — the plugin's UI half. This file becomes main.js: a bare setup(ctx) body.
// Registers the .fvs.md file type (the editor), the four "new project" entry points, note embeds,
// and a command the agent may call to put a project in front of the user.
import { makeT } from './i18n.js';
import { mountStudio, trust, trustList, previewHtml, assetLoader } from './studio.js';
import { h, dirOf, joinPath } from './util.js';
import { evaTemplate } from '../lib/templates.js';
import { parseProject } from '../lib/project.js';
import { notify } from './ai.js';
import EXAMPLE from '../generated/example-src.js';

const t = makeT(ctx);
const EXT = '.fvs.md';
const ICON = 'layout';
const app = ctx.app || {};
const workFolder = () => (app.workFolder ? app.workFolder() : 'Forsion Video Studio');
const exists = async p => { try { return (await app.readFile(p)) !== null; } catch { return false; } };

async function remember(path) {
  try { const d = (await ctx.loadData?.()) || {}; await ctx.saveData?.({ ...d, last: path }); } catch { /* best effort */ }
}

/** Create a project from the starter template in `folder` and (by default) open it. */
async function createProject(folder, open = true) {
  // a default file name lands on disk: keep it the same in every UI language
  const base = '新视频';
  let path = joinPath(folder || '', `${base}${EXT}`);
  for (let k = 2; await exists(path); k++) path = joinPath(folder || '', `${base} ${k}${EXT}`);
  await app.writeFile(path, evaTemplate({ title: base, zh: !t.en() }));
  await trust(ctx, path);
  if (open && app.openFile) app.openFile(path);
  return path;
}

/** The bundled example (episode 2.12): written into the work folder once, then opened. */
async function openExample() {
  const dir = `${workFolder()}/第 2.12 话`;
  const file = `${dir}/episode-2.12${EXT}`;
  try {
    if (!(await exists(file))) {
      for (const [rel, b64] of Object.entries(EXAMPLE.assets)) {
        if (app.writeBytes) await app.writeBytes(`${dir}/${rel}`, Uint8Array.from(atob(b64), c => c.charCodeAt(0)));
      }
      await app.writeFile(file, EXAMPLE.text);
    }
    await trust(ctx, file);
    if (app.openFile) app.openFile(file);
    const audio = `${dir}/${EXAMPLE.audio}`;
    if (app.writeBytes && !(await exists(audio))) {
      // the score is 2 MB, so it is fetched instead of shipped inside main.js
      fetch(EXAMPLE.audioUrl).then(r => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))))
        .then(buf => app.writeBytes(audio, new Uint8Array(buf)))
        .catch(() => notify(ctx, t('example-audio-failed'), 'warn'));
    }
  } catch (e) {
    notify(ctx, String(e && e.message || e), 'warn');
  }
}

const registered = ctx.registerFileType({
  id: 'project',
  extensions: [EXT],
  icon: ICON,
  title: 'Video project',
  mount(el, file) {
    remember(file.filePath);
    return mountStudio(ctx, el, file.filePath, t);
  },
});

// a built-in owner of the suffix wins: then register nothing else (no duplicate "new" entries)
if (registered !== false) {
  ctx.registerFileCreator({ id: 'new-project', label: t('new-project'), icon: ICON, run: parent => createProject(parent).then(() => {}) });

  ctx.registerCommand({
    id: 'fvs-new-project',
    title: `Video Studio：${t('new-project')}`,
    keywords: 'video studio fvs 视频 工程 新建 动画 宣传片',
    run: () => createProject(workFolder()).then(() => {}),
  });
  ctx.registerCommand({
    id: 'fvs-open-example',
    title: `Video Studio：${t('open-example')}`,
    keywords: 'video studio fvs example 示例 2.12 eva 补完',
    run: () => openExample(),
  });
  ctx.registerCommand({
    id: 'fvs-open-project',
    title: t.en() ? 'Video Studio: Open the last project' : 'Video Studio：打开最近的工程',
    keywords: 'video studio fvs recent 最近',
    run: async () => {
      let last = null;
      try { last = ((await ctx.loadData?.()) || {}).last; } catch { last = null; }
      if (last && (await exists(last))) app.openFile(last); else createProject(workFolder());
    },
    invoke: {
      description: 'Open a Forsion Video Studio project (.fvs.md, vault-relative path) in the Video Studio editor so the user sees it. Use it after creating or editing a project for the user.',
      params: { type: 'object', properties: { path: { type: 'string', description: 'Vault-relative path of the .fvs.md file' } }, required: ['path'] },
      run: async args => {
        const p = String((args && args.path) || '').replace(/^\/+/, '');
        if (!p.toLowerCase().endsWith(EXT)) throw new Error(`not a ${EXT} file: ${p}`);
        if (!(await exists(p))) throw new Error(`no such file in the vault: ${p}`);
        app.openFile(p);
      },
    },
  });

  ctx.registerSlashItem({
    id: 'fvs-new-embed',
    label: () => t('new-project'),
    group: () => 'Video Studio',
    icon: ICON,
    keywords: 'video studio fvs 视频 工程 动画',
    run: async ({ folder }) => `![[${await createProject(folder, false)}]]`,
  });

  ctx.registerEmbedRenderer({
    id: 'fvs-embed',
    match: target => target.toLowerCase().endsWith(EXT),
    mount(el, embed) {
      let disposed = false, raf = 0, frame = null, playing = false, time = 0, start = 0;
      const title = h('b', { text: embed.target.split('/').pop() });
      const playBtn = h('button', { disabled: true }, '▶');
      const open = h('button', {}, t('embed-open'));
      const box = h('div', { class: 'fvs-embed' });
      box.append(h('style', { text: '.fvs-embed{position:relative;border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;background:#111}.fvs-embed iframe{display:block;width:100%;border:0;background:#111}.fvs-embed .bar{display:flex;gap:8px;align-items:center;padding:6px 10px;font-size:12px;color:var(--text-muted,#999);background:var(--bg-card,#1b1b1b)}.fvs-embed .bar b{color:var(--text,#eee);font-weight:600;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.fvs-embed button{font:inherit;border:1px solid var(--border,#333);background:none;color:inherit;border-radius:5px;padding:2px 8px;cursor:pointer}' }));
      box.append(h('div', { class: 'bar' }, playBtn, title, open));
      el.append(box);
      (async () => {
        let path = embed.target.replace(/^\/+/, '');
        if (!(await exists(path))) path = joinPath(dirOf(embed.pagePath || ''), embed.target);
        if (disposed || !(await exists(path))) return;
        open.onclick = () => app.openFile(path);
        const text = await app.readFile(path);
        const p = parseProject(text || '');
        title.textContent = p.meta.title || title.textContent;
        if (!(await trustList(ctx)).includes(path)) return; // untrusted scripts only run after "Run preview" in the editor
        const html = await previewHtml(p, path, assetLoader(ctx));
        if (disposed) return;
        frame = h('iframe', { sandbox: 'allow-scripts', title: p.meta.title || 'video', style: { aspectRatio: `${p.meta.width}/${p.meta.height}` } });
        frame.srcdoc = html;
        box.prepend(frame);
        const poster = p.scenes[1] ? p.scenes[1].t0 + .5 : 0;
        const post = x => frame.contentWindow && frame.contentWindow.postMessage({ fvs: 'seek', t: x }, '*');
        window.addEventListener('message', function ready(e) { if (e.source === frame.contentWindow && e.data && e.data.fvs === 'ready') { window.removeEventListener('message', ready); post(poster); playBtn.disabled = false; } });
        const tick = () => { if (disposed || !playing) return; time = (performance.now() - start) / 1000; if (time >= p.length) { playing = false; playBtn.textContent = '▶'; post(poster); return; } post(time); raf = requestAnimationFrame(tick); };
        playBtn.onclick = () => { playing = !playing; playBtn.textContent = playing ? '❚❚' : '▶'; if (playing) { start = performance.now() - (time >= p.length ? 0 : time) * 1000; tick(); } };
      })();
      return () => { disposed = true; cancelAnimationFrame(raf); box.remove(); };
    },
  });
}
