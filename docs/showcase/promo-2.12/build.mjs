// Inline the real Forsion assets into the promo studies page.
// Output: dist/index.html (artifact fragment) and dist/capture.html (standalone, for render.cjs).
import { readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '../../..');
const read = p => readFileSync(join(repo, p), 'utf8');

const jpeg = b64 => `data:image/jpeg;base64,${b64}`;
const avatars = read('tangu-agent/src/agents/builtinAvatars.ts');
const pick = key => avatars.match(new RegExp(`${key}: '([A-Za-z0-9+/=]+)'`))[1];
const arioso = read('tangu-agent/src/agents/defaultAvatar.ts').match(/['"`](\/9j[A-Za-z0-9+/=]+)['"`]/)[1];

const assets = {
  ARIA: jpeg(pick('aria')),
  RECITA: jpeg(pick('recita')),
  ARIOSO: jpeg(arioso),
  LOGO: `data:image/png;base64,${readFileSync(join(repo, 'desktop/build/icon.png')).toString('base64')}`,
};

// Special edition emblem: the logo's tree in the film's red, with no plate (logo/special.svg).
const tree = read('.github/assets/showcase/logo.svg').match(/fill="#bd866c" d="([^"]+)"/)[1].replace(/\s+/g, ' ').trim();
const special = readFileSync(join(here, 'logo/special.svg'), 'utf8').replace(/%%TREE%%/g, tree);
assets.EMBLEM = special.replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<\/svg>\s*$/, '');

const engine = readFileSync(join(here, 'stage-engine.js'), 'utf8');
const page = readFileSync(join(here, 'index.src.html'), 'utf8').replace('/*%%STAGE_ENGINE%%*/', () => engine).replace(/%%([A-Z]+)%%/g, (m, k) => {
  if (!assets[k]) throw new Error(`unknown asset ${m}`);
  return assets[k];
});

mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist/index.html'), page);
writeFileSync(join(here, 'dist/capture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>${page}</body></html>`);
console.log(`dist/index.html ${(page.length / 1024).toFixed(0)} KB`);

// Score listening page: reuses the shared fonts, styles, study B stage and engine from the studies page.
const cut = name => {
  const m = page.match(new RegExp(`<!-- ${name} -->([\\s\\S]*?)<!-- /${name} -->`));
  if (!m) throw new Error(`marker ${name} missing`);
  return m[1];
};
const style = page.match(/<style>[\s\S]*?<\/style>/)[0];
const music = readFileSync(join(here, 'music.src.html'), 'utf8')
  .replace('%%FONTS%%', () => cut('fonts'))
  .replace('%%STYLE%%', () => style)
  .replace('%%STAGE_B%%', () => cut('stage:b'))
  .replace('%%ENGINE%%', () => cut('engine'));
writeFileSync(join(here, 'dist/music.html'), music);
// local preview: the page expects the score MP3s next to it (render them with music/make.py + music/mux.sh)
const score = join(here, 'out/score');
if (existsSync(score)) {
  mkdirSync(join(here, 'dist/audio'), { recursive: true });
  for (const f of readdirSync(score)) if (f.endsWith('.mp3')) copyFileSync(join(score, f), join(here, 'dist/audio', f));
}
console.log(`dist/music.html ${(music.length / 1024).toFixed(0)} KB`);

// Full film (study B): shared fonts, styles and engine, the cue sheet, and the real assets.
const cues = readFileSync(join(here, 'film/cuesheet.json'), 'utf8').trim();
assets.LEN = String(JSON.parse(cues).length);
assets.SECONDS = String(Math.round(JSON.parse(cues).length));
const film = readFileSync(join(here, 'film.src.html'), 'utf8')
  .replace('%%FONTS%%', () => cut('fonts'))
  .replace('%%STYLE%%', () => style)
  .replace('/*%%STAGE_ENGINE%%*/', () => engine)
  .replace('/*%%CUES%%*/', () => cues)
  .replace(/%%([A-Z]+)%%/g, (m, k) => {
    if (!assets[k]) throw new Error(`unknown asset ${m}`);
    return assets[k];
  });
writeFileSync(join(here, 'dist/film.html'), film);
writeFileSync(join(here, 'dist/logo-2.12-special.svg'), special);
writeFileSync(join(here, 'dist/film-capture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>${film}</body></html>`);
console.log(`dist/film.html ${(film.length / 1024).toFixed(0)} KB`);
