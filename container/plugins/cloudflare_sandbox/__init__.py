"""Cloudflare Sandbox terminal backend for Hermes Agent.

Routes ``terminal``, ``execute_code`` and the file tools into a per-user
Cloudflare Sandbox container behind a Worker (the ``worker/`` project next to
this plugin). The sandbox is persistent: it is resumed by sandbox key from a
filesystem snapshot, so files survive idle stops and redeploys.

Design notes:
- Modeled on the built-in SSH backend: subclass ``BaseEnvironment`` and
  implement ``_run_bash()`` only — background-process plumbing, env
  persistence, cwd tracking, timeout backstop and output collection are all
  inherited.
- ``_run_bash`` spawns a *local* client subprocess (stdlib ``urllib``) that
  POSTs the command to the Worker and streams the result back, so the base
  machinery operates on a real ``Popen`` exactly as it does for SSH.
- Hermes' file browser, previews and downloads read the sandbox too: see
  ``_install_workspace_fs``.
- So does the webapp's git (worktrees, branches, the review pane): see
  ``_install_git``. A session started in a folder of the workspace runs in that
  folder in the sandbox.
- No environment variables are forwarded into the sandbox (the sandbox must
  never hold secrets; see CF sandbox security guidance). The backend's own
  token reaches the client under ``CF_SANDBOX_TOKEN`` — a different name from
  the configured ``CF_DEV_SANDBOX_TOKEN`` listed in ``strip_env_keys`` — so
  stripping never breaks the client while model-authored commands can read
  neither.

Required environment (per-user container ``.env``):
- ``CF_DEV_SANDBOX_URL``  — Worker base URL, e.g. https://sandbox.example.com
- ``CF_DEV_SANDBOX_TOKEN`` — bearer token (Worker secret ``SANDBOX_TOKEN``)
Optional (but REQUIRED for multi-user fleets — "default" makes every user
share one sandbox):
- ``CF_DEV_SANDBOX_KEY``  — per-user sandbox key prefix (delivered via the
  prefill/credentials store; keep it random per user so keys are unguessable)
"""

from __future__ import annotations

import hashlib
import json
import logging
import os
import posixpath
import re
import shlex
import sys
import threading
import urllib.request
import urllib.error

from agent.terminal_env_provider import TerminalEnvironmentProvider
from tools.environments.base import BaseEnvironment
from tools.environments.base_output import _popen_bash

logger = logging.getLogger(__name__)

# Local client that ferries one command to the Worker over HTTP. Runs as a
# subprocess so BaseEnvironment's wait/kill/collect machinery sees a real
# Popen (same shape as the SSH backend's ssh client).
_CLIENT_SCRIPT = r'''
import json, os, sys, urllib.request, urllib.error


def main():
    url = os.environ["CF_SANDBOX_URL"].rstrip("/")
    key = os.environ.get("CF_SANDBOX_KEY", "default")
    timeout = float(os.environ.get("CF_SANDBOX_TIMEOUT", "120"))
    command = sys.argv[1] if len(sys.argv) > 1 else ""
    try:
        stdin = sys.stdin.read() if not sys.stdin.isatty() else ""
    except Exception:
        stdin = ""
    body = json.dumps({
        "command": command,
        "timeout_s": int(timeout),
        "stdin": stdin,
    }).encode()
    headers = {
        "X-Sandbox-Key": key,
        "Content-Type": "application/json",
    }
    access_id = os.environ.get("CF_SANDBOX_ACCESS_ID")
    access_secret = os.environ.get("CF_SANDBOX_ACCESS_SECRET")
    if access_id and access_secret:
        # Cloudflare Access service auth: the edge validates this before the
        # request reaches the Worker; the Worker then derives the sandbox key
        # from the verified service identity.
        headers["CF-Access-Client-Id"] = access_id
        headers["CF-Access-Client-Secret"] = access_secret
    if os.environ.get("CF_SANDBOX_TOKEN"):
        headers["Authorization"] = "Bearer " + os.environ["CF_SANDBOX_TOKEN"]
    req = urllib.request.Request(
        url + "/exec",
        data=body,
        method="POST",
        headers=headers,
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout + 30) as resp:
            payload = json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode()
        except Exception:
            pass
        sys.stderr.write("cf-sandbox: HTTP %s %s\n" % (exc.code, detail))
        sys.exit(126)
    except Exception as exc:  # transport failure
        sys.stderr.write("cf-sandbox: transport error: %s\n" % exc)
        sys.exit(126)
    if payload.get("stdout"):
        sys.stdout.write(payload["stdout"])
        sys.stdout.flush()
    if payload.get("stderr"):
        sys.stderr.write(payload["stderr"])
        sys.stderr.flush()
    sys.exit(int(payload.get("exit_code") or 0))


main()
'''

_KEY_RE = re.compile(r"[^A-Za-z0-9_-]")


def _sanitize_part(part: str, max_len: int) -> str:
    cleaned = _KEY_RE.sub("-", (part or "").strip()) or "default"
    if len(cleaned) > max_len:
        # The hash stays inside the limit, so two long keys with the same start stay different.
        digest = hashlib.sha256(cleaned.encode()).hexdigest()[:12]
        cleaned = cleaned[:max_len - len(digest) - 1] + "-" + digest
    return cleaned


def _base_url(value: str) -> str:
    """CF_DEV_SANDBOX_URL with a scheme: a bare host (``cfsandbox.internal``) gets ``http://``,
    since urllib refuses a URL without one and every command would fail."""
    value = (value or "").strip().rstrip("/")
    return value if "://" in value else "http://" + value


# Where the user's uploads and skills land in the sandbox. Hermes names the same base to the model
# (``cache_path_base`` below), so a path it is told about exists where its commands run.
_SYNC_BASE = "/root/.hermes"
# The agent's working folder in the sandbox: where the terminal starts and what the file browser shows.
# Hermes' own workspace folder (``terminal.cwd``) is beside Hermes, where no command of the agent's runs.
_WORKSPACE = "/workspace"
# Raw bytes per download request: the Worker returns at most 1 MiB of output, and base64 adds a third.
_GET_CHUNK = 512 * 1024
# Raw bytes per upload request: the Worker takes 8 MiB of stdin, and base64 adds a third.
_PUT_CHUNK = 4 * 1024 * 1024


def _sync_files() -> list:
    """(host_path, sandbox_path) for what the agent must be able to read where its commands run: files
    the user attached or Hermes generated (``cache/``), and skills. Credential files are left out: the
    sandbox never holds secrets."""
    from tools.credential_files import iter_cache_files, iter_skills_files
    return [(entry["host_path"], entry["container_path"])
            for entry in (*iter_skills_files(container_base=_SYNC_BASE), *iter_cache_files(container_base=_SYNC_BASE))]


# --- One workspace, named two ways ------------------------------------------------------------
# The UI names a workspace folder either by where it is in the sandbox (/workspace/app) or under
# Hermes' own workspace folder (``terminal.cwd``, e.g. /home/hermes/.hermes/workspace/app). The files
# are only in the sandbox. Hermes still checks beside itself that a session's folder exists, so each
# sandbox folder the UI is shown gets an empty folder of the same name there.
_SKIP_FOLDERS = frozenset({".git", "node_modules"})
_MAX_FOLDERS = 2000


def _under(path: str, root) -> bool:
    return bool(root) and (path == root or path.startswith(root + "/"))


def _to_sandbox(path: str, host_root) -> str:
    """Where ``path`` is in the sandbox: a path under Hermes' workspace folder is under /workspace there."""
    return _WORKSPACE + path[len(host_root):] if _under(path, host_root) else path


def _to_host(path: str, host_root) -> str:
    return host_root + path[len(_WORKSPACE):] if host_root and _under(path, _WORKSPACE) else path


def _note_folders(paths, host_root) -> None:
    """Empty folders beside Hermes for these sandbox folders, under both names. Only for folders of
    the workspace: a sandbox folder elsewhere gets nothing made beside Hermes."""
    for path in paths:
        path = posixpath.normpath(str(path))
        inside = _to_sandbox(path, host_root)
        if not _under(inside, _WORKSPACE):
            continue
        for twin in {inside, _to_host(inside, host_root)}:
            try:
                os.makedirs(twin, exist_ok=True)
            except OSError:
                pass


def _restore_noted_folders(host_root) -> None:
    """Hermes' workspace folder is in the account's backup and /workspace beside Hermes is not: after
    a restart, the second is filled in from the first."""
    if not host_root or not os.path.isdir(host_root):
        return
    seen = 0
    for folder, names, _files in os.walk(host_root):
        names[:] = [name for name in names if name not in _SKIP_FOLDERS]
        _note_folders([folder], host_root)
        seen += 1
        if seen >= _MAX_FOLDERS:
            return


_CONFIG_LOCK = threading.Lock()
_CONFIG_CACHE: dict = {}


def _terminal_config() -> dict:
    """``terminal`` from the current profile's config.yaml, re-read at most every few seconds."""
    import time
    home = os.environ.get("HERMES_HOME") or ""
    with _CONFIG_LOCK:
        cached = _CONFIG_CACHE.get(home)
        if cached and cached[0] > time.monotonic():
            return cached[1]
    try:
        from hermes_cli.config import load_config
        terminal = dict(load_config().get("terminal") or {})
    except Exception:
        terminal = {}
    with _CONFIG_LOCK:
        _CONFIG_CACHE[home] = (time.monotonic() + 5, terminal)
    return terminal


def _host_workspace():
    """Hermes' own workspace folder when ``terminal.cwd`` names one, else None."""
    return _browser_cwd(_terminal_config().get("cwd"))[1]


class CloudflareSandboxEnvironment(BaseEnvironment):
    """One sandbox: a durable-object-named Cloudflare container, resumed by key."""

    # cleanup() only detaches the HTTP client; remote jobs keep running and
    # stay reachable (a fresh environment object reattaches by sandbox key).
    cleanup_stops_processes = False

    def __init__(self, cwd: str, timeout: int, *, task_id: str = "default",
                 image=None, sync_files: bool = True, **kwargs):
        self._url = _base_url(os.environ["CF_DEV_SANDBOX_URL"])
        self._token = os.environ.get("CF_DEV_SANDBOX_TOKEN") or ""
        self._image = image or None

        base_key = os.environ.get("CF_DEV_SANDBOX_KEY") or "default"
        self._sandbox_key = "--".join(
            _sanitize_part(part, 24) for part in (base_key, str(task_id))
        )

        # Hermes delivers a file the agent made (a screenshot, a PDF) only from a backend that says where
        # its home is; without this a MEDIA: path in the sandbox is dropped and the user gets nothing.
        self._remote_home = self._resolve_home()
        if cwd in ("", "~"):
            cwd = self._remote_home
        super().__init__(cwd=cwd, timeout=int(timeout), **kwargs)
        # Hermes reads these two off an environment to turn a path beside itself into the sandbox's (it
        # does so for a folder Docker mounts). With them a session in <terminal.cwd>/app runs its
        # commands and file tools in /workspace/app, not in /workspace.
        self.host_cwd = _host_workspace()
        self.host_cwd_mount = _WORKSPACE if self.host_cwd else None
        if cwd == _WORKSPACE:  # a sandbox saved before its image had the folder
            try:
                self._exec("mkdir -p %s" % shlex.quote(cwd), timeout=30)
            except Exception as exc:
                logger.warning("cloudflare_sandbox: could not make %s (%s)", cwd, exc)

        # The sandbox has its own disk: without this an attached file exists only beside Hermes, and the
        # model is handed a path its commands can't open.
        self._sync_manager = None
        if not sync_files:  # the file browser's reader: it runs no agent command, so it has nothing to bring
            return
        try:
            from tools.environments.file_sync import FileSyncManager
            self._sync_manager = FileSyncManager(
                get_files_fn=_sync_files, upload_fn=self._upload, delete_fn=self._delete,
                bulk_upload_fn=self._bulk_upload)
        except Exception as exc:
            logger.warning("cloudflare_sandbox: file sync is off (%s)", exc)
        self._sync(force=True)

    # --- Worker transport -------------------------------------------------
    def _request(self, path: str, payload: dict | None = None, *, timeout: float = 30) -> dict:
        headers = {
            "X-Sandbox-Key": self._sandbox_key,
            "Content-Type": "application/json",
        }
        access_id = os.environ.get("CF_DEV_SANDBOX_ACCESS_CLIENT_ID")
        access_secret = os.environ.get("CF_DEV_SANDBOX_ACCESS_CLIENT_SECRET")
        if access_id and access_secret:
            headers["CF-Access-Client-Id"] = access_id
            headers["CF-Access-Client-Secret"] = access_secret
        if self._token:
            headers["Authorization"] = "Bearer " + self._token
        req = urllib.request.Request(
            self._url + path,
            data=None if payload is None else json.dumps(payload).encode(),
            method="POST" if payload is not None else "GET",
            headers=headers,
        )
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return json.loads(resp.read().decode())

    # --- Files between Hermes' side and the sandbox --------------------------
    def _exec(self, command: str, *, stdin: str = "", timeout: int = 120) -> str:
        result = self._request("/exec", {"command": command, "timeout_s": timeout, "stdin": stdin},
                               timeout=timeout + 30)
        if int(result.get("exit_code") or 0) != 0:
            raise RuntimeError("sandbox command failed (exit %s): %s"
                               % (result.get("exit_code"), (result.get("stderr") or "")[-300:]))
        return result.get("stdout") or ""

    def fetch_file(self, remote_path: str, local_dest, *, max_bytes: int) -> None:
        """A file out of the sandbox, for delivery to the user. In pieces, because one command's output
        is capped well below the size of an ordinary screenshot."""
        import base64
        import binascii
        import shlex
        from tools.environments.base import FileFetchError
        quoted = shlex.quote(remote_path)
        try:
            size = int(self._exec("[ -f %s ] && stat -c %%s %s" % (quoted, quoted), timeout=30).strip())
        except (RuntimeError, ValueError, OSError) as exc:
            raise FileFetchError("could not read %r in the sandbox (missing, not a regular file, or unreadable)"
                                 % remote_path) from exc
        if size > max_bytes:
            raise FileFetchError("%r exceeds the %d MB delivery limit" % (remote_path, max_bytes // (1024 * 1024)))
        try:
            data = b"".join(self.read_range(remote_path, 0, size))
        except (RuntimeError, ValueError, binascii.Error, OSError) as exc:
            raise FileFetchError("transfer of %r failed: %s" % (remote_path, exc)) from exc
        if len(data) != size:
            raise FileFetchError("%r changed while it was being read" % remote_path)
        with open(local_dest, "wb") as handle:
            handle.write(data)

    def read_range(self, remote_path: str, offset: int, length: int | None):
        """Bytes of a sandbox file from ``offset``, a piece per request, until ``length`` are read or the
        file ends. Raises what ``_exec`` raises, or ``ValueError`` on output that isn't base64."""
        import base64
        import shlex
        quoted = shlex.quote(remote_path)
        done = 0
        while length is None or done < length:
            want = _GET_CHUNK if length is None else min(_GET_CHUNK, length - done)
            piece = self._exec("tail -c +%d %s | head -c %d | base64 -w0" % (offset + done + 1, quoted, want),
                               timeout=60)
            chunk = base64.b64decode(piece.strip(), validate=True)
            if chunk:
                done += len(chunk)
                yield chunk
            if len(chunk) < want:
                return

    def _upload(self, host_path: str, remote_path: str) -> None:
        """One file, in as many requests as its size needs."""
        import base64
        import shlex
        target = shlex.quote(remote_path)
        self._exec("mkdir -p %s && : > %s" % (shlex.quote(os.path.dirname(remote_path) or "/"), target))
        with open(host_path, "rb") as handle:
            while True:
                chunk = handle.read(_PUT_CHUNK)
                if not chunk:
                    break
                self._exec("base64 -d >> %s" % target, stdin=base64.b64encode(chunk).decode("ascii"))

    def _bulk_upload(self, files: list) -> None:
        """Many files as gzipped tars, each small enough for one request. A file too large for one goes
        by itself, in pieces."""
        import base64
        import io
        import tarfile
        batch: list = []
        batch_bytes = 0

        def flush() -> None:
            nonlocal batch, batch_bytes
            if not batch:
                return
            buffer = io.BytesIO()
            with tarfile.open(fileobj=buffer, mode="w:gz") as tar:
                for host_path, remote_path in batch:
                    tar.add(host_path, arcname=remote_path.lstrip("/"))
            self._exec("base64 -d | tar xzf - -C /", stdin=base64.b64encode(buffer.getvalue()).decode("ascii"))
            batch, batch_bytes = [], 0

        for host_path, remote_path in files:
            size = os.path.getsize(host_path)
            if size > _PUT_CHUNK:
                self._upload(host_path, remote_path)
                continue
            if batch_bytes + size > _PUT_CHUNK:
                flush()
            batch.append((host_path, remote_path))
            batch_bytes += size
        flush()

    def _delete(self, remote_paths: list) -> None:
        import shlex
        for start in range(0, len(remote_paths), 200):
            self._exec("rm -f " + " ".join(shlex.quote(path) for path in remote_paths[start:start + 200]), timeout=30)

    def _sync(self, *, force: bool = False) -> None:
        """Never a reason for a command to fail: a file that didn't arrive is retried on the next one."""
        if self._sync_manager is None:
            return
        try:
            self._sync_manager.sync(force=force)
        except Exception as exc:
            logger.warning("cloudflare_sandbox: file sync failed, will retry (%s)", exc)

    def _before_execute(self) -> None:
        self._sync()  # rate-limited by the manager

    def _resolve_home(self) -> str:
        try:
            return self._request("/home").get("home") or "/root"
        except Exception as exc:
            logger.warning("cloudflare_sandbox: could not resolve home (%s); using /root", exc)
            return "/root"

    # --- BaseEnvironment primitive (SSH-style) -----------------------------
    def _run_bash(self, cmd_string: str, *, login: bool = False,
                  timeout: int = 120, stdin_data: str | None = None):
        import subprocess

        client_env = dict(os.environ)
        client_env["CF_SANDBOX_URL"] = self._url
        client_env["CF_SANDBOX_TOKEN"] = self._token
        client_env["CF_SANDBOX_KEY"] = self._sandbox_key
        client_env["CF_SANDBOX_TIMEOUT"] = str(int(timeout))
        # The client reads its own names, so the Access pair has to be handed over like the token is.
        client_env["CF_SANDBOX_ACCESS_ID"] = os.environ.get("CF_DEV_SANDBOX_ACCESS_CLIENT_ID") or ""
        client_env["CF_SANDBOX_ACCESS_SECRET"] = os.environ.get("CF_DEV_SANDBOX_ACCESS_CLIENT_SECRET") or ""
        if self._image:
            client_env["CF_SANDBOX_IMAGE"] = self._image
        cmd = [sys.executable, "-c", _CLIENT_SCRIPT, cmd_string]
        return _popen_bash(cmd, stdin_data, env=client_env)

    def cleanup(self) -> None:
        # Persistent sandbox: detach only. The DO reaps it server-side
        # (snapshot on idle), never Hermes.
        return None


class CloudflareSandboxProvider(TerminalEnvironmentProvider):
    name = "cloudflare_sandbox"
    display_name = "Cloudflare Sandbox (dev)"

    is_remote = True
    is_container = True
    # Resumed by key; nonpersistent sessions must not share one live sandbox.
    session_isolated_when_nonpersistent = True

    @property
    def description(self) -> str:
        return (
            "Run commands in a persistent per-user Cloudflare Sandbox "
            "container (dev sandboxes; agent-flare Worker)."
        )

    @property
    def strip_env_keys(self) -> frozenset:
        return frozenset({
            "CF_DEV_SANDBOX_TOKEN",
            "CF_DEV_SANDBOX_ACCESS_CLIENT_ID",
            "CF_DEV_SANDBOX_ACCESS_CLIENT_SECRET",
        })

    @property
    def default_cwd(self):
        # Hermes asks this each time it finds the session's folder unusable in a container, and any
        # folder beside Hermes is. A session in a folder of Hermes' workspace starts in that folder of
        # the sandbox's workspace; every other session starts in the workspace itself.
        try:
            from tools.terminal_scope import terminal_env
            asked = posixpath.normpath(terminal_env("TERMINAL_CWD", "") or "")
            host_root = _host_workspace()
        except Exception:
            return _WORKSPACE
        return _to_sandbox(asked, host_root) if _under(asked, host_root) else _WORKSPACE

    @property
    def cache_path_base(self):
        # Attached and generated files are copied here before each command; see _sync_files.
        return _SYNC_BASE

    def is_available(self) -> bool:
        # Network-free: runs during UI paints and requirement checks.
        # Route A (internal): URL only — the agent-flare gateway stamps identity;
        # Route B (public): URL + bearer token, or URL + Access service pair.
        if not os.getenv("CF_DEV_SANDBOX_URL"):
            return False
        return (
            bool(os.getenv("CF_DEV_SANDBOX_TOKEN"))
            or (
                bool(os.getenv("CF_DEV_SANDBOX_ACCESS_CLIENT_ID"))
                and bool(os.getenv("CF_DEV_SANDBOX_ACCESS_CLIENT_SECRET"))
            )
            or "cfsandbox.internal" in os.getenv("CF_DEV_SANDBOX_URL", "")
        )

    def create_environment(self, *, cwd, timeout, task_id="default",
                           image=None, container_config=None, **kwargs):
        return CloudflareSandboxEnvironment(
            cwd=cwd, timeout=timeout, task_id=task_id, image=image, **kwargs
        )


# --- Hermes' file browser, previews and downloads ----------------------------------------------
_FS_LOCK = threading.Lock()
_FS_CACHE: dict = {}


def _browser_cwd(configured) -> tuple:
    """``(folder the file browser opens in, Hermes-side folder that stands for it or None)``. The
    browser opens where the terminal starts. A ``terminal.cwd`` that is a folder beside Hermes names
    nothing in the sandbox: the terminal drops it for the sandbox's workspace, and the UI still asks
    for files under it, so those requests are answered from the workspace."""
    cwd = str(configured or "").strip()
    if not cwd:
        return _WORKSPACE, None
    if cwd.startswith("~"):
        return cwd, None
    try:
        from tools.terminal_tool_config import _is_unusable_container_cwd
        beside_hermes = _is_unusable_container_cwd(cwd)
    except Exception:
        beside_hermes = not cwd.startswith("/") or os.path.isdir(cwd)
    if not beside_hermes:
        return cwd, None
    return _WORKSPACE, (posixpath.normpath(cwd) if cwd.startswith("/") else None)


def _install_workspace_fs() -> None:
    """Point Hermes' file routes at the sandbox. They follow the terminal to another machine only when
    the backend is ``ssh``; for any other backend the file browser, a file opened from a chat, an image
    the agent made and every download read the disk beside Hermes, where nothing the agent does lands.
    Those routes ask one function for the SSH machine's reader, so that function is wrapped here to
    answer for this backend too, with a reader that speaks to the Worker."""
    from hermes_cli import ssh_workspace_fs as module

    original = module.get_ssh_workspace_fs
    if getattr(original, "_cloudflare_sandbox", False):
        return
    error = module.SshWorkspaceFsError

    class SandboxWorkspaceFs(module.SshWorkspaceFs):
        """The SSH reader's commands, sent to the Worker. Reads go a piece per request: one command's
        output is capped at 1 MiB."""

        host_root = None  # Hermes' own workspace folder, when the UI names files under it

        def _under_host_root(self, path) -> bool:
            root = self.host_root
            return bool(root) and (path == root or path.startswith(root + "/"))

        def normalize(self, path):
            raw = str(path or "").strip()
            if self._under_host_root(raw):
                raw = self._env.cwd + raw[len(self.host_root):]
            return super().normalize(raw)

        def list_dir(self, path, hidden_names):
            listing = super().list_dir(path, hidden_names)
            asked = posixpath.normpath(str(path or "").strip() or "/")
            if self._under_host_root(asked):  # the UI places each entry under the folder it asked for
                for entry in listing["entries"]:
                    entry["path"] = posixpath.join(asked, entry["name"])
            if not listing.get("error"):  # a folder the UI is shown is one a session can be started in
                folders = [entry["path"] for entry in listing["entries"] if entry["isDirectory"]
                           and entry["name"] not in _SKIP_FOLDERS]
                _note_folders([self.normalize(asked), *folders[:200]], self.host_root)
            return listing

        def _execute(self, command, *, stdin_data=None, timeout=None):
            try:
                result = self._env._request(
                    "/exec", {"command": command, "timeout_s": 60, "stdin": stdin_data or ""}, timeout=90)
            except Exception as exc:
                raise error("ECONN", "The sandbox did not answer") from exc
            return {"output": result.get("stdout") or "", "returncode": int(result.get("exit_code") or 0)}

        def read_bytes(self, path, *, max_bytes, read_limit=None):
            target, size = self._stat(path)
            if size > max_bytes:
                raise error("EFBIG")
            return self._read(target, 0, size if read_limit is None else min(size, int(read_limit))), size, target

        def stream_file(self, path, chunk_size=64 * 1024, *, offset=0, length=None):
            target = self.normalize(path)
            try:
                yield from self._env.read_range(target, int(offset), None if length is None else int(length))
            except Exception as exc:
                raise error("EIO", "The sandbox file could not be read") from exc

        def _stat(self, path):
            """A regular file's path and size, with the SSH reader's error codes."""
            target = self.normalize(path)
            result = self._execute(
                'p=%s\n'
                'if [ ! -e "$p" ] && [ ! -L "$p" ]; then echo __HERMES_FS_ERROR__:ENOENT; exit 44; fi\n'
                'if [ ! -f "$p" ]; then echo __HERMES_FS_ERROR__:ENOTREG; exit 45; fi\n'
                'if [ ! -r "$p" ]; then echo __HERMES_FS_ERROR__:EACCES; exit 46; fi\n'
                'echo "__HERMES_FS_SIZE__:$(stat -c %%s "$p")"\n' % shlex.quote(target))
            output = result.get("output") or ""
            if result.get("returncode") != 0:
                raise error(self._error_code(output))
            try:
                return target, int(next(line.split(":", 1)[1] for line in output.splitlines()
                                        if line.startswith("__HERMES_FS_SIZE__:")))
            except (StopIteration, ValueError) as exc:
                raise error("EIO", "The sandbox did not return a file size") from exc

        def _read(self, target, offset, length) -> bytes:
            try:
                return b"".join(self._env.read_range(target, offset, length))
            except Exception as exc:
                raise error("EIO", "The sandbox file could not be read") from exc

    def get_workspace_fs(profile_key, terminal_config):
        backend = str(terminal_config.get("backend") or os.environ.get("TERMINAL_ENV") or "").strip().lower()
        if backend != CloudflareSandboxProvider.name:
            return original(profile_key, terminal_config)
        cwd, host_root = key = _browser_cwd(terminal_config.get("cwd"))
        with _FS_LOCK:
            cached = _FS_CACHE.get(profile_key)
            if cached and cached[0] == key:
                return cached[1]
            try:
                # Under the gateway route the sandbox is the signed-in user's whatever key is sent. On a
                # public route each chat has its own sandbox, and this reads the one named "default".
                env = CloudflareSandboxEnvironment(cwd=cwd, timeout=60, sync_files=False)
            except Exception as exc:
                raise error("ECONN", "The sandbox is not reachable") from exc
            fs = SandboxWorkspaceFs(env)
            fs.host_root = host_root
            _FS_CACHE[profile_key] = (key, fs)
            return fs

    get_workspace_fs._cloudflare_sandbox = True
    module.get_ssh_workspace_fs = get_workspace_fs


# --- The webapp's git: worktrees, branches, the review pane, a session's branch ------------------
# What Hermes sets for its own git calls, by name. Nothing else of Hermes' environment goes to the
# sandbox: it holds credentials.
_GIT_ENV = re.compile(
    r"^(GIT_(TERMINAL_PROMPT|CONFIG_(GLOBAL|SYSTEM|NOSYSTEM|COUNT|KEY_\d+|VALUE_\d+)|PAGER|EDITOR|OPTIONAL_LOCKS"
    r"|(AUTHOR|COMMITTER)_(NAME|EMAIL|DATE))|GCM_INTERACTIVE|PAGER|GH_PROMPT_DISABLED)$")
# The git commands whose output is a list of folders.
_GIT_PATH_FLAGS = frozenset({"--show-toplevel", "--git-common-dir", "--absolute-git-dir", "--git-dir"})
_WEB_GIT_NAMES = ("_run", "noninteractive_repo_git_env", "_is_dir", "_unique_dir", "_all_add_diff")
_PROBE_MISS_TTL = 300.0
_PROBE_LOCK = threading.Lock()
_PROBE_MISSES: dict = {}


def _git_sandbox():
    """``(reader, Hermes' workspace folder or None)`` when this profile's terminal is the sandbox, else
    None. The reader is the file browser's, so git and the browser read the same sandbox."""
    terminal = _terminal_config()
    backend = str(terminal.get("backend") or os.environ.get("TERMINAL_ENV") or "").strip().lower()
    if backend != CloudflareSandboxProvider.name:
        return None
    from hermes_cli import ssh_workspace_fs
    fs = ssh_workspace_fs.get_ssh_workspace_fs("cloudflare-sandbox-git", terminal)
    return (fs, fs.host_root) if fs is not None else None


def _git_command(argv, cwd: str, env, host_root) -> str:
    """One git (or gh) call as a sandbox command: in ``cwd``, with Hermes' git settings and no more."""
    words = ["env"] + ["%s=%s" % (key, value) for key, value in (env or {}).items() if _GIT_ENV.match(key)]
    words += [_to_sandbox(str(word), host_root) for word in argv]
    return "cd -- %s || exit 128\n%s" % (shlex.quote(_to_sandbox(cwd, host_root)), shlex.join(words))


def _git_shown(argv, output: str, host_root) -> str:
    """Folders in a command's output, named the way the UI named the folder it asked about."""
    args = [str(word) for word in argv]
    listing = "worktree" in args and "list" in args
    if not host_root or not (listing or _GIT_PATH_FLAGS.intersection(args)):
        return output
    lines = []
    for line in output.split("\n"):
        if listing and line.startswith("worktree "):
            line = "worktree " + _to_host(line[9:], host_root)
        elif not listing:
            line = _to_host(line, host_root)
        lines.append(line)
    return "\n".join(lines)


def _install_git() -> None:
    """Run the webapp's git in the sandbox. Hermes runs it beside itself, where the workspace folder is
    empty: a worktree made there is one no command of the agent's ever sees, and a folder the agent
    made is one git cannot find. Hermes has no hook for this, so the functions that reach the disk are
    wrapped; every one is checked to be there first, and the image's tests fail when one moves."""
    import subprocess
    from hermes_cli import web_git
    from hermes_cli._subprocess_compat import noninteractive_git_env
    from tui_gateway import git_probe

    if getattr(web_git._run, "_cloudflare_sandbox", False):
        return
    missing = [name for name in _WEB_GIT_NAMES if not callable(getattr(web_git, name, None))]
    if missing or not callable(getattr(git_probe, "run_git", None)):
        raise RuntimeError("Hermes' git functions moved: %s" % ", ".join(missing or ["git_probe.run_git"]))
    original = {name: getattr(web_git, name) for name in _WEB_GIT_NAMES}
    original_probe = git_probe.run_git

    def execute(fs, command, timeout):
        return fs._env._request("/exec", {"command": command, "timeout_s": int(timeout), "stdin": ""},
                                timeout=timeout + 30)

    def exists(fs, flag, path, host_root) -> bool:
        return fs._execute("[ %s %s ]" % (flag, shlex.quote(_to_sandbox(path, host_root))))["returncode"] == 0

    def run(argv, cwd, timeout, env):
        sandbox = _git_sandbox()
        if sandbox is None:
            return original["_run"](argv, cwd, timeout, env)
        fs, host_root = sandbox
        cwd = str(cwd)
        try:
            result = execute(fs, _git_command(argv, cwd, env, host_root), timeout)
        except Exception as exc:
            logger.warning("cloudflare_sandbox: git did not run in the sandbox (%s)", exc)
            return None
        code = int(result.get("exit_code") or 0)
        output = result.get("stdout") or ""
        shown_as_host = _under(cwd, host_root)
        if code == 0:
            args = [str(word) for word in argv]
            made = [word for word in args if "/.worktrees/" in word] if "worktree" in args and "add" in args else []
            _note_folders([cwd, *made], host_root)
            if made or "init" in args:
                with _PROBE_LOCK:
                    _PROBE_MISSES.clear()
        return subprocess.CompletedProcess(
            argv, code, _git_shown(argv, output, host_root) if shown_as_host else output, result.get("stderr") or "")

    def repo_env(cwd, base=None):
        # Hermes empties a repository's own filter commands before a read, by asking git beside itself
        # which ones it names. Here the repository is in the sandbox, where any command of the agent's
        # already runs; beside Hermes there is no repository to ask.
        if _git_sandbox() is None:
            return original["noninteractive_repo_git_env"](cwd, base)
        return noninteractive_git_env(base)

    def is_dir(cwd):
        sandbox = _git_sandbox()
        if sandbox is None:
            return original["_is_dir"](cwd)
        fs, host_root = sandbox
        try:
            found = exists(fs, "-d", str(cwd), host_root)
        except Exception:
            return False
        if found:
            _note_folders([str(cwd)], host_root)
        return found

    def unique_dir(base):
        sandbox = _git_sandbox()
        if sandbox is None:
            return original["_unique_dir"](base)
        fs, host_root = sandbox
        for number in range(1, 100):
            candidate = base if number == 1 else "%s-%d" % (base, number)
            if not exists(fs, "-e", candidate, host_root):
                return candidate
        raise RuntimeError("No free folder name for %s" % base)

    def all_add_diff(cwd, file_path):
        sandbox = _git_sandbox()
        if sandbox is None:
            return original["_all_add_diff"](cwd, file_path)
        fs, host_root = sandbox
        if not exists(fs, "-f", posixpath.join(str(cwd), file_path), host_root):
            return ""
        return web_git._git(cwd, ["diff", "--no-index", "--", os.devnull, file_path])[1]

    def probe(cwd, *args):
        """A session's branch and repository, for the sidebar. A folder that is no repository is asked
        about again only after a while: every question is a request that keeps the sandbox awake."""
        import time
        sandbox = _git_sandbox() if cwd else None
        if sandbox is None:
            return original_probe(cwd, *args)
        fs, host_root = sandbox
        key = (cwd, args)
        with _PROBE_LOCK:
            if _PROBE_MISSES.get(key, 0) > time.monotonic():
                return ""
        argv = ["git", "-C", cwd, *args]
        try:
            result = execute(fs, _git_command(argv, "/", noninteractive_git_env(), host_root), 10)
        except Exception:
            return ""
        output = (result.get("stdout") or "").strip() if int(result.get("exit_code") or 0) == 0 else ""
        if not output:
            with _PROBE_LOCK:
                _PROBE_MISSES[key] = time.monotonic() + _PROBE_MISS_TTL
            return ""
        return _git_shown(argv, output, host_root) if _under(cwd, host_root) else output

    run._cloudflare_sandbox = True
    web_git._run = run
    web_git.noninteractive_repo_git_env = repo_env
    web_git._is_dir = is_dir
    web_git._unique_dir = unique_dir
    web_git._all_add_diff = all_add_diff
    git_probe.run_git = probe


def register(ctx):
    ctx.register_terminal_environment_provider(CloudflareSandboxProvider())
    try:
        _install_workspace_fs()
    except Exception as exc:  # the terminal still works; the file browser shows Hermes' own disk
        logger.warning("cloudflare_sandbox: the file browser will not show the sandbox (%s)", exc)
    try:
        _install_git()
    except Exception as exc:  # worktrees and the review pane act on Hermes' own disk
        logger.warning("cloudflare_sandbox: git in the UI will not reach the sandbox (%s)", exc)
    try:
        _restore_noted_folders(_host_workspace())
    except Exception as exc:
        logger.warning("cloudflare_sandbox: workspace folders were not restored beside Hermes (%s)", exc)
