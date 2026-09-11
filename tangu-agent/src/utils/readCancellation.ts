/** Read-only adapters may not expose transport cancellation yet. Stop the caller
 * promptly and drain the issued promise; never start another read after abort.
 * Do not use this to release locks around operations that can still mutate state. */
export function throwIfReadAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    const error = new Error(signal.reason instanceof Error ? signal.reason.message : 'Read cancelled');
    error.name = 'AbortError';
    throw error;
  }
}

export function cancellableRead<T>(read: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  throwIfReadAborted(signal);
  if (!signal) return read();
  return new Promise<T>((resolve, reject) => {
    const abort = (): void => {
      try { throwIfReadAborted(signal); } catch (error) { reject(error); }
    };
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => { throwIfReadAborted(signal); return read(); }).then(value => {
      throwIfReadAborted(signal);
      resolve(value);
    }).catch(reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}
