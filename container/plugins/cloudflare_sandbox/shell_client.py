"""``sandbox``: an interactive shell in the dev sandbox, from a terminal beside Hermes.

Hermes' terminal pane always opens a shell on Hermes' own machine. Run there, this attaches that
terminal to a shell in the sandbox, where the agent's commands run and its files are; ``exit`` comes
back. It is the Worker's ``GET /pty`` WebSocket: binary frames are the terminal's bytes both ways,
text frames are control (``{"resize":[cols,rows]}`` out, ``{"exit":code}`` or ``{"error":...}`` in).

Standalone on purpose: it imports nothing of Hermes, only ``websockets`` from Hermes' environment.
Settings are the plugin's (``CF_DEV_SANDBOX_URL``, ``_KEY``, ``_TOKEN``, ``_ACCESS_CLIENT_ID`` and
``_ACCESS_CLIENT_SECRET``), from the environment or else from Hermes' ``.env``.
"""

import fcntl
import hashlib
import json
import os
import re
import select
import signal
import struct
import sys
import termios
import threading
import tty
from urllib.parse import urlencode

WORKSPACE = "/workspace"
_KEY_RE = re.compile(r"[^A-Za-z0-9_-]")
_PREFIX = "CF_DEV_SANDBOX_"


def _dotenv() -> dict:
    home = os.environ.get("HERMES_HOME") or os.path.expanduser("~/.hermes")
    values = {}
    try:
        with open(os.path.join(home, ".env"), encoding="utf-8") as handle:
            for line in handle:
                name, sep, value = line.strip().partition("=")
                if sep and name.startswith(_PREFIX):
                    value = value.strip()
                    if len(value) >= 2 and value[0] == value[-1] and value[0] in "'\"":
                        value = value[1:-1]
                    values[name] = value
    except OSError:
        pass
    return values


def _settings() -> dict:
    values = _dotenv()
    values.update({name: value for name, value in os.environ.items() if name.startswith(_PREFIX) and value})
    return values


def _sanitize_part(part: str, max_len: int = 24) -> str:
    # The plugin's rule (__init__.py), so the shell opens in the sandbox the agent uses.
    cleaned = _KEY_RE.sub("-", (part or "").strip()) or "default"
    if len(cleaned) > max_len:
        digest = hashlib.sha256(cleaned.encode()).hexdigest()[:12]
        cleaned = cleaned[:max_len - len(digest) - 1] + "-" + digest
    return cleaned


def sandbox_cwd(local: str, host_root: str) -> str:
    """Where the shell starts. A folder of Hermes' workspace is the same folder under /workspace, a
    path already under /workspace is itself, and anywhere else beside Hermes is the workspace."""
    local = os.path.normpath(local or "")
    host_root = os.path.normpath(host_root) if host_root.startswith("/") else ""
    if host_root and (local == host_root or local.startswith(host_root + "/")):
        return WORKSPACE + local[len(host_root):]
    if local == WORKSPACE or local.startswith(WORKSPACE + "/"):
        return local
    return WORKSPACE


def socket_url(base: str, cwd: str, cols: int, rows: int) -> str:
    base = base.strip().rstrip("/")
    if "://" not in base:
        base = "http://" + base
    scheme, _, rest = base.partition("://")
    scheme = {"http": "ws", "https": "wss"}.get(scheme, scheme)
    return "%s://%s/pty?%s" % (scheme, rest, urlencode({"cols": cols, "rows": rows, "cwd": cwd}))


def _size(fd: int) -> tuple:
    try:
        rows, cols = struct.unpack("HHHH", fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\0" * 8))[:2]
        if cols and rows:
            return cols, rows
    except OSError:
        pass
    return 80, 24


def _fail(message: str, code: int = 1) -> int:
    sys.stderr.write("sandbox: %s\n" % message)
    return code


def main(argv: list) -> int:
    if len(argv) > 1:
        sys.stdout.write("usage: sandbox\n\nOpens a shell in your sandbox, where the agent's commands run. "
                         "`exit` returns to this terminal.\n")
        return 0 if argv[1] in ("-h", "--help") else 2
    settings = _settings()
    base = settings.get(_PREFIX + "URL")
    if not base:
        return _fail("no sandbox is set up for this account (CF_DEV_SANDBOX_URL is not set)")
    stdin, stdout = sys.stdin.fileno(), sys.stdout.fileno()
    if not (os.isatty(stdin) and os.isatty(stdout)):
        return _fail("this needs a terminal; it can't be piped")

    try:
        from websockets.exceptions import ConnectionClosed, InvalidStatus
        from websockets.sync.client import connect
    except ImportError as exc:
        return _fail("the websockets library is missing (%s)" % exc)

    headers = {"X-Sandbox-Key": "--".join(
        _sanitize_part(part) for part in (settings.get(_PREFIX + "KEY") or "default", "default"))}
    if settings.get(_PREFIX + "TOKEN"):
        headers["Authorization"] = "Bearer " + settings[_PREFIX + "TOKEN"]
    if settings.get(_PREFIX + "ACCESS_CLIENT_ID") and settings.get(_PREFIX + "ACCESS_CLIENT_SECRET"):
        headers["CF-Access-Client-Id"] = settings[_PREFIX + "ACCESS_CLIENT_ID"]
        headers["CF-Access-Client-Secret"] = settings[_PREFIX + "ACCESS_CLIENT_SECRET"]

    cols, rows = _size(stdout)
    cwd = sandbox_cwd(os.getcwd(), os.environ.get("TERMINAL_CWD") or "")
    try:
        # A stopped sandbox is restored from its snapshot before the shell opens, which can take a while.
        # proxy=None: the sandbox's address is answered inside this machine, never through a proxy.
        socket = connect(socket_url(base, cwd, cols, rows), additional_headers=headers,
                         open_timeout=180, max_size=None, compression=None, proxy=None)
    except InvalidStatus as exc:
        detail = ""
        try:
            detail = json.loads(exc.response.body or b"{}").get("error") or ""
        except Exception:
            pass
        return _fail("the sandbox refused the shell (HTTP %s)%s"
                     % (exc.response.status_code, ": " + detail if detail else ""))
    except Exception as exc:
        return _fail("could not reach the sandbox: %s" % exc)

    result = {"code": 1, "error": ""}
    wake_r, wake_w = os.pipe()

    def resize(*_):
        try:
            socket.send(json.dumps({"resize": list(_size(stdout))}))
        except Exception:
            pass

    def receive():
        try:
            for message in socket:
                if isinstance(message, bytes):
                    os.write(stdout, message)
                    continue
                try:
                    note = json.loads(message)
                except ValueError:
                    continue
                if "exit" in note:
                    result["code"], result["error"] = int(note["exit"]), ""
                elif "error" in note:
                    result["error"] = str(note["error"])
        except ConnectionClosed:
            if not result["error"] and result["code"] == 1:
                result["error"] = "the connection to the sandbox closed"
        except Exception as exc:
            result["error"] = str(exc)
        finally:
            os.write(wake_w, b"x")

    saved = termios.tcgetattr(stdin)
    old_winch = signal.signal(signal.SIGWINCH, resize)
    try:
        tty.setraw(stdin, termios.TCSADRAIN)  # not the default, which throws away what was typed while connecting
        threading.Thread(target=receive, daemon=True).start()
        while True:
            try:
                ready, _, _ = select.select([stdin, wake_r], [], [])
            except InterruptedError:
                continue
            if wake_r in ready:
                break
            data = os.read(stdin, 65536)
            if not data:
                break
            try:
                socket.send(data)
            except Exception:
                break
    finally:
        termios.tcsetattr(stdin, termios.TCSADRAIN, saved)
        signal.signal(signal.SIGWINCH, old_winch)
        try:
            socket.close()
        except Exception:
            pass
    if result["error"]:
        return _fail(result["error"])
    return result["code"]


if __name__ == "__main__":
    sys.exit(main(sys.argv))
