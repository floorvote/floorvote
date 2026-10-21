import { spawn } from 'node:child_process'

// Runs a command under a pseudo-terminal, so a script that checks `[[ -t 0 ]]`
// sees a terminal on stdin. Uses python3's stdlib `pty`, which needs no native
// dependency and works on macOS and in Linux CI (the setup script already falls
// back to python3 for a UUID).
//
// `script` is a list of [expect, send] pairs. Whenever the output since the last
// send contains `expect`, `send` is typed. Nothing is typed otherwise, so a
// prompt that never appears (or appears when it should not) shows up in the
// output and in the exit code rather than as a hang: the run is killed after
// `timeoutSec` seconds without output.

const PTY_DRIVER = `
import json, os, pty, select, sys
argv = json.loads(sys.argv[1]); script = json.loads(sys.argv[2]); cwd = sys.argv[3]; idle = float(sys.argv[4])
pid, fd = pty.fork()
if pid == 0:
    os.chdir(cwd)
    os.execvp(argv[0], argv)
pending = b''
i = 0
timed_out = False
while True:
    try:
        ready, _, _ = select.select([fd], [], [], idle)
        if not ready:
            timed_out = True
            break
        data = os.read(fd, 4096)
    except OSError:
        break
    if not data:
        break
    sys.stdout.buffer.write(data)
    sys.stdout.buffer.flush()
    pending += data
    if i < len(script) and script[i][0].encode() in pending:
        os.write(fd, script[i][1].encode())
        pending = b''
        i += 1
if timed_out:
    os.kill(pid, 9)
_, status = os.waitpid(pid, 0)
if timed_out:
    sys.exit(124)
sys.exit(os.WEXITSTATUS(status) if os.WIFEXITED(status) else 128 + os.WTERMSIG(status))
`

export function runInPty(
  argv: string[],
  opts: { cwd: string; env: NodeJS.ProcessEnv; script: [string, string][]; timeoutSec?: number },
): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    const child = spawn(
      'python3',
      ['-I', '-c', PTY_DRIVER, JSON.stringify(argv), JSON.stringify(opts.script), opts.cwd, String(opts.timeoutSec ?? 30)],
      { env: opts.env, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    let out = ''
    child.stdout.on('data', (d) => { out += d })
    child.stderr.on('data', (d) => { out += d })
    child.on('close', (code) => resolve({ code: code ?? -1, out: out.replace(/\r\n/g, '\n') }))
  })
}
