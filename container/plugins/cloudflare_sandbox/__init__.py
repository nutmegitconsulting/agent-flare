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
import re
import sys
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


class CloudflareSandboxEnvironment(BaseEnvironment):
    """One sandbox: a durable-object-named Cloudflare container, resumed by key."""

    # cleanup() only detaches the HTTP client; remote jobs keep running and
    # stay reachable (a fresh environment object reattaches by sandbox key).
    cleanup_stops_processes = False

    def __init__(self, cwd: str, timeout: int, *, task_id: str = "default",
                 image=None, **kwargs):
        self._url = _base_url(os.environ["CF_DEV_SANDBOX_URL"])
        self._token = os.environ.get("CF_DEV_SANDBOX_TOKEN") or ""
        self._image = image or None

        base_key = os.environ.get("CF_DEV_SANDBOX_KEY") or "default"
        self._sandbox_key = "--".join(
            _sanitize_part(part, 24) for part in (base_key, str(task_id))
        )

        # Hermes delivers a file the agent made (a screenshot, a PDF) only from a backend that says where
        # its home is; without this a MEDIA: path in the sandbox is dropped and the user gets nothing.
        self._remote_home = "/root"
        if cwd in ("", "~"):
            cwd = self._remote_home = self._resolve_home()
        super().__init__(cwd=cwd, timeout=int(timeout), **kwargs)

        # The sandbox has its own disk: without this an attached file exists only beside Hermes, and the
        # model is handed a path its commands can't open.
        self._sync_manager = None
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
        data = bytearray()
        try:
            while len(data) < size:
                piece = self._exec("tail -c +%d %s | head -c %d | base64 -w0"
                                   % (len(data) + 1, quoted, min(_GET_CHUNK, size - len(data))), timeout=60)
                chunk = base64.b64decode(piece.strip(), validate=True)
                if not chunk:
                    break
                data += chunk
        except (RuntimeError, ValueError, binascii.Error, OSError) as exc:
            raise FileFetchError("transfer of %r failed: %s" % (remote_path, exc)) from exc
        if len(data) != size:
            raise FileFetchError("%r changed while it was being read" % remote_path)
        with open(local_dest, "wb") as handle:
            handle.write(bytes(data))

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
        return "~"

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


def register(ctx):
    ctx.register_terminal_environment_provider(CloudflareSandboxProvider())
