// Inline the real Forsion assets into the promo studies page.
// Output: dist/index.html (artifact fragment) and dist/capture.html (standalone, for render.cjs).
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
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

const page = readFileSync(join(here, 'index.src.html'), 'utf8').replace(/%%([A-Z]+)%%/g, (m, k) => {
  if (!assets[k]) throw new Error(`unknown asset ${m}`);
  return assets[k];
});

mkdirSync(join(here, 'dist'), { recursive: true });
writeFileSync(join(here, 'dist/index.html'), page);
writeFileSync(join(here, 'dist/capture.html'), `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"></head><body>${page}</body></html>`);
console.log(`dist/index.html ${(page.length / 1024).toFixed(0)} KB`);
