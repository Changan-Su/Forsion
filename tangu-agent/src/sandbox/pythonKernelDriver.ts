/** Python runs with -u. Children inherit the capture files while the driver alone owns the protocol streams. */
export function pythonKernelDriver(maxCapture: number): string {
  return `
import importlib, json, os, sys, tempfile, traceback

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

def read_output(file):
    file.seek(0)
    return file.read(limit).decode("utf-8", "replace")

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
    with tempfile.TemporaryFile() as output, tempfile.TemporaryFile() as errors:
        os.dup2(output.fileno(), 1)
        os.dup2(errors.fileno(), 2)
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
        send({"stdout": read_output(output), "stderr": read_output(errors), "ok": ok})
`.trim();
}
