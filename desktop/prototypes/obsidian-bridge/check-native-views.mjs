import assert from 'node:assert/strict';
import { Window } from 'happy-dom';
import { apiFor, domHelpers } from './src/obsidian.js';
import { createNativeViews } from './src/native-views.js';
const win = new Window();
globalThis.window = win; globalThis.Node = win.Node;
globalThis.document = win.document; domHelpers();
globalThis.MutationObserver = win.MutationObserver;
const registered = new Map(), errors = [];
let opened = 0, closed = 0, unloaded = 0, release;
const host = {
  registerNativeView(def) {
    const record = { def, el: document.createElement('div') }; registered.set(def.id, record);
    return () => { record.cleanup?.(); registered.delete(def.id); };
  },
  openNativeView(id) {
    const record = registered.get(id);
    if (!record.cleanup) { document.body.append(record.el); record.cleanup = record.def.mount(record.el); }
  },
  closeNativeView(id) {
    const record = registered.get(id);
    record?.cleanup?.(); if (record) { record.cleanup = null; record.el.remove(); }
  },
};
const runtime = { track: value => value, error: error => errors.push(error), invoke: async (_entry, fn) => fn() };
const entry = { alive: true, epoch: 1, manifest: { name: 'Fixture' }, cleanup: [] };
const views = createNativeViews(host, runtime, () => ({}));
const factory = () => ({ containerEl: document.createElement('div'), load() { opened++; }, onClose() { closed++; }, unload() { unloaded++; } });
try {
  const unregister = views.register(entry, 'fixture', factory);
  assert.ok(registered.has('obsidian-view-fixture')); // available before any command, including layout restoration
  assert.throws(() => views.register(entry, 'fixture', factory), /already registered/);
  const leaf = views.getLeaf('right'); await leaf.setViewState({type: 'fixture'});
  assert.equal(opened, 1);
  host.closeNativeView(leaf.id);
  let calls = 0; await leaf.invoke(() => calls++); assert.equal(calls, 0);
  host.openNativeView(leaf.id); await leaf.invoke(() => calls++);
  assert.equal(calls, 1); assert.equal(opened, 1); assert.equal(closed, 0);
  leaf.detach(); assert.equal(closed, 1); assert.equal(unloaded, 1);
  await leaf.invoke(() => calls++); assert.equal(calls, 1);
  // A persisted layout can mount the registered type without an Obsidian command.
  host.openNativeView('obsidian-view-fixture');
  const restored = views.getLeavesOfType('fixture')[0]; await restored.ready;
  assert.notEqual(restored, leaf); assert.equal(opened, 2);
  unregister(); unregister(); assert.equal(closed, 2); assert.equal(registered.size, 0);
  const cancelRegistration = views.register(entry, 'slow', () => ({...factory(), onOpen: () => new Promise(resolve => {release = resolve;})}));
  const slow = views.getLeaf(); const opening = slow.setViewState({type: 'slow'});
  const rejected = assert.rejects(opening, /View closed/);
  for(let i=0;i<10&&!release;i++) await Promise.resolve();
  assert.equal(typeof release, 'function');
  cancelRegistration(); await rejected; release(); await Promise.resolve(); await Promise.resolve();
  assert.equal(views.diagnostics().length, 0); assert.equal(registered.size, 0);
  assert.ok(errors.every(error => /View closed/.test(error.message)));
  let stateRelease, stateEntered = false, lateOpen = 0;
  const offState = views.register(entry, 'slow-state', () => ({...factory(), setState() { stateEntered = true; return new Promise(resolve => { stateRelease = resolve; }); }, onOpen() {lateOpen++;}}));
  const stateLeaf = views.getLeaf(); const stateOpening = stateLeaf.setViewState({type: 'slow-state'});
  const stateRejected = assert.rejects(stateOpening, /View closed/);
  for(let i=0;i<10&&!stateEntered;i++) await Promise.resolve();
  offState(); stateRelease(); await stateRejected; for(let i=0;i<6;i++) await Promise.resolve();
  assert.equal(lateOpen, 0);
  const {ItemView} = apiFor(runtime, entry);
  const offRepeated = views.register(entry, 'repeated', leaf => new ItemView(leaf));
  const baseline = entry.cleanup.length;
  for(let i=0;i<5;i++) { const repeated = views.getLeaf(); await repeated.setViewState({type:'repeated'}); repeated.detach(); }
  assert.equal(entry.cleanup.length, baseline); offRepeated();
  assert.equal(entry.cleanup.length, 0);
  const broken = new ItemView({app:{},invoke: fn=>fn()});
  let released = 0;
  broken.onunload = () => {throw Error('Expected cleanup failure');};
  broken.register(() => released++); broken.unload(); broken.unload();
  broken.register(() => released++);
  assert.equal(released, 2); assert.equal(entry.cleanup.length, 0);
  assert.match(errors.at(-1).message, /Expected cleanup failure/);
  console.log('PASS native view registration, collapse/remount, layout restore, stale callbacks, detach and pending disable');
} finally { views.dispose(); await win.happyDOM.close(); }
