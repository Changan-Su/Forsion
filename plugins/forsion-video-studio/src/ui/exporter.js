// "Export web video": one standalone .html next to the project. Assets are inlined when the host can read
// bytes, so the file plays anywhere (double-click, a browser, a web host); otherwise they stay relative.
import { compile, buildHtml } from '../lib/compile.js';
import RUNTIME from '../generated/runtime-src.js';
import { dirOf, joinPath } from './util.js';

export async function exportHtml(ctx, p, path, assets) {
  const dir = dirOf(path);
  const probe = compile(p);
  const refs = [...Object.keys(probe.assets), ...probe.audio.map(a => a.src)];
  const inline = !!(ctx.app && ctx.app.readBytes);
  if (inline) await Promise.all(refs.map(rel => assets.get(joinPath(dir, rel))));
  const resolve = rel => {
    const u = inline ? assets.cache.get(joinPath(dir, rel)) : null;
    return u && u.startsWith('data:') ? u : rel;
  };
  const html = buildHtml(compile(p, { resolve }), RUNTIME, { mode: 'player' });
  const out = path.replace(/\.fvs\.md$/i, '') + '.html';
  await ctx.app.writeFile(out, html);
  return out;
}
