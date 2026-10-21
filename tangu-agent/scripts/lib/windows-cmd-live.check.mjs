import assert from 'node:assert/strict';
import { windowsCmdVerdict } from './windows-cmd-live.mjs';
const safe = { command: 'dir /b "Library"', approvals: 0, contains: 'a.txt' };
const read = { done: true, error: null, toolArgs: [{ id: 'c1', name: 'run_bash', arguments: JSON.stringify({ command: safe.command }) }],
  toolResults: [{ id: 'c1', name: 'run_bash', isError: false, full: 'stdout:\na.txt\nexit_code: 0' }], approvals: 0, approvalList: [], approvalResults: [] };
assert.equal(windowsCmdVerdict(read, safe), true);
assert.equal(windowsCmdVerdict({ ...read, toolResults: [{ ...read.toolResults[0], id: 'other-call' }] }, safe), false, 'another tool result cannot satisfy the requested read');
assert.equal(windowsCmdVerdict({ ...read, toolResults: [{ ...read.toolResults[0], isError: true }] }, safe), false, 'failed reads are not successful output');
assert.equal(windowsCmdVerdict({ ...read, toolArgs: [...read.toolArgs, { name: 'read_file' }] }, safe), false, 'fallback tools do not count as the specified shell read');
const blocked = { command: 'dir /b | more', approvals: 1 };
const denied = { ...read, approvals: 1, toolArgs: [{ id: 'c1', name: 'run_bash', arguments: JSON.stringify({ command: blocked.command }) }],
  approvalList: [{ args: JSON.stringify({ command: blocked.command }) }], approvalResults: [{ action: 'reject' }],
  toolResults: [{ id: 'c1', name: 'run_bash', isError: true, full: 'The user rejected this tool call, so it was NOT run.' }] };
assert.equal(windowsCmdVerdict(denied, blocked), true);
assert.equal(windowsCmdVerdict({ ...denied, toolResults: read.toolResults }, blocked), false, 'an approval card followed by execution is a failure');
assert.equal(windowsCmdVerdict({ ...denied, approvalResults: [{ action: 'approve' }] }, blocked), false, 'the decision must actually reject the command');
assert.equal(windowsCmdVerdict({ ...denied, approvalResults: [] }, blocked), false, 'an unresolved card is not a rejection');
console.log('windowscmd verdict: 8 positive / negative controls passed');
