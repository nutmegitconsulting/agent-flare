"""The `sandbox` command (shell_client.py) under a real pseudo-terminal, against a stand-in for the
Worker's GET /pty that speaks the same frames. Run with the image's Python:
    af-python /t/test_sandbox_shell.py [path/to/shell_client.py]
Set SANDBOX_SHELL_URL to run the terminal checks against a real Worker instead of the stand-in."""
import fcntl
import json
import os
import pty
import select
import signal
import struct
import sys
import tempfile
import termios
import threading
import time
from urllib.parse import parse_qs, urlparse

CLIENT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else "/opt/hermes-install/hermes-agent/plugins/cloudflare_sandbox/shell_client.py")
sys.path.insert(0, os.path.dirname(CLIENT))
import shell_client  # noqa: E402

REAL = os.environ.get("SANDBOX_SHELL_URL")
passed = 0


def ok(name, condition, detail=""):
    global passed
    if not condition:
        print("FAIL - %s %s" % (name, detail))
        sys.exit(1)
    passed += 1
    print("ok   - %s" % name)


def winsize(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


# --- stand-in Worker ---------------------------------------------------------------------------
def start_stub():
    from websockets.datastructures import Headers
    from websockets.http11 import Response
    from websockets.sync.server import serve

    def refuse(connection, request):
        if request.headers.get("X-Sandbox-Key", "").startswith("full"):
            return Response(429, "Too Many Requests", Headers({"Content-Type": "application/json"}),
                            json.dumps({"error": "8 shells are already open in this sandbox"}).encode())
        return None

    def shell(socket):
        query = parse_qs(urlparse(socket.request.path).query)
        pid, master = pty.fork()
        if pid == 0:
            os.environ.update(TERM="xterm-256color", ASKED_CWD=query["cwd"][0],
                              ASKED_KEY=socket.request.headers.get("X-Sandbox-Key", ""), PS1="$ ")
            os.execvp("bash", ["bash", "--norc", "--noprofile", "-i"])
        winsize(master, int(query["cols"][0]), int(query["rows"][0]))

        def output():
            try:
                while True:
                    data = os.read(master, 65536)
                    if not data:
                        break
                    socket.send(data)
            except OSError:
                pass
            _, status = os.waitpid(pid, 0)
            try:
                socket.send(json.dumps({"exit": os.waitstatus_to_exitcode(status)}))
                socket.close()
            except Exception:
                pass

        threading.Thread(target=output, daemon=True).start()
        try:
            for message in socket:
                if isinstance(message, bytes):
                    os.write(master, message)
                else:
                    cols, rows = json.loads(message)["resize"]
                    winsize(master, cols, rows)
        except Exception:
            pass
        try:
            os.kill(pid, signal.SIGHUP)
        except OSError:
            pass

    server = serve(shell, "127.0.0.1", 0, process_request=refuse, compression=None)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    return "http://127.0.0.1:%d" % server.socket.getsockname()[1]


# --- the command under a pseudo-terminal -------------------------------------------------------
class Terminal:
    def __init__(self, env, cwd=None, cols=90, rows=25):
        self.pid, self.fd = pty.fork()
        if self.pid == 0:
            if cwd:
                os.chdir(cwd)
            os.execve(sys.executable, [sys.executable, CLIENT], {**os.environ, **env})
        winsize(self.fd, cols, rows)
        self.seen = b""

    def expect(self, text, timeout=60):
        want = text.encode()
        start = len(self.seen)
        end = time.time() + timeout
        while want not in self.seen[start:]:
            if time.time() > end:
                ok("saw %r" % text, False, "in %r" % self.seen[start:][-600:])
            ready, _, _ = select.select([self.fd], [], [], 0.5)
            if ready:
                try:
                    self.seen += os.read(self.fd, 65536)
                except OSError:
                    break
        return self.seen[start:]

    def send(self, text):
        os.write(self.fd, text.encode())

    def run(self, command, marker):
        """Run a command and wait for a marker only its output has (never its echo)."""
        self.send(command + "\n")
        return self.expect(marker)

    def wait(self, timeout=30):
        end = time.time() + timeout
        while time.time() < end:
            try:
                ready, _, _ = select.select([self.fd], [], [], 0.2)
                if ready:
                    self.seen += os.read(self.fd, 65536)
            except OSError:
                pass
            pid, status = os.waitpid(self.pid, os.WNOHANG)
            if pid:
                return os.waitstatus_to_exitcode(status)
        ok("the command ended", False, repr(self.seen[-400:]))


def plain(env, stdin=None):
    """The command with no terminal: (exit code, what it printed)."""
    import subprocess
    done = subprocess.run([sys.executable, CLIENT], env={**os.environ, **env}, stdin=subprocess.DEVNULL,
                          capture_output=True, text=True, timeout=30)
    return done.returncode, done.stdout + done.stderr


# --- where the shell starts --------------------------------------------------------------------
root = "/home/hermes/.hermes/workspace"
ok("a folder of Hermes' workspace is the same folder in the sandbox",
   shell_client.sandbox_cwd(root + "/app/src", root) == "/workspace/app/src")
ok("Hermes' workspace folder itself is /workspace", shell_client.sandbox_cwd(root, root) == "/workspace")
ok("a path already under /workspace is kept", shell_client.sandbox_cwd("/workspace/app", root) == "/workspace/app")
ok("anywhere else starts in /workspace", shell_client.sandbox_cwd("/home/hermes", root) == "/workspace"
   and shell_client.sandbox_cwd("/home/hermes/.hermes/workspace-old", root) == "/workspace"
   and shell_client.sandbox_cwd("/tmp", "") == "/workspace")
ok("the address becomes a WebSocket one",
   shell_client.socket_url("cfsandbox.internal", "/workspace/a b", 80, 24)
   == "ws://cfsandbox.internal/pty?cols=80&rows=24&cwd=%2Fworkspace%2Fa+b"
   and shell_client.socket_url("https://x.example/", "/workspace", 1, 2).startswith("wss://x.example/pty?"))

# --- refusals that need no sandbox ---------------------------------------------------------------
empty_home = tempfile.mkdtemp()
clean = {name: "" for name in os.environ if name.startswith("CF_DEV_SANDBOX_")}
code, said = plain({**clean, "HERMES_HOME": empty_home})
ok("with no sandbox set up it says so", code == 1 and "no sandbox is set up" in said, said)

url = REAL or start_stub()
env = {**clean, "HERMES_HOME": empty_home, "CF_DEV_SANDBOX_URL": url, "CF_DEV_SANDBOX_KEY": "shelltest"}
code, said = plain(env)
ok("without a terminal it says so", code == 1 and "needs a terminal" in said, said)

# --- a session -----------------------------------------------------------------------------------
term = Terminal(env)
out = term.run("echo sum-$((6*7))", "sum-42")
ok("a command typed here runs in the shell and its output comes back", b"sum-42" in out)
ok("the shell opens at the terminal's size", b"25 90" in term.run("stty size; echo sized-$((1+1))", "sized-2"), repr(term.seen[-300:]))
winsize(term.fd, 132, 43)
time.sleep(1.5)
ok("resizing the terminal resizes the shell", b"43 132" in term.run("stty size; echo sized-$((2+1))", "sized-3"), repr(term.seen[-300:]))
term.send("sleep 60\n")
time.sleep(1)
term.send("\x03")
ok("Ctrl-C interrupts the command, not the session", b"int-130" in term.run("echo int-$?", "int-130"))
term.send("exit 3\n")
ok("`exit 3` ends the command with status 3", term.wait() == 3)

if not REAL:
    env_file = tempfile.mkdtemp()
    with open(os.path.join(env_file, ".env"), "w") as handle:
        handle.write('OTHER=1\nCF_DEV_SANDBOX_URL="%s"\nCF_DEV_SANDBOX_KEY=from file\n' % url)
    host_root = tempfile.mkdtemp()
    os.makedirs(os.path.join(host_root, "app"))
    term = Terminal({**clean, "HERMES_HOME": env_file, "TERMINAL_CWD": host_root}, cwd=os.path.join(host_root, "app"))
    out = term.run('echo "asked[$ASKED_CWD][$ASKED_KEY]"', "--default]")
    ok("settings come from Hermes' .env when the terminal's environment has none", b"[from-file--default]" in out, repr(out))
    ok("a terminal in a workspace folder opens the same folder in the sandbox", b"asked[/workspace/app]" in out, repr(out))
    term.send("exit\n")
    ok("`exit` ends the command with status 0", term.wait() == 0)

    term = Terminal({**env, "CF_DEV_SANDBOX_KEY": "full"})
    term.expect("8 shells are already open")
    ok("a refusal is shown with the sandbox's reason", term.wait() == 1)

    term = Terminal({**env, "CF_DEV_SANDBOX_URL": "http://127.0.0.1:1"})
    term.expect("could not reach the sandbox")
    ok("an unreachable sandbox is reported, and the terminal is given back", term.wait() == 1)

print("PASS: %d checks" % passed)
