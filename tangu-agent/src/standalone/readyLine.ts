/**
 * Machine-readable readiness on stdout, for hosts that cannot use the IPC channel.
 *
 * The Android app runs the engine under PRoot and only has its stdout (no `process.send`). It used to take the port
 * from the human-readable startup line, so rewording that line would have made every start fail while the new engine
 * layer still passed the install self-test. With `TANGU_READY_LINE=1` the engine prints one extra line once it
 * listens:
 *
 *   TANGU_READY {"v":1,"host":"127.0.0.1","port":40123,"version":"…"}
 *
 * Hosts parse only this line; the human-readable lines stay free to change. Off by default, so terminal users and the
 * desktop (IPC) see no change. The native parser is `LocalEngineProcess.parseReadyLine` in
 * `mobile/android/app/src/main/java/com/forsion/tangu/localengine/`; its unit test checks the prefix against this file.
 */

export const READY_LINE_PREFIX = 'TANGU_READY ';
export const READY_LINE_VERSION = 1;

export interface ReadyInfo {
  host: string;
  port: number;
  version: string;
  mode?: string;
}

export function wantsReadyLine(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.TANGU_READY_LINE === '1';
}

/** One line, no trailing newline. JSON.stringify never emits a raw newline, so the line cannot be split. */
export function formatReadyLine(info: ReadyInfo): string {
  const body: Record<string, unknown> = { v: READY_LINE_VERSION, host: info.host, port: info.port, version: info.version };
  if (info.mode) body.mode = info.mode;
  return READY_LINE_PREFIX + JSON.stringify(body);
}

/**
 * The port from a ready line, or 0 when the line is not one. Same rules as the native parser: the prefix, then
 * exactly one JSON object with nothing before or after it, and an integer port in 1..65535.
 */
export function parseReadyLine(line: string): number {
  if (!line.startsWith(READY_LINE_PREFIX)) return 0;
  const payload = line.slice(READY_LINE_PREFIX.length);
  if (!payload.startsWith('{') || !payload.endsWith('}')) return 0;
  try {
    const o = JSON.parse(payload) as { port?: unknown };
    const p = o?.port;
    return typeof p === 'number' && Number.isInteger(p) && p > 0 && p < 65536 ? p : 0;
  } catch {
    return 0;
  }
}

/** Prints the ready line when the host asked for it. Call once, from the listen callback, before any other output. */
export function announceReady(info: ReadyInfo, env: NodeJS.ProcessEnv = process.env, write: (s: string) => void = (s) => { process.stdout.write(s); }): void {
  if (wantsReadyLine(env)) write(formatReadyLine(info) + '\n');
}
