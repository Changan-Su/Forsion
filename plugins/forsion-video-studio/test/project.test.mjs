import test from 'node:test';
import assert from 'node:assert/strict';
import * as P from '../src/lib/project.js';
import { compile, buildHtml, assetRefs } from '../src/lib/compile.js';
import { evaTemplate, blankTemplate } from '../src/lib/templates.js';

const DOC = `# Demo

Some prose that must survive.

\`\`\`fvs
{ "fvs": 1, "width": 1440, "height": 1080, "fps": 30, "tempo": { "bpm": 150, "beatsPerBar": 4 } }
\`\`\`

\`\`\`css
.a { color: red; background: url(assets/bg.png); }
\`\`\`

\`\`\`html stage
<div data-fvs-scenes></div><div data-fvs-flash></div>
\`\`\`

## warning · 警告

\`\`\`fvs
{ "length": "3 bars", "hits": [0] }
\`\`\`

\`\`\`html
<p>光敏性癫痫警告</p><img src="assets/a.jpg">
\`\`\`

Director's note: keep it silent.

## cards · 标题卡

\`\`\`fvs
{ "length": "4 bars", "hits": [0, 2, 4] }
\`\`\`

\`\`\`html
<div data-seq="h0"><div>人格</div><div>记忆</div><div>技能</div></div>
\`\`\`

\`\`\`js
flash(hits[0], .6)
\`\`\`

~~~python
# not ours, kept
~~~
`;

test('round trip is byte exact', () => {
  const p = P.parseProject(DOC);
  assert.equal(P.serializeTokens(p.toks, p.eol), DOC);
  const crlf = DOC.replace(/\n/g, '\r\n');
  const q = P.parseProject(crlf);
  assert.equal(P.serializeTokens(q.toks, q.eol), crlf);
  const noNl = DOC.trimEnd();
  const r = P.parseProject(noNl);
  assert.equal(P.serializeTokens(r.toks, r.eol), noNl);
});

test('timeline from bars and hits', () => {
  const p = P.parseProject(DOC);
  assert.deepEqual(p.errors.filter(e => e.level === 'error'), []);
  assert.equal(p.scenes.length, 2);
  const [w, c] = p.scenes;
  assert.equal(w.id, 'warning'); assert.equal(w.title, '警告');
  assert.equal(w.t0, 0); assert.ok(Math.abs(w.t1 - 4.8) < 1e-9);
  assert.ok(Math.abs(c.t0 - 4.8) < 1e-9);
  assert.deepEqual(c.hitTimes, [4.8, 5.6, 6.4]);
  assert.ok(Math.abs(p.length - 11.2) < 1e-9);
  assert.equal(P.formatLength(4.8, p.tempo), '3 bars');
  assert.equal(P.formatLength(1.0, p.tempo), '2.5 beats');
  assert.equal(P.formatLength(1.6, p.tempo), '1 bar');
  assert.equal(P.formatLength(2.5, null), '2.5s');
});

test('edits touch only their tokens', () => {
  let s = P.setSceneMeta(DOC, 'cards', { hits: [0, 1, 2] });
  assert.ok(s.includes('{ "length": "4 bars", "hits": [0, 1, 2] }'));
  assert.ok(s.includes("Director's note: keep it silent."));
  assert.ok(s.includes('~~~python\n# not ours, kept\n~~~'));
  s = P.setSceneBlock(s, 'warning', 'html', '<p>WARNING</p>');
  assert.equal(P.sceneById(P.parseProject(s), 'warning').html, '<p>WARNING</p>');
  s = P.setSceneBlock(s, 'warning', 'js', 'cut($("p"), t0)');
  const w = P.sceneById(P.parseProject(s), 'warning');
  assert.equal(w.js, 'cut($("p"), t0)');
  // the new js block sits after the html block and before the note
  assert.ok(s.indexOf('cut($("p"), t0)') < s.indexOf("Director's note"));
  s = P.setProjectMeta(s, { title: 'Demo 2', fps: 25 });
  const p = P.parseProject(s);
  assert.equal(p.meta.title, 'Demo 2'); assert.equal(p.meta.fps, 25); assert.equal(p.meta.width, 1440);
  s = P.setProjectBlock(s, 'css', '.b{}');
  assert.deepEqual(P.cssBlocks(P.parseProject(s)), ['.b{}']);
  s = P.setProjectBlock(s, 'js', 'grain()');
  assert.equal(P.stageJs(P.parseProject(s)), 'grain()');
});

test('insert, move, duplicate, rename, delete', () => {
  let s = P.insertScene(DOC, 'warning', { id: 'mid', title: '中间', meta: { length: '1 bar', hits: [0] }, html: '<b>x</b>' });
  let p = P.parseProject(s);
  assert.deepEqual(p.scenes.map(x => x.id), ['warning', 'mid', 'cards']);
  assert.deepEqual(p.errors.filter(e => e.level === 'error'), []);
  s = P.moveScene(s, 'mid', 2);
  p = P.parseProject(s);
  assert.deepEqual(p.scenes.map(x => x.id), ['warning', 'cards', 'mid']);
  s = P.moveScene(s, 'mid', 0);
  p = P.parseProject(s);
  assert.deepEqual(p.scenes.map(x => x.id), ['mid', 'warning', 'cards']);
  assert.equal(P.sceneById(p, 'mid').html, '<b>x</b>');
  assert.ok(s.includes("Director's note: keep it silent."));
  s = P.duplicateScene(s, 'cards', 'cards-2');
  p = P.parseProject(s);
  assert.deepEqual(p.scenes.map(x => x.id), ['mid', 'warning', 'cards', 'cards-2']);
  assert.equal(P.sceneById(p, 'cards-2').js, 'flash(hits[0], .6)');
  s = P.renameScene(s, 'cards-2', 'finale', '结尾');
  p = P.parseProject(s);
  assert.equal(p.scenes[3].id, 'finale'); assert.equal(p.scenes[3].title, '结尾');
  s = P.deleteScene(s, 'mid');
  p = P.parseProject(s);
  assert.deepEqual(p.scenes.map(x => x.id), ['warning', 'cards', 'finale']);
  s = P.insertScene(s, null, { id: 'end', meta: { length: '2s' } });
  p = P.parseProject(s);
  assert.equal(p.scenes.at(-1).id, 'end');
  s = P.insertScene(s, '', { id: 'first', meta: { length: '2s' } });
  assert.equal(P.parseProject(s).scenes[0].id, 'first');
  assert.equal(P.freeId(P.parseProject(s), 'cards'), 'cards-2');
});

test('roll edit keeps later cuts in place', () => {
  const s = P.rollCut(DOC, 'warning', 4.0);
  const p = P.parseProject(s);
  assert.equal(p.scenes[0].meta.length, '10 beats');
  assert.equal(p.scenes[1].meta.length, '18 beats');
  assert.ok(Math.abs(p.length - 11.2) < 1e-9);
  // absolute hit times of the next scene survive, except the one that fell before the new cut
  assert.deepEqual(p.scenes[1].hitTimes.map(x => +x.toFixed(6)), [4.8, 5.6, 6.4]);
});

test('errors carry line numbers', () => {
  const bad = DOC.replace('{ "length": "4 bars", "hits": [0, 2, 4] }', '{ "length": "4 bars", hits: [0] }').replace('## warning · 警告', '## 警告');
  const p = P.parseProject(bad);
  const msgs = p.errors.map(e => `${e.level}:${e.line}:${e.message}`);
  assert.ok(msgs.some(m => m.startsWith('error:') && m.includes('invalid JSON')), msgs.join('\n'));
  assert.ok(msgs.some(m => m.includes('must start with an id')), msgs.join('\n'));
  const noTempo = P.parseProject(DOC.replace(', "tempo": { "bpm": 150, "beatsPerBar": 4 }', ''));
  assert.ok(noTempo.errors.some(e => e.message.includes('needs a tempo')));
});

test('compile resolves assets and builds a page', () => {
  const p = P.parseProject(DOC);
  assert.deepEqual(assetRefs('<img src="assets/a.jpg"><use href="#x"><img src="https://x/y.png">', 'a{background:url("b.png")}'), ['assets/a.jpg', 'b.png']);
  const payload = compile(p, { resolve: u => `asset://${u}` });
  assert.ok(payload.css.includes('url(asset://assets/bg.png)'));
  assert.ok(payload.scenes[0].html.includes('src="asset://assets/a.jpg"'));
  assert.equal(payload.scenes[1].line, P.parseProject(DOC).toks[P.sceneById(p, 'cards').jsTok].line + 1);
  const html = buildHtml(payload, 'var FVS={boot(){}}', { mode: 'capture' });
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('FVS.boot("capture")'));
});

test('templates parse cleanly', () => {
  for (const t of [evaTemplate({ title: '测试' }), blankTemplate({ title: 'Test', zh: false })]) {
    const p = P.parseProject(t);
    assert.deepEqual(p.errors, [], JSON.stringify(p.errors));
    assert.ok(p.scenes.length >= 1);
  }
});
