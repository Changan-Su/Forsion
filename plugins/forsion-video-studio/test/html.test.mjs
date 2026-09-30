import test from 'node:test';
import assert from 'node:assert/strict';
import { scan, replaceText, setAttr, images, timedElements, decode } from '../src/lib/html.js';
import { onsetEnvelope, syncReport, ONSET_SR } from '../src/lib/onsets.js';

const HTML = `<div class="a" data-in="h0">人格 <b>SOUL</b></div>
<!-- a comment with <b>tags</b> -->
<style>.x{content:"not text"}</style>
<p class="sub">The Agent was only half.<small>Agent，只是一半。</small></p>
<img src="assets/a.jpg" alt=""><span data-in='h2' data-fx=up>A &amp; B</span>
<svg viewBox="0 0 10 10"><path d="M0 0"/><text>svg text</text></svg>`;

test('text runs skip tags, comments and raw text', () => {
  const t = scan(HTML).texts.map(x => x.text.trim());
  assert.deepEqual(t, ['人格', 'SOUL', 'The Agent was only half.', 'Agent，只是一半。', 'A & B', 'svg text']);
  assert.equal(decode('&lt;b&gt; &#x4e2d;&#25991; &nbsp;'), '<b> 中文  ');
});

test('replaceText changes only that run and escapes', () => {
  const out = replaceText(HTML, 4, 'A < B & C');
  assert.equal(out, HTML.replace('A &amp; B', 'A &lt; B &amp; C'));
  const out2 = replaceText(HTML, 0, '灵魂');
  assert.equal(out2, HTML.replace('人格 <b>', '灵魂 <b>'), 'keeps the whitespace around the run');
});

test('attributes: images, timing, set and remove', () => {
  assert.deepEqual(images(HTML).map(i => i.src), ['assets/a.jpg']);
  const timed = timedElements(HTML);
  assert.deepEqual(timed.map(x => [x.in, x.fx, x.label]), [['h0', undefined, '人格'], ['h2', 'up', 'A & B']]);
  const span = timed[1].tag;
  let out = setAttr(HTML, span, 'data-in', 'h3');
  assert.ok(out.includes(`<span data-in="h3" data-fx=up>`));
  out = setAttr(out, span, 'data-fx', null);
  assert.ok(out.includes(`<span data-in="h3">A &amp; B</span>`));
  out = setAttr(out, images(out)[0].tag, 'src', 'assets/b.png');
  assert.ok(out.includes('<img src="assets/b.png" alt="">'));
  out = setAttr('<br/>', 0, 'class', 'x');
  assert.equal(out, '<br class="x"/>');
});

test('accents: clicks on the beat are found, silence is not', () => {
  const sr = ONSET_SR, x = new Float32Array(sr * 4);
  for (let k = 0; k < 8; k++) { const i = Math.round(k * .5 * sr); for (let j = 0; j < 800; j++) x[i + j] = Math.exp(-j / 150) * Math.sin(j * .7); }
  const env = onsetEnvelope(x, sr);
  const rows = syncReport([{ id: 's', hitTimes: [0.5, 1.0, 1.25, 3.0] }], env);
  assert.deepEqual(rows.map(r => r.ok), [true, true, false, true]);
  assert.ok(Math.abs(rows[0].offset) < .02, `offset ${rows[0].offset}`);
});
