// Render each study to MP4 frame by frame (deterministic: the page exposes __stage.seek(t)).
// Usage: NODE_PATH=$(npm root -g) node render.cjs [a b c film] [--fps 30] [--dur 6.5] [--workers 3] [--frames-only] [--range 88,91.2]
// Needs: playwright, CJK fonts installed locally (Noto Serif SC / Noto Sans SC), an ffmpeg with libx264 (FFMPEG env or PATH).
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const { mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const fpsAt = args.indexOf('--fps');
const fps = fpsAt >= 0 ? +args.splice(fpsAt, 2)[1] : 30;
const durAt = args.indexOf('--dur');
const durOverride = durAt >= 0 ? +args.splice(durAt, 2)[1] : null;
const wAt = args.indexOf('--workers');
const workers = wAt >= 0 ? +args.splice(wAt, 2)[1] : 1;
const foAt = args.indexOf('--frames-only');
const framesOnly = foAt >= 0 && !!args.splice(foAt, 1);
const rAt = args.indexOf('--range');  // re-render only these seconds into the existing frames folder
const range = rAt >= 0 ? args.splice(rAt, 2)[1].split(',').map(Number) : null;
const ids = args.length ? args : ['a', 'b', 'c'];
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const out = path.join(__dirname, 'out');
const names = { a: 'A-the-other-half', b: 'B-episode-2.12', c: 'C-collaboration-evolves', film: 'B-full-film' };
const pageFor = id => (id === 'film' ? 'dist/film-capture.html' : 'dist/capture.html');

(async () => {
  const browser = await chromium.launch();
  for (const id of ids) {
    const frames = path.join(out, `frames-${id}`);
    if (!range) rmSync(frames, { recursive: true, force: true });
    mkdirSync(frames, { recursive: true });
    const open = async () => {
      const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
      // Google Fonts is unreachable offline; the same families are installed locally.
      await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
      await page.route(/\.mp3$/, r => r.abort());
      await page.goto(`file://${path.join(__dirname, pageFor(id))}?capture=${id}`);
      const st = await page.evaluate(async () => { await document.fonts.ready; return window.__stage; });
      await page.setViewportSize({ width: st.w, height: st.h });
      return { page, st };
    };
    const pages = await Promise.all([...Array(workers)].map(open));
    const total = Math.round((durOverride || pages[0].st.dur) * fps);
    // every frame is a pure function of t, so workers can take interleaved frames
    await Promise.all(pages.map(async ({ page }, k) => {
      const [f0, f1] = range ? [Math.ceil(range[0] * fps), Math.min(total, Math.floor(range[1] * fps))] : [0, total];
      for (let f = f0 + k; f <= f1; f += workers) {
        await page.evaluate(t => window.__stage.seek(t), f / fps);
        await page.screenshot({ path: path.join(frames, `${String(f).padStart(5, '0')}.png`) });
      }
      await page.close();
    }));
    if (framesOnly) { console.log(`${id}: ${total + 1} frames → ${frames}`); continue; }
    const file = path.join(out, `forsion-2.12-${names[id]}${durOverride ? `-${durOverride}s` : ''}.mp4`);
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, '%05d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
    console.log(`${id}: ${total + 1} frames → ${file}`);
  }
  await browser.close();
})();
