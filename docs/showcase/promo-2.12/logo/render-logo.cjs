// Render the special edition logo to PNG, on black and on a transparent background.
// Usage: NODE_PATH=$(npm root -g) node logo/render-logo.cjs   (after node build.mjs)
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const root = path.join(__dirname, '..');
const svg = fs.readFileSync(path.join(root, 'dist/logo-2.12-special.svg'), 'utf8');
const out = path.join(root, 'out/logo');
fs.mkdirSync(out, { recursive: true });
(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 2048, height: 2048 } });
  for (const [name, bg] of [['forsion-2.12-special-black.png', '#000'], ['forsion-2.12-special-transparent.png', 'transparent']]) {
    await p.setContent(`<body style="margin:0;background:${bg}"><div style="width:2048px;height:2048px;display:flex;align-items:center;justify-content:center">${svg.replace('width="630" height="745"', 'width="1470" height="1738"')}</div></body>`);
    await p.evaluate(() => document.fonts.ready);
    await p.screenshot({ path: path.join(out, name), omitBackground: bg === 'transparent' });
    console.log(name);
  }
  await b.close();
})();
