// Render each study to MP4 frame by frame (deterministic: the page exposes __stage.seek(t)).
// Usage: NODE_PATH=$(npm root -g) node render.cjs [a b c] [--fps 30]
// Needs: playwright, CJK fonts installed locally (Noto Serif SC / Noto Sans SC), an ffmpeg with libx264 (FFMPEG env or PATH).
const { chromium } = require('playwright');
const { execFileSync } = require('node:child_process');
const { mkdirSync, rmSync } = require('node:fs');
const path = require('node:path');

const args = process.argv.slice(2);
const fpsAt = args.indexOf('--fps');
const fps = fpsAt >= 0 ? +args.splice(fpsAt, 2)[1] : 30;
const ids = args.length ? args : ['a', 'b', 'c'];
const ffmpeg = process.env.FFMPEG || 'ffmpeg';
const out = path.join(__dirname, 'out');
const names = { a: 'A-the-other-half', b: 'B-episode-2.12', c: 'C-collaboration-evolves' };

(async () => {
  const browser = await chromium.launch();
  for (const id of ids) {
    const frames = path.join(out, `frames-${id}`);
    rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    // Google Fonts is unreachable offline; the same families are installed locally.
    await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
    await page.goto(`file://${path.join(__dirname, 'dist/capture.html')}?capture=${id}`);
    const { w, h, dur } = await page.evaluate(async () => { await document.fonts.ready; return window.__stage; });
    await page.setViewportSize({ width: w, height: h });
    const total = Math.round(dur * fps);
    for (let f = 0; f <= total; f++) {
      await page.evaluate(t => window.__stage.seek(t), f / fps);
      await page.screenshot({ path: path.join(frames, `${String(f).padStart(5, '0')}.png`) });
    }
    await page.close();
    const file = path.join(out, `forsion-2.12-${names[id]}.mp4`);
    execFileSync(ffmpeg, ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', path.join(frames, '%05d.png'),
      '-c:v', 'libx264', '-preset', 'slow', '-crf', '16', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', file]);
    console.log(`${id}: ${total + 1} frames → ${file}`);
  }
  await browser.close();
})();
