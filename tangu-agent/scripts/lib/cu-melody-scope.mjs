// PreToolUse for the isolated cross-Space Melody run. Only this fixture can create an initial root or state.
import { readFileSync } from 'node:fs';

const { tool_name: tool, tool_input: args = {} } = JSON.parse(readFileSync(0, 'utf8'));
const bundle = 'com.forsion.cu-fixture.melody';
const root = '@r1';
const keysWithin = (...allowed) => Object.keys(args).every(key => allowed.includes(key));
const player = (args.bundleId === undefined || args.bundleId === bundle)
  && (args.app === undefined || args.app === 'MelodyFixture')
  && (args.bundleId === bundle || args.app === 'MelodyFixture');
let allowed = false;
switch (tool) {
  case 'find_roots':
    allowed = player && keysWithin('bundleId', 'app', 'kind', 'limit');
    break;
  case 'ensure_app':
    allowed = player && keysWithin('bundleId', 'app', 'mode', 'foregroundRoot') && (args.foregroundRoot === undefined || args.foregroundRoot === root);
    break;
  case 'observe_ui':
    allowed = args.root === root && keysWithin('root', 'mode', 'magnify', 'samplePixels', 'image');
    break;
  case 'act_ui':
    allowed = typeof args.stateId === 'string' && keysWithin('stateId', 'actions', 'expect') && Array.isArray(args.actions)
      && args.actions.length > 0 && args.actions.every(a => a.action === 'click' && Number.isFinite(a.x) && Number.isFinite(a.y));
    break;
  case 'jev_ui':
    allowed = args.root === root && Array.isArray(args.steps) && args.steps.every(s => s.action === 'click' || s.action === 'double_click');
    break;
  case 'load_tools':
    allowed = true;
}
if (!allowed) {
  process.stderr.write('Only the disposable Melody player is in this test. Use its supplied bundle ID and first root. Once playback is visible, finish the turn.');
  process.exitCode = 2;
}
