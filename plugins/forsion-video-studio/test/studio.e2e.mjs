// End-to-end test of the Studio in Chromium against the mock host (test/host): open the bundled example,
// edit text in the picture, drag a cut, undo, export HTML, hand off to the agent, reload an external edit.
//   NODE_PATH=$(npm root -g) node test/studio.e2e.mjs [--shots dir]
import { readFileSync, readdirSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const require = createRequire(join(process.cwd(), 'x.js'));
const { chromium } = (() => { for (const m of ['playwright', 'playwright-core']) { try { return require(m); } catch { /* next */ } } throw new Error('needs playwright'); })();
const shotsAt = process.argv.indexOf('--shots');
const shots = shotsAt > 0 ? process.argv[shotsAt + 1] : null;
if (shots) mkdirSync(shots, { recursive: true });
const shot = async (page, name) => { if (shots) await page.screenshot({ path: join(shots, `${name}.png`) }); };

const ORIGIN = 'http://fvs.test';
const EX = join(root, 'examples/episode-2.12');
const DIR = 'Videos/第 2.12 话';
const FILE = `${DIR}/episode-2.12.fvs.md`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1480, height: 920 } });
const errors = [];
page.on('pageerror', e => errors.push(String(e)));
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
await page.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
await page.route(`${ORIGIN}/**`, async r => {
  const u = new URL(r.request().url());
  if (u.pathname === '/host.html' || u.pathname === '/host.js') return r.fulfill({ path: join(here, 'host', u.pathname.slice(1)) });
  if (u.pathname.startsWith('/vault/')) {
    const p = decodeURIComponent(u.pathname.slice(7));
    const buf = await page.evaluate(q => { const v = HOST.files.get(q); return v ? Array.from(typeof v === 'string' ? new TextEncoder().encode(v) : v) : null; }, p);
    return buf ? r.fulfill({ body: Buffer.from(buf), contentType: p.endsWith('.mp3') ? 'audio/mpeg' : 'application/octet-stream' }) : r.fulfill({ status: 404 });
  }
  return r.fulfill({ status: 404 });
});
await page.goto(`${ORIGIN}/host.html`);

// the vault: the example project, its images and its score
const put = async (p, bytes) => page.evaluate(([q, b]) => HOST.files.set(q, new Uint8Array(b)), [p, Array.from(bytes)]);
await page.evaluate(([p, t]) => HOST.files.set(p, t), [FILE, readFileSync(join(EX, 'episode-2.12.fvs.md'), 'utf8')]);
for (const f of readdirSync(join(EX, 'assets'))) await put(`${DIR}/assets/${f}`, readFileSync(join(EX, 'assets', f)));
await put(`${DIR}/audio/episode-2.12-score.mp3`, readFileSync(join(EX, 'audio/episode-2.12-score.mp3')));
await page.evaluate(src => HOST.load(src), readFileSync(join(root, 'main.js'), 'utf8'));
const reg = await page.evaluate(() => Object.fromEntries(Object.entries(HOST.reg).map(([k, v]) => [k, v.map(x => x.id)])));
assert.deepEqual(reg.fileTypes, ['project']);

// 1. an untrusted project shows the gate, not a preview
await page.evaluate(p => HOST.open(p), FILE);
await page.waitForSelector('.fvs-gate');
assert.equal(await page.locator('.fvs-view iframe').count(), 0, 'no preview before trust');
await shot(page, '01-gate');
await page.click('.fvs-gate button');
const ready = async () => page.waitForFunction(() => { const f = document.querySelector('.fvs-view iframe'); return f && !f.classList.contains('fvs-pending') && !document.querySelector('.fvs-view iframe.fvs-pending'); }, null, { timeout: 20000 });
await ready();
assert.ok((await page.evaluate(() => HOST.data.trusted)).includes(FILE), 'trust remembered');
assert.equal(await page.locator('.fvs-clip').count(), 20, '20 scenes on the timeline');
await page.waitForFunction(() => /拍点/.test(document.querySelector('.fvs-sync-sum')?.textContent || ''), null, { timeout: 30000 });
const syncSum = await page.textContent('.fvs-sync-sum');
console.log('sync summary:', syncSum);
await shot(page, '02-open');

// 2. select the cards scene and seek into its fourth card
await page.click('.fvs-clip[data-id="cards"] .nm', { force: true });
await page.click('.fvs-clip[data-id="cards"]', { position: { x: 5, y: 10 } });
assert.equal(await page.inputValue('[data-key="sid"]'), 'cards');
await page.locator('.fvs-studio').focus();
const cards = await page.evaluate(() => { const c = document.querySelector('.fvs-clip[data-id="cards"]').getBoundingClientRect(); return c; });
const hits = page.locator('.fvs-clip[data-id="cards"] .fvs-hitm');
assert.equal(await hits.count(), 8);
await hits.nth(3).click();
await page.waitForTimeout(300);
await shot(page, '03-card4');

// 3. double-click the big word in the picture and change it
const view = await page.locator('.fvs-view').boundingBox();
const before = await page.evaluate(p => HOST.text(p), FILE);
// card 4 (工具) sits right-aligned at the top; its glyphs cover the frame's upper right
const fr = { x: view.x + (view.width - view.height * 4 / 3) / 2, w: view.height * 4 / 3, y: view.y, h: view.height };
await page.mouse.dblclick(fr.x + fr.w * .72, fr.y + fr.h * .33);
await page.waitForSelector('.fvs-inline textarea', { timeout: 5000 });
assert.equal(await page.inputValue('.fvs-inline textarea'), '工具');
await page.fill('.fvs-inline textarea', '工具箱');
await page.keyboard.press('Enter');
await page.waitForTimeout(900);
const after = await page.evaluate(p => HOST.text(p), FILE);
assert.notEqual(after, before);
assert.equal(after.replace('>工具箱<', '>工具<'), before, 'only that text changed, byte for byte elsewhere');
await ready();
await shot(page, '04-edited');

// 4. undo restores the file
await page.locator('.fvs-studio').focus();
await page.keyboard.press('Control+z');
await page.waitForTimeout(900);
assert.equal(await page.evaluate(p => HOST.text(p), FILE), before, 'undo restores the file');

// 5. drag the end of "years" one bar left: a roll edit (half grows, later cuts stay)
await page.selectOption('.fvs-tl-bar select', 'bar');
const edge = await page.locator('.fvs-clip[data-id="years"] .edge').boundingBox();
const zoom = await page.evaluate(() => { const c = document.querySelector('.fvs-clip[data-id="cards"]'); return c.getBoundingClientRect().width / 6.4; });
await page.mouse.move(edge.x + 4, edge.y + 20);
await page.mouse.down();
await page.mouse.move(edge.x + 4 - 1.6 * zoom, edge.y + 20, { steps: 8 });
await page.mouse.up();
await page.waitForTimeout(900);
const rolled = await page.evaluate(p => HOST.text(p), FILE);
assert.ok(rolled.includes('{ "length": "1 bar", "hits": [0, 2, 4, 6] }') || rolled.includes('"length": "1 bar"'), 'years is one bar');
assert.ok(rolled.includes('{ "length": "3 bars", "hits": [4, 7], "class": "hud" }'), `half grew and kept its hit times: ${rolled.match(/## half[\s\S]*?```fvs\n(.*)\n/)[1]}`);
await page.keyboard.press('Control+z');
await page.waitForTimeout(700);
assert.equal(await page.evaluate(p => HOST.text(p), FILE), before);

// 6. the text panel edits the same runs; AI rewrite goes through ctx.tangu.complete
await page.click('[data-tab="text"]');
await page.click('.fvs-clip[data-id="years"]', { position: { x: 5, y: 10 } });
const first = page.locator('.fvs-text-item textarea').first();
assert.equal(await first.inputValue(), '多年来，');
await page.locator('.fvs-text-item .fvs-link').first().click();
await page.waitForSelector('.fvs-suggest .fvs-btn.primary');
await page.click('.fvs-suggest .fvs-btn.primary');
await page.waitForTimeout(900);
assert.ok((await page.evaluate(p => HOST.text(p), FILE)).includes('data-in="h0">多年来，！</span>'));
await shot(page, '05-text-tab');
await page.locator('.fvs-studio').focus();
await page.keyboard.press('Control+z');
await page.waitForTimeout(600);

// 7. export a web video; it plays on its own without errors
await page.click('.fvs-bar button:has-text("导出")');
await page.click('.fvs-menu button:has-text("导出网页视频")');
await page.waitForFunction(p => HOST.files.has(p), `${DIR}/episode-2.12.html`, { timeout: 20000 });
const html = await page.evaluate(p => HOST.text(p), `${DIR}/episode-2.12.html`);
assert.ok(html.length > 2e6, 'assets and score are inlined');
if (shots) writeFileSync(join(shots, 'export.html'), html);
const player = await browser.newPage({ viewport: { width: 1200, height: 900 } });
const perr = [];
player.on('pageerror', e => perr.push(String(e)));
await player.route(/fonts\.(googleapis|gstatic)\.com/, r => r.abort());
await player.setContent(html, { waitUntil: 'load' });
await player.waitForSelector('.fvs-chapters button');
await player.click('.fvs-chapters button:has-text("MAGI")');
await player.waitForTimeout(1500);
await player.click('.fvs-play');
assert.equal(perr.length, 0, perr.join('\n'));
if (shots) await player.screenshot({ path: join(shots, '06-export-player.png') });
await player.close();

// 8. hand-offs start a visible conversation with the bundled agent
await page.click('.fvs-bar button:has-text("问 AI")');
await page.fill('.fvs-pop textarea', '把「标题卡」的最后一张改成三行');
await shot(page, '07-ask');
await page.click('.fvs-pop .fvs-btn.primary');
await page.waitForFunction(() => HOST.calls.startChat.length === 1);
const chat = await page.evaluate(() => HOST.calls.startChat[0]);
assert.equal(chat.agent, 'fvs-director');
assert.equal(chat.send, true);
assert.ok(chat.prompt.includes('/home/me/Vault/Videos/第 2.12 话/episode-2.12.fvs.md'));
assert.ok(chat.prompt.includes('把「标题卡」的最后一张改成三行'));
assert.ok(chat.prompt.includes('/home/me/Vault/Forsion Video Studio/.fvs-tools/fvs.mjs'));
assert.ok(await page.evaluate(() => HOST.files.has('Forsion Video Studio/.fvs-tools/fvs.mjs')), 'tools materialised in the vault');
assert.ok(await page.evaluate(() => HOST.files.has('Forsion Video Studio/.fvs-tools/music/README.md')));

// 9. an external edit (the agent) reloads, and undo can take it back
const ext = before.replace('>人格<', '>灵魂<');
await page.evaluate(([p, t]) => HOST.external(p, t), [FILE, ext]);
await page.waitForFunction(() => HOST.calls.notify.some(m => /已载入/.test(m)));
await page.click('[data-tab="text"]');
await page.click('.fvs-clip[data-id="cards"]', { position: { x: 5, y: 10 } });
assert.equal(await page.locator('.fvs-text-item textarea').first().inputValue(), '灵魂');
await page.locator('.fvs-studio').focus();
await page.keyboard.press('Control+z');
await page.waitForTimeout(900);
assert.equal(await page.evaluate(p => HOST.text(p), FILE), before, 'undo takes back the external edit');

// 10. the project tab lists the sync check
await page.click('[data-tab="project"]');
await shot(page, '08-project');
const code = page.locator('[data-tab="code"]');
await code.click();
await shot(page, '09-code');

// 11. a brand new project from the file creator opens trusted and previews
await page.evaluate(() => HOST.reg.creators[0].run('Videos'));
await ready();
assert.equal(await page.locator('.fvs-clip').count(), 3);
await shot(page, '10-new');

assert.deepEqual(errors.filter(e => !/fonts\.|ERR_FAILED|net::/.test(e)), []);
console.log('studio e2e ok');
await browser.close();
