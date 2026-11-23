/** Python runs with -u. Children inherit the output pipes while the driver alone owns the protocol streams. */
export function pythonKernelDriver(maxCapture: number): string {
  return `
import importlib, json, os, select, sys, threading, traceback

limit = ${Math.max(1, Math.floor(maxCapture))}
source = os.fdopen(os.dup(0), "rb")
sink = os.fdopen(os.dup(1), "wb")
idle = os.open(os.devnull, os.O_RDWR)
for fd in (0, 1, 2):
    os.dup2(idle, fd)

def send(message):
    while True:
        body = json.dumps(message, ensure_ascii=False).encode("utf-8", "replace")
        if len(body) + 10 <= max(1024, 2 * limit) or "stdout" not in message:
            break
        key = max(("stdout", "stderr"), key=lambda k: len(message[k]))
        message[key] = message[key][:len(message[key]) // 2]
    sink.write(b"%010d" % len(body))
    sink.write(body)
    sink.flush()

class Capture:
    def __init__(self, target):
        self.fd, writer = os.pipe()
        os.set_blocking(self.fd, False)
        os.dup2(writer, target)
        os.close(writer)
        self.lock = threading.Lock()
        self.data = bytearray()
        self.eof = False
        threading.Thread(target=self.drain, daemon=True).start()

    # Called under the lock. Only the reader thread closes the descriptor.
    def pull(self):
        if self.eof:
            return False
        try:
            chunk = os.read(self.fd, 65536)
        except BlockingIOError:
            return False
        if not chunk:
            self.eof = True
            return False
        if self.data is not None and len(self.data) < limit:
            self.data.extend(chunk[:limit - len(self.data)])
        return True

    def drain(self):
        try:
            while not self.eof:
                select.select([self.fd], [], [])
                with self.lock:
                    self.pull()
        finally:
            os.close(self.fd)

    def finish(self):
        # Foreground writers have finished. A background process may still own
        # a writer; release the result now and keep draining it until EOF.
        with self.lock:
            while len(self.data) < limit and self.pull():
                pass
            result = self.data.decode("utf-8", "replace")
            self.data = None
            return result

variables = {"__name__": "__main__"}
send({"ready": True})
while True:
    header = source.read(10)
    if len(header) != 10 or not header.isdigit():
        break
    size = int(header)
    code = source.read(size)
    if len(code) != size:
        break
    importlib.invalidate_caches()
    output, errors = Capture(1), Capture(2)
    previous = sys.stdout, sys.stderr
    sys.stdout, sys.stderr = sys.__stdout__, sys.__stderr__
    ok = True
    try:
        exec(compile(code.decode("utf-8", "replace"), "<run_python>", "exec"), variables)
    except SystemExit:
        pass
    except BaseException:
        ok = False
        traceback.print_exc()
    finally:
        sys.stdout, sys.stderr = previous
        os.dup2(idle, 1)
        os.dup2(idle, 2)
    send({"stdout": output.finish(), "stderr": errors.finish(), "ok": ok})
`.trim();
}
