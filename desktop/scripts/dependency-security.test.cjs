const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { createRequire } = require('node:module');
const fs = require('node:fs');
const root = path.resolve(__dirname, '../..');
for (const project of ['desktop', 'web', 'mobile']) {
  test(`${project}: every installed/locked parser is patched and source-pinned`, () => {
    const lock = require(path.join(root, project, 'package-lock.json'));
    const xlsx = lock.packages['node_modules/xlsx'];
    assert.equal(xlsx.version, '0.20.3');
    assert.equal(require(path.join(root, project, 'node_modules/xlsx/package.json')).version, '0.20.3');
    assert.equal(xlsx.resolved, 'https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz');
    assert.equal(xlsx.integrity, 'sha512-oLDq3jw7AcLqKWH2AhCpVTZl8mf6X2YReP+Neh0SJUzV/BdZYjth94tG5toiMB1PPrYtxOCfaoUCkvtuH+3AJA==');
    for (const [key, value] of Object.entries(lock.packages)) {
      if (!key.endsWith('node_modules/prosemirror-view')) continue;
      assert.equal(value.version, '1.42.3');
      assert.equal(JSON.parse(fs.readFileSync(path.join(root, project, key, 'package.json'))).version, '1.42.3');
    }
  });
  test(`${project}: real ProseMirror HTML clipboard validates context before custom/default handlers`, async () => {
    const { Window } = await import('happy-dom');
    const window = new Window();
    for (const key of ['window','document','navigator','MutationObserver','Node','HTMLElement','getComputedStyle','ClipboardEvent','CSSStyleRule']) {
      Object.defineProperty(globalThis, key, { value: key === 'window' ? window : window[key], configurable: true });
    }
    const req = createRequire(path.join(root, project, 'package.json'));
    const { Schema } = req('prosemirror-model');
    const { EditorState } = req('prosemirror-state');
    const { EditorView } = req('prosemirror-view');
    const schema = new Schema({ nodes: {
      doc: { content:'block+' }, text: { group:'inline' },
      paragraph: { content:'inline*', group:'block', parseDOM:[{tag:'p'}], toDOM:()=>['p',0] },
      wrapper: { content:'block+', group:'block', attrs:{ label:{default:'safe', validate:'string'} }, toDOM: n=>['section', {'data-label':n.attrs.label},0] },
      image: { inline:true, group:'inline', attrs:{src:{}}, parseDOM:[{tag:'img',getAttrs:d=>({src:d.getAttribute('src')})}], toDOM:n=>['img',{src:n.attrs.src}] },
      table: { group:'block', content:'row+', parseDOM:[{tag:'table'}], toDOM:()=>['table',['tbody',0]] },
      row: { content:'cell+', parseDOM:[{tag:'tr'}], toDOM:()=>['tr',0] },
      cell: { content:'paragraph+', parseDOM:[{tag:'td'}], toDOM:()=>['td',0] },
      task: { group:'inline', inline:true, attrs:{checked:{default:false}}, parseDOM:[{tag:'input[type=checkbox]',getAttrs:d=>({checked:d.checked})}], toDOM:n=>['input',{type:'checkbox',checked:n.attrs.checked}] },
    }, marks:{ strong:{parseDOM:[{tag:'strong'}],toDOM:()=>['strong',0]}, link:{attrs:{href:{}},parseDOM:[{tag:'a',getAttrs:d=>({href:d.getAttribute('href')})}],toDOM:n=>['a',{href:n.attrs.href},0]} } });
    for (const handled of [true, false]) {
      let seen;
      const view = new EditorView(window.document.body, { state:EditorState.create({schema}), handlePaste(_view,_event,slice) { seen=slice.toJSON(); return handled; } });
      const context = JSON.stringify(['wrapper',{label:['img',{src:'x',onerror:'payload'}]}]).replace(/'/g,'&#39;');
      view.pasteHTML(`<p data-pm-slice='0 0 ${context}'>safe text</p>`);
      assert.ok(seen); assert.equal(JSON.stringify(seen).includes('payload'),false);
      if (!handled) assert.equal(view.state.doc.textContent,'safe text');
      view.destroy();
    }
    const view = new EditorView(window.document.body,{state:EditorState.create({schema})});
    view.pasteHTML('<p><strong>rich</strong> <a href="https://example.com">link</a><input type="checkbox" checked><img src="https://example.com/a.png"></p><table><tr><td><p>cell</p></td></tr></table>');
    const json=JSON.stringify(view.state.doc.toJSON());
    for(const type of ['strong','link','task','image','table']) assert.ok(json.includes(`"${type}"`),type);
    view.destroy(); window.happyDOM.abort();
  });
}

for (const project of ['desktop','tangu-agent']) test(`${project}: every MCP SDK is patched`, () => {
  const lock = require(path.join(root, project, 'package-lock.json'));
  for (const [key,value] of Object.entries(lock.packages)) if(key.endsWith('node_modules/@modelcontextprotocol/sdk')) {
    assert.equal(value.version,'1.32.0');
    assert.equal(require(path.join(root,project,key,'package.json')).version,'1.32.0');
  }
});
test('Android core/CLI/native package versions match', () => {
  const lock = require(path.join(root,'mobile/package-lock.json'));
  for(const name of ['android','core','cli']) {
    const relative=`node_modules/@capacitor/${name}`;
    assert.equal(lock.packages[relative].version,'7.6.9');
    assert.equal(require(path.join(root,'mobile',relative,'package.json')).version,'7.6.9');
  }
});
