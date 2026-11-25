import type { ChildProcess } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, rmdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const JOB_OBJECT_EXTENDED_LIMIT_INFORMATION = 9;
const JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;
const PROCESS_SET_QUOTA_AND_TERMINATE = 0x0101;

interface ProcessJob {
  add(pid: number): void;
  terminate(): boolean;
  close(): boolean;
}

const jobs = new WeakMap<ChildProcess, ProcessJob>();

function loadJobApi() {
  const koffi: typeof import('koffi') = require('koffi');
  const kernel = koffi.load('kernel32.dll');
  const createJob = kernel.func('void * __stdcall CreateJobObjectW(void *attributes, void *name)');
  const setJob = kernel.func('int __stdcall SetInformationJobObject(void *job, int infoClass, void *info, uint32_t size)');
  const openProcess = kernel.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const assignProcess = kernel.func('int __stdcall AssignProcessToJobObject(void *job, void *process)');
  const terminateJob = kernel.func('int __stdcall TerminateJobObject(void *job, uint32_t exitCode)');
  const closeHandle = kernel.func('int __stdcall CloseHandle(void *handle)');
  const lastError = kernel.func('uint32_t __stdcall GetLastError()');

  const basicLimits = koffi.struct({
    perProcessTime: 'int64_t', perJobTime: 'int64_t', flags: 'uint32_t',
    minWorkingSet: 'size_t', maxWorkingSet: 'size_t', maxProcesses: 'uint32_t',
    affinity: 'uintptr_t', priority: 'uint32_t', scheduling: 'uint32_t',
  });
  const extendedLimits = koffi.struct({
    basic: basicLimits, ioCounters: koffi.array('uint64_t', 6),
    processMemory: 'size_t', jobMemory: 'size_t', peakProcessMemory: 'size_t', peakJobMemory: 'size_t',
  });
  const limits = Buffer.alloc(koffi.sizeof(extendedLimits));
  limits.writeUInt32LE(JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, koffi.offsetof(basicLimits, 'flags'));
  return { createJob, setJob, openProcess, assignProcess, terminateJob, closeHandle, lastError, limits };
}

let jobApi: ReturnType<typeof loadJobApi> | undefined;

function createJob(): ProcessJob {
  let api: ReturnType<typeof loadJobApi>;
  try { api = jobApi ??= loadJobApi(); }
  catch (error) {
    const detail = (error instanceof Error ? error.message : String(error)).split('\n')[0];
    throw new Error(`Could not initialize Windows process cleanup: ${detail}`, { cause: error });
  }
  const failed = (operation: string) => new Error(`${operation} failed (Windows error ${api.lastError()})`);
  let handle = api.createJob(null, null);
  if (handle == null) throw failed('CreateJobObjectW');
  if (!api.setJob(handle, JOB_OBJECT_EXTENDED_LIMIT_INFORMATION, api.limits, api.limits.length)) {
    const error = failed('SetInformationJobObject');
    api.closeHandle(handle);
    throw error;
  }
  const close = (): boolean => {
    if (handle == null) return true;
    if (!api.closeHandle(handle)) return false;
    handle = null;
    return true;
  };
  return {
    add(pid) {
      const processHandle = api.openProcess(PROCESS_SET_QUOTA_AND_TERMINATE, 0, pid);
      if (processHandle == null) throw failed('OpenProcess');
      try {
        if (!api.assignProcess(handle, processHandle)) throw failed('AssignProcessToJobObject');
      } finally {
        api.closeHandle(processHandle);
      }
    },
    terminate: () => handle == null || !!api.terminateJob(handle, 1) || close(),
    close,
  };
}

/** Git Bash waits for the ready file before running user code. Assign it while it is still waiting so
 * Windows tracks the command's descendants even if an MSYS fork/exec changes their native parent PID. */
export function spawnWindowsJob(start: (readyFile: string) => ChildProcess): ChildProcess {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'tangu-win-job-'));
  const ready = path.join(dir, 'ready');
  const pending = path.join(dir, 'pending');
  let job: ProcessJob | undefined;
  let child: ChildProcess | undefined;
  const cleanup = () => {
    if (!job || job.close()) {
      if (child) jobs.delete(child);
      job = undefined;
    }
    try {
      rmSync(ready, { force: true });
      rmSync(pending, { force: true });
      rmdirSync(dir);
    } catch { /* The markers are temporary. */ }
  };
  try {
    job = createJob();
    child = start(ready.replaceAll('\\', '/'));
    child.once('close', cleanup);
    child.once('error', cleanup);
    if (!child.pid) {
      cleanup();
      return child; // Node reports the spawn failure to the caller on 'error'.
    }
    // Node still holds its native process handle here, so Windows cannot recycle the PID
    // between spawn and OpenProcess. Do not release the Bash startup gate until assignment succeeds.
    job.add(child.pid);
    jobs.set(child, job);
    writeFileSync(pending, `${child.pid}\n`);
    renameSync(pending, ready);
    return child;
  } catch (error) {
    try { child?.kill('SIGKILL'); } catch { /* The shell may have already exited. */ }
    cleanup();
    throw error;
  }
}

export function terminateWindowsJob(child: ChildProcess): boolean | undefined {
  return jobs.get(child)?.terminate();
}
