#!/usr/bin/env node
// Offline reproduction of the feedback's tools[40]: null, using the built engine.
import assert from 'node:assert/strict';
import { configureTangu } from '../dist/seams/runtime.js';
import { createTanguProfile } from '../dist/profiles/index.js';
import { getToolDefinitions } from '../dist/tools/registry.js';
import { buildOpenAiCompatPayload } from '../dist/llm/openaiCompat.js';
import { createHttpBrain } from '../dist/adapters/standalone/httpBrain.js';

const make = (name) => ({ name, definition: { type: 'function', function: { name, description: '', parameters: {} } }, execute: () => '' });
const tools = [...Array.from({ length: 40 }, (_, i) => make(`valid_${i}`)), { ...make('broken_41st'), definition: undefined }, make('valid_tail')];
const profile = createTanguProfile({ sandboxMode: 'none' });
profile.toolLoadout = { builtins: [], providers: [{ id: 'smoke:missing-definition', tools: () => tools }] };
const stub = new Proxy({}, { get: () => () => { throw new Error('stub'); } });
configureTangu({ profile, host: stub, brain: stub, billing: stub });
const defs = getToolDefinitions({ profile, userId: 'u', sessionId: 's', appId: profile.appId, execMode: 'host' });
assert.equal(defs.length, 41);
assert.equal(defs[40].function.name, 'valid_tail');
assert.deepEqual(defs.slice(0, 40), tools.slice(0, 40).map(t => t.definition));
assert.ok(JSON.parse(JSON.stringify(defs)).every(t => t !== null));
const input = { model: { id: 'fixture' }, apiModelId: 'fixture', messages: [], tools: [undefined] };
assert.throws(() => buildOpenAiCompatPayload(input), /tools\[0\]/);
const brain = createHttpBrain({ cloudUrl: 'https://unused.invalid', token: 'fixture' });
await assert.rejects(brain.llm.buildProviderPayload(input), /tools\[0\]/);
console.log('PASS: tools[40] missing definition isolated; valid prefix preserved; direct and managed payloads reject null before sending.');
