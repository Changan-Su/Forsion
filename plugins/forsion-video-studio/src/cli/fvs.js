// fvs — the Forsion Video Studio command line. Single file, no install needed except for `render`,
// `still`, `sheet` and `check --runtime` (a Chromium through playwright-core) and ffmpeg (render, sync).
import { readFileSync, writeFileSync, mkdirSync, existsSync, rmSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve, relative, basename, extname, sep, posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tmpdir, homedir, platform } from 'node:os';
import { spawnSync, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { parseProject, cueSheet, sceneById, formatLength } from '../lib/project.js';
import { compile, buildHtml, audioTracks } from '../lib/compile.js';
import { onsetEnvelope, syncReport, ONSET_SR } from '../lib/onsets.js';
import { TEMPLATES } from '../lib/templates.js';
import RUNTIME from '../generated/runtime-src.js';

const VERSION = '0.1.0';
const HELP = `fvs ${VERSION} — Forsion Video Studio

  fvs new <file.fvs.md> [--template eva|blank] [--title T]   start a project
  fvs info <file>                      scenes, times, hits (read this before editing)
  fvs check <file> [--runtime]         parse errors; --runtime also runs every scene script in a browser
  fvs cues <file> [--out cues.json]    the cue sheet a score is written against (JSON)
  fvs html <file> [--out f.html] [--inline]   standalone web video (player page)
  fvs still <file> --at <t|scene[:hit]> [--out f.png] [--scale 0.5]   one frame as PNG
  fvs sheet <file> [--scenes | --every <sec>] [--out sheet.png]       contact sheet of frames
  fvs render <file> [--out f.mp4] [--from s] [--to s] [--scale 0.5] [--workers 3] [--crf 18]
                    [--keep-frames dir] [--no-audio]                 MP4 with the project's audio
  fvs sync <file> [--audio a.mp3]      do the hits land on accents of the score?

  Times: 12.5 (seconds), scene id (its start), scene:3 (its hit 3).
  Browser: playwright-core (npm i -g playwright-core) + Chrome/Edge, or FVS_CHROMIUM=/path/to/chrome.
  ffmpeg: on PATH, or FFMPEG=/path/to/ffmpeg.`;

/* ───────── args ───────── */
const argv = process.argv.slice(2);
const cmd = argv.shift();
const flags = {}, pos = [];
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith('--')) {
    const [k, v] = a.slice(2).split('=');
    if (v !== undefined) flags[k] = v;
    else if (argv[i + 1] !== undefined && !argv[i + 1].startsWith('--')) flags[k] = argv[++i];
    else flags[k] = true;
  } else pos.push(a);
}
const die = (msg, code = 1) => { console.error(msg); process.exit(code); };
const log = (...a) => console.log(...a);

function load(file) {
  if (!file) die('which project? (fvs <command> <file.fvs.md>)');
  const path = resolve(file);
  if (!existsSync(path)) die(`no such file: ${path}`);
  const text = readFileSync(path, 'utf8');
  return { path, dir: dirname(path), text, p: parseProject(text) };
}
function report(p, { fail = true } = {}) {
  const errs = p.errors.filter(e => e.level === 'error'), warns = p.errors.filter(e => e.level !== 'error');
  for (const e of [...errs, ...warns]) console.error(`${e.level === 'error' ? 'error' : 'warn '} line ${e.line}${e.scene ? ` [${e.scene}]` : ''}: ${e.message}`);
  if (errs.length && fail && !flags.force) die(`${errs.length} error(s); fix them or pass --force`);
}
const fileUrl = (dir, rel) => pathToFileURL(join(dir, rel)).href;

/** A time on the command line: seconds, a scene id, or scene:hit. */
function timeArg(p, v) {
  if (v === undefined || v === true) return null;
  if (/^-?\d+(\.\d+)?$/.test(String(v))) return +v;
  const [id, h] = String(v).split(':');
  const s = sceneById(p, id);
  if (!s) die(`no scene "${id}" (scenes: ${p.scenes.map(x => x.id).join(', ')})`);
  if (h === undefined) return s.t0;
  if (!(+h < s.hitTimes.length)) die(`scene "${id}" has ${s.hitTimes.length} hits`);
  return s.hitTimes[+h];
}

/* ───────── browser & ffmpeg ───────── */
async function chromium() {
  const req = createRequire(join(process.cwd(), 'x.js'));
  const tries = ['playwright-core', 'playwright'];
  let pw = null;
  for (const m of tries) {
    for (const load of [() => import(m), () => req(m), () => createRequire(import.meta.url)(m), () => globalRequire(m)]) {
      try { pw = await load(); if (pw && (pw.chromium || (pw.default && pw.default.chromium))) break; pw = null; } catch { /* next */ }
    }
    if (pw) break;
  }
  if (!pw) die('This command needs a browser driver. Install one:  npm i -g playwright-core   (or run inside a folder with playwright installed)');
  const { chromium: C } = pw.chromium ? pw : pw.default;
  const exe = process.env.FVS_CHROMIUM || flags.browser;
  const attempts = [];
  if (exe) attempts.push({ executablePath: exe });
  attempts.push({}, { channel: 'chrome' }, { channel: 'msedge' }, { channel: 'chromium' });
  for (const p of knownBrowsers()) attempts.push({ executablePath: p });
  let lastErr;
  for (const opt of attempts) {
    try { return await C.launch({ ...opt, args: ['--force-color-profile=srgb', '--font-render-hinting=none', '--hide-scrollbars'] }); } catch (e) { lastErr = e; }
  }
  die(`Could not start a Chromium-based browser (${String(lastErr && lastErr.message || lastErr).split('\n')[0]}).\nInstall Google Chrome or Microsoft Edge, or run: npx playwright install chromium, or set FVS_CHROMIUM=/path/to/chrome`);
}
function globalRequire(m) {
  const root = spawnSync(platform() === 'win32' ? 'npm.cmd' : 'npm', ['root', '-g'], { encoding: 'utf8', shell: platform() === 'win32' }).stdout.trim();
  return createRequire(join(root, 'x.js'))(m);
}
function knownBrowsers() {
  const P = platform(), h = homedir();
  const list = P === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge', '/Applications/Chromium.app/Contents/MacOS/Chromium', `${h}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`]
    : P === 'win32'
      ? [`${process.env['PROGRAMFILES'] || 'C:\\Program Files'}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)'}\\Microsoft\\Edge\\Application\\msedge.exe`, `${process.env.LOCALAPPDATA || ''}\\Google\\Chrome\\Application\\chrome.exe`]
      : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/opt/pw-browsers/chromium/chrome-linux/chrome', '/snap/bin/chromium'];
  return list.filter(p => { try { return existsSync(p); } catch { return false; } });
}
function ffmpegBin() {
  const cands = [flags.ffmpeg, process.env.FFMPEG, 'ffmpeg'].filter(Boolean);
  for (const c of cands) if (spawnSync(c, ['-version'], { stdio: 'ignore' }).status === 0) return c;
  for (const py of ['python3', 'python']) {
    const r = spawnSync(py, ['-c', 'import imageio_ffmpeg;print(imageio_ffmpeg.get_ffmpeg_exe())'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.trim()) return r.stdout.trim();
  }
  die('ffmpeg not found. Install it (macOS: brew install ffmpeg · Windows: winget install ffmpeg · Linux: apt install ffmpeg) or set FFMPEG=/path/to/ffmpeg');
}

/** Open the project's capture page: the stage at 1:1, window.__stage.seek(t). */
async function openStage(ctx, browser, { scale = 1 } = {}) {
  const tmp = mkdtempSync(join(tmpdir(), 'fvs-'));
  const payload = compile(ctx.p, { resolve: rel => fileUrl(ctx.dir, rel) });
  const html = buildHtml(payload, RUNTIME, { mode: 'capture' });
  const page = join(tmp, 'capture.html');
  writeFileSync(page, html);
  const pg = await browser.newPage({ viewport: { width: payload.width, height: payload.height }, deviceScaleFactor: scale });
  const logs = [];
  pg.on('pageerror', e => logs.push(String(e.message || e)));
  if (flags['no-remote-fonts']) await pg.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
  await pg.route(/\.(mp3|wav|m4a|ogg|aac|flac)(\?|$)/i, r => r.abort());
  await pg.goto(pathToFileURL(page).href);
  const st = await pg.evaluate(async () => { await Promise.race([window.__stage.ready(), new Promise(r => setTimeout(r, 15000))]); return { w: __stage.w, h: __stage.h, dur: __stage.dur, fps: __stage.fps, errors: __stage.errors }; });
  return { pg, st, tmp, payload, logs };
}
function runtimeErrors(st, logs) {
  for (const e of st.errors) console.error(`error line ${e.line || '?'} [${e.scene}]: ${e.message}`);
  for (const l of logs) console.error(`page error: ${l}`);
  return st.errors.length + logs.length;
}

/* ───────── commands ───────── */
const commands = {
  async new() {
    const file = pos[0] || die('fvs new <file.fvs.md>');
    const path = resolve(file.endsWith('.fvs.md') ? file : `${file}.fvs.md`);
    if (existsSync(path) && !flags.force) die(`${path} exists (pass --force to overwrite)`);
    const tpl = TEMPLATES[flags.template || 'eva'] || die(`templates: ${Object.keys(TEMPLATES).join(', ')}`);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, tpl({ title: flags.title || basename(path, '.fvs.md'), zh: flags.lang !== 'en' }));
    log(path);
  },

  async info() {
    const { p } = load(pos[0]);
    report(p, { fail: false });
    const tp = p.tempo;
    log(`${p.meta.title || '(untitled)'} · ${p.meta.width}×${p.meta.height} @ ${p.meta.fps} fps · ${p.length.toFixed(2)} s${tp ? ` · ${tp.bpm} BPM ${tp.beatsPerBar}/4 (beat ${tp.beat.toFixed(3)} s, bar ${tp.bar.toFixed(3)} s)` : ''}`);
    for (const a of audioTracks(p.meta)) log(`audio ${a.role}: ${a.src}${a.at ? ` at ${a.at}s` : ''}${a.gain ? ` ${a.gain} dB` : ''}`);
    log('');
    log(`${'#'.padStart(3)}  ${'id'.padEnd(14)} ${'start'.padStart(7)} ${'end'.padStart(7)}  ${'length'.padEnd(10)} hits (${tp ? 'beats' : 's'} from scene start → absolute s)`);
    for (const s of p.scenes) {
      log(`${String(s.index + 1).padStart(3)}  ${s.id.padEnd(14)} ${s.t0.toFixed(2).padStart(7)} ${s.t1.toFixed(2).padStart(7)}  ${String(s.meta.length ?? '?').padEnd(10)} ${s.hits.map((h, i) => `${h}→${s.hitTimes[i].toFixed(2)}`).join('  ')}${s.title ? `   # ${s.title}` : ''}`);
    }
  },

  async check() {
    const ctx = load(pos[0]);
    report(ctx.p, { fail: false });
    let n = ctx.p.errors.filter(e => e.level === 'error').length;
    if (flags.runtime) {
      const browser = await chromium();
      const { st, logs } = await openStage(ctx, browser);
      n += runtimeErrors(st, logs);
      await browser.close();
    }
    if (n) die(`${n} error(s)`);
    log(`ok · ${ctx.p.scenes.length} scenes · ${ctx.p.length.toFixed(2)} s${flags.runtime ? ' · scripts ran clean' : ''}`);
  },

  async cues() {
    const { p } = load(pos[0]);
    report(p, { fail: false });
    const out = JSON.stringify(cueSheet(p), null, 2);
    if (flags.out) { writeFileSync(resolve(flags.out), out + '\n'); log(resolve(flags.out)); } else log(out);
  },

  async html() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const out = resolve(flags.out || ctx.path.replace(/\.fvs\.md$/i, '') + '.html');
    const outDir = dirname(out);
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' };
    const resolveUrl = rel => {
      const abs = join(ctx.dir, rel);
      if (flags.inline && existsSync(abs)) return `data:${mime[extname(abs).toLowerCase()] || 'application/octet-stream'};base64,${readFileSync(abs).toString('base64')}`;
      return relative(outDir, abs).split(sep).join('/');
    };
    const payload = compile(ctx.p, { resolve: resolveUrl });
    writeFileSync(out, buildHtml(payload, RUNTIME, { mode: 'player' }));
    log(`${out} (${(statSync(out).size / 1024).toFixed(0)} KB)`);
  },

  async still() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const t = timeArg(ctx.p, flags.at) ?? 0;
    const browser = await chromium();
    const { pg, st, logs } = await openStage(ctx, browser, { scale: +flags.scale || 1 });
    runtimeErrors(st, logs);
    await pg.evaluate(x => __stage.seek(x), t);
    const out = resolve(flags.out || `${ctx.path.replace(/\.fvs\.md$/i, '')}-${t.toFixed(2)}s.png`);
    await pg.screenshot({ path: out });
    await browser.close();
    log(out);
  },

  async sheet() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const p = ctx.p;
    let times;
    if (flags.every) { const d = +flags.every; times = []; for (let t = 0; t < p.length; t += d) times.push(t); }
    else times = p.scenes.map(s => Math.min(s.t1 - .05, (s.hitTimes.length ? s.hitTimes[s.hitTimes.length - 1] : s.t0) + .5));
    const labels = flags.every ? times.map(t => `${t.toFixed(1)}s`) : p.scenes.map(s => `${s.id} · ${s.t0.toFixed(1)}s`);
    const browser = await chromium();
    const scale = 320 / p.meta.width;
    const { pg, st, logs } = await openStage(ctx, browser, { scale });
    runtimeErrors(st, logs);
    const shots = [];
    for (const t of times) { await pg.evaluate(x => __stage.seek(x), t); shots.push((await pg.screenshot({ type: 'jpeg', quality: 80 })).toString('base64')); }
    const cols = Math.min(6, Math.ceil(Math.sqrt(shots.length * 1.4)));
    const sheet = await browser.newPage({ viewport: { width: cols * 332 + 12, height: 400 } });
    await sheet.setContent(`<body style="margin:0;background:#111;color:#bbb;font:12px sans-serif"><div style="display:grid;grid-template-columns:repeat(${cols},320px);gap:12px;padding:12px">${shots.map((b, i) => `<figure style="margin:0"><img style="display:block;width:320px" src="data:image/jpeg;base64,${b}"><figcaption style="padding-top:4px">${labels[i]}</figcaption></figure>`).join('')}</div></body>`);
    const out = resolve(flags.out || `${ctx.path.replace(/\.fvs\.md$/i, '')}-sheet.png`);
    await sheet.screenshot({ path: out, fullPage: true });
    await browser.close();
    log(out);
  },

  async render() {
    const ctx = load(pos[0]);
    report(ctx.p);
    const p = ctx.p, fps = +flags.fps || +p.meta.fps;
    const from = timeArg(p, flags.from) ?? 0, to = Math.min(p.length, timeArg(p, flags.to) ?? p.length);
    const out = resolve(flags.out || ctx.path.replace(/\.fvs\.md$/i, '') + '.mp4');
    const ff = ffmpegBin();
    const frames = flags['keep-frames'] ? resolve(flags['keep-frames']) : mkdtempSync(join(tmpdir(), 'fvs-frames-'));
    rmSync(frames, { recursive: true, force: true }); mkdirSync(frames, { recursive: true });
    const browser = await chromium();
    const workers = Math.max(1, Math.min(8, +flags.workers || 3));
    const stages = await Promise.all([...Array(workers)].map(() => openStage(ctx, browser)));
    if (runtimeErrors(stages[0].st, stages[0].logs) && !flags.force) { await browser.close(); die('scene scripts failed (see above); fix them or pass --force'); }
    const f0 = Math.round(from * fps), f1 = Math.max(f0, Math.round(to * fps) - 1);
    const total = f1 - f0 + 1;
    let done = 0, lastPct = -1;
    const t0 = Date.now();
    await Promise.all(stages.map(async ({ pg }, k) => {
      for (let f = f0 + k; f <= f1; f += workers) {
        await pg.evaluate(t => __stage.seek(t), f / fps);
        await pg.screenshot({ path: join(frames, `${String(f - f0).padStart(6, '0')}.png`) });
        done++;
        const pct = Math.floor(done / total * 20) * 5;
        if (pct !== lastPct) { lastPct = pct; log(`frames ${pct}% (${done}/${total}, ${((Date.now() - t0) / 1000).toFixed(0)} s)`); }
      }
    }));
    await browser.close();
    const args = ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(frames, '%06d.png')];
    const tracks = flags['no-audio'] ? [] : audioTracks(p.meta).filter(a => existsSync(join(ctx.dir, a.src)));
    for (const a of audioTracks(p.meta)) if (!existsSync(join(ctx.dir, a.src))) console.error(`warn audio not found, skipped: ${a.src}`);
    tracks.forEach(a => args.push('-i', join(ctx.dir, a.src)));
    const vf = +flags.scale && +flags.scale !== 1 ? ['-vf', `scale=trunc(iw*${+flags.scale}/2)*2:-2:flags=lanczos`] : [];
    if (tracks.length) {
      const parts = tracks.map((a, i) => {
        const shift = a.at - from;
        const trim = shift < 0 ? `atrim=start=${-shift},asetpts=PTS-STARTPTS,` : '';
        const delay = shift > 0 ? `adelay=${Math.round(shift * 1000)}:all=1,` : '';
        return `[${i + 1}:a]${trim}${delay}volume=${a.gain || 0}dB[a${i}]`;
      });
      const mix = tracks.length > 1 ? `;${tracks.map((_, i) => `[a${i}]`).join('')}amix=inputs=${tracks.length}:normalize=0[aout]` : '';
      args.push('-filter_complex', parts.join(';') + mix, '-map', '0:v', '-map', tracks.length > 1 ? '[aout]' : '[a0]', '-c:a', 'aac', '-b:a', flags.abr || '256k');
    }
    args.push(...vf, '-c:v', 'libx264', '-preset', flags.preset || 'slow', '-crf', String(flags.crf || 18), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-t', String(total / fps), out);
    const r = spawnSync(ff, args, { stdio: 'inherit' });
    if (!flags['keep-frames']) rmSync(frames, { recursive: true, force: true });
    if (r.status !== 0) die('ffmpeg failed');
    log(`${out} · ${total} frames · ${(total / fps).toFixed(2)} s · ${(statSync(out).size / 1048576).toFixed(1)} MB`);
  },

  async sync() {
    const { p, dir } = load(pos[0]);
    report(p, { fail: false });
    const tracks = audioTracks(p.meta);
    const src = flags.audio ? resolve(flags.audio) : tracks[0] && join(dir, tracks[0].src);
    if (!src || !existsSync(src)) die('no audio to check against (add one to the project\'s "audio" or pass --audio)');
    const at = flags.audio ? 0 : tracks[0].at || 0;
    const ff = ffmpegBin();
    const r = spawnSync(ff, ['-v', 'error', '-i', src, '-ac', '1', '-ar', String(ONSET_SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    if (r.status !== 0) die(`ffmpeg could not decode ${src}`);
    const buf = r.stdout;
    const pcm = new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 4));
    const lead = new Float32Array(Math.round(at * ONSET_SR));
    const mono = at > 0 ? Float32Array.from([...lead, ...pcm]) : pcm;
    const rows = syncReport(p.scenes, onsetEnvelope(mono, ONSET_SR));
    let bad = 0;
    for (const x of rows) {
      const flag = x.ok ? (x.quiet ? 'cut to quiet' : '') : '<< weak accent';
      if (!x.ok) bad++;
      if (!x.ok || flags.all) log(`${x.t.toFixed(2).padStart(7)}s  ${x.scene}:h${x.hit}  accent ${x.strength.toFixed(2)}  ${x.offset == null ? '' : `${x.offset >= 0 ? '+' : ''}${Math.round(x.offset * 1000)} ms`}  ${flag}`);
    }
    log(`${rows.length} hits, ${rows.length - bad} land on an accent${bad ? `, ${bad} do not (listed above)` : ''}`);
  },
};

if (!cmd || cmd === 'help' || flags.help || !commands[cmd]) { log(HELP); process.exit(cmd && !commands[cmd] && cmd !== 'help' ? 1 : 0); }
commands[cmd]().catch(e => die(e && e.stack || String(e)));
