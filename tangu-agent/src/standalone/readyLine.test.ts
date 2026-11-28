import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { announceReady, formatReadyLine, parseReadyLine, READY_LINE_PREFIX, wantsReadyLine } from './readyLine.js';

/** Same string as FIXTURE in mobile/android/app/src/test/java/com/forsion/tangu/localengine/LocalEngineProcessTest.java. */
const FIXTURE = 'TANGU_READY {"v":1,"host":"127.0.0.1","port":40123,"version":"0.0.0-test"}';

describe('machine-readable ready line', () => {
  it('formats exactly the line the Android parser is tested against', () => {
    expect(formatReadyLine({ host: '127.0.0.1', port: 40123, version: '0.0.0-test' })).toBe(FIXTURE);
    expect(parseReadyLine(FIXTURE)).toBe(40123);
  });

  it('stays one line whatever the version string holds', () => {
    const line = formatReadyLine({ host: '127.0.0.1', port: 1, version: 'a\nb\r"c"', mode: 'multi-account' });
    expect(line).not.toMatch(/[\r\n]/);
    expect(parseReadyLine(line)).toBe(1);
    expect(JSON.parse(line.slice(READY_LINE_PREFIX.length))).toMatchObject({ v: 1, mode: 'multi-account', version: 'a\nb\r"c"' });
  });

  it('is printed only when the host asks for it', () => {
    const out: string[] = [];
    announceReady({ host: '127.0.0.1', port: 5, version: 'x' }, {}, (s) => out.push(s));
    announceReady({ host: '127.0.0.1', port: 5, version: 'x' }, { TANGU_READY_LINE: '0' }, (s) => out.push(s));
    expect(out).toEqual([]);
    announceReady({ host: '127.0.0.1', port: 5, version: 'x' }, { TANGU_READY_LINE: '1' }, (s) => out.push(s));
    expect(out).toHaveLength(1);
    expect(out[0].endsWith('\n')).toBe(true);
    expect(parseReadyLine(out[0].trimEnd())).toBe(5);
    expect(wantsReadyLine({ TANGU_READY_LINE: '1' })).toBe(true);
    expect(wantsReadyLine({ TANGU_READY_LINE: 'true' })).toBe(false);
  });

  it('never reads a port from the human-readable startup lines', () => {
    expect(parseReadyLine('[tangu] standalone 已启动 http://127.0.0.1:40123')).toBe(0);
    expect(parseReadyLine(` ${FIXTURE}`)).toBe(0);
    for (const bad of ['{}', '{"port":0}', '{"port":65536}', '{"port":1.5}', '{"port":"80"}', 'nope', '[1]',
      '{"port":40123} extra', ' {"port":40123}', '{"port":40123} ', '{"port":40123}{"port":1}']) {
      expect(parseReadyLine(READY_LINE_PREFIX + bad)).toBe(0);
    }
  });

  it('matches the Android side (prefix, env switch, env set on every start)', () => {
    const java = readFileSync(fileURLToPath(new URL(
      '../../../mobile/android/app/src/main/java/com/forsion/tangu/localengine/LocalEngineProcess.java', import.meta.url)), 'utf8');
    expect(java).toContain(`static final String READY_PREFIX = "${READY_LINE_PREFIX}";`);
    expect(java).toContain('static final String READY_ENV = "TANGU_READY_LINE";');
    expect(java).toContain('env.put(READY_ENV, "1");');
  });
});
