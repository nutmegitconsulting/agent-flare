#!/usr/bin/env python3
"""Container side of Agent Flare state handling. The Worker drives it through sandbox.exec.

  stage <home> <stage_dir>   Build a consistent copy of <home> to snapshot, minus excludes and secrets.
  seal-read <home>           Print the secret files as JSON (the Worker encrypts them into KV).
  verify <home>              Check a restored tree. Exit 1 when it can't be trusted.
  apply <home> <bundle>      Write sealed files, template files, managed config and env, from a JSON bundle.

Runs with af-python, the Hermes venv, which provides ruamel.yaml.
"""
from __future__ import annotations

import base64
import fnmatch
import json
import os
import shutil
import sqlite3
import stat
import sys
import time
from pathlib import Path

MANIFEST = ".agent-flare-manifest.json"
TEMPLATE_MARKER = ".agent-flare-template.json"
SQLITE_MAGIC = b"SQLite format 3\x00"

# Secrets never enter a snapshot: the bucket may be replicated. They're sealed into KV instead.
SECRET_PATHS = (".env", "auth.json", "auth.lock", "mcp-tokens", "webapp")
# Rebuildable or process-bound files. Keeping them out is what keeps snapshots small.
EXCLUDED_DIRS = {
    "logs", "cache", "image_cache", "audio_cache", "document_cache", "browser_screenshots",
    "sandboxes", "tmp", "node_modules", "__pycache__", ".cache", ".npm", ".venv", "venv",
}
EXCLUDED_FILES = ("*.db-wal", "*.db-shm", "*.db-journal", "*.pid", "*.lock", "*.sock", "*.tmp",
                  "*.pyc", ".startup-status", "gateway_state.json")
# Hermes keeps its dependency state and Python under the home root, but the install lives in the
# image, outside the snapshot. These links bridge the two; apply recreates them after a restore.
INSTALL_ROOT = Path("/opt/hermes-install")
INSTALL_LINKS = ("installs", "tools")
EXCLUDED_TOP_LEVEL = {*INSTALL_LINKS, "hermes-agent", "source-checks", "telemetry", "backups", "runtime",
                      "plugin-update-checks"}
# Files holding secrets get these modes, whatever a restore or template left behind.
PRIVATE_MODE = 0o600


def _is_secret(rel: str) -> bool:
    return any(rel == p or rel.startswith(p + "/") for p in SECRET_PATHS)


def _is_excluded_file(name: str) -> bool:
    return any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_FILES)


def _is_sqlite(path: Path) -> bool:
    try:
        with path.open("rb") as handle:
            return handle.read(16) == SQLITE_MAGIC
    except OSError:
        return False


def _copy_sqlite(src: Path, dst: Path) -> None:
    """SQLite's backup API: a consistent copy including whatever is still in the WAL, safe while
    Hermes writes. A plain file copy of a live WAL database is how snapshots came back corrupt."""
    source = sqlite3.connect(f"file:{src}?mode=ro", uri=True, timeout=30)
    try:
        target = sqlite3.connect(dst)
        try:
            source.backup(target)
            target.execute("PRAGMA journal_mode=DELETE")
        finally:
            target.close()
    finally:
        source.close()


def stage(home: Path, stage_dir: Path) -> dict:
    if stage_dir.exists():
        shutil.rmtree(stage_dir)
    stage_dir.mkdir(parents=True)
    os.chmod(stage_dir, 0o700)
    files = bytes_total = 0
    databases: list[str] = []
    skipped: list[str] = []
    for root, dirs, names in os.walk(home, followlinks=False):
        rel_root = os.path.relpath(root, home)
        rel_root = "" if rel_root == "." else rel_root
        kept = []
        for name in dirs:
            rel = os.path.join(rel_root, name)
            if name in EXCLUDED_DIRS or _is_secret(rel) or (not rel_root and name in EXCLUDED_TOP_LEVEL):
                continue
            if os.path.islink(os.path.join(root, name)):
                os.symlink(os.readlink(os.path.join(root, name)), stage_dir / rel)
                continue
            kept.append(name)
            target = stage_dir / rel
            target.mkdir(exist_ok=True)
            shutil.copystat(os.path.join(root, name), target, follow_symlinks=False)
        dirs[:] = kept
        for name in names:
            rel = os.path.join(rel_root, name)
            src = Path(root) / name
            dst = stage_dir / rel
            if _is_secret(rel) or _is_excluded_file(name):
                continue
            try:
                info = src.lstat()
                if stat.S_ISLNK(info.st_mode):
                    os.symlink(os.readlink(src), dst)
                elif not stat.S_ISREG(info.st_mode):
                    continue
                elif _is_sqlite(src):
                    _copy_sqlite(src, dst)
                    databases.append(rel)
                else:
                    shutil.copy2(src, dst)
                files += 1
                bytes_total += dst.lstat().st_size
            except (OSError, sqlite3.Error) as exc:
                # A database we can't copy consistently must fail the snapshot. Any other file can
                # vanish mid-walk (Hermes rotates temp files), so note it and carry on.
                if _is_sqlite(src):
                    raise RuntimeError(f"could not copy database {rel}: {exc}") from exc
                skipped.append(rel)
    manifest = {"created": int(time.time()), "files": files, "bytes": bytes_total,
                "databases": databases, "skipped": skipped}
    (stage_dir / MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


def seal_read(home: Path) -> dict:
    out: dict[str, str] = {}
    for rel in SECRET_PATHS:
        path = home / rel
        if path.is_file():
            out[rel] = base64.b64encode(path.read_bytes()).decode()
        elif path.is_dir():
            for sub in path.rglob("*"):
                if sub.is_file() and not sub.is_symlink() and not _is_excluded_file(sub.name):
                    out[str(sub.relative_to(home))] = base64.b64encode(sub.read_bytes()).decode()
    return out


def verify(home: Path) -> dict:
    """Trust a restored tree only if it matches what its manifest promised."""
    problems: list[str] = []
    manifest_path = home / MANIFEST
    if not manifest_path.is_file():
        return {"ok": False, "problems": ["manifest missing"]}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return {"ok": False, "problems": [f"manifest unreadable: {exc}"]}
    for rel in manifest.get("databases", []):
        path = home / rel
        if not path.is_file():
            problems.append(f"database missing: {rel}")
            continue
        try:
            connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
            try:
                result = connection.execute("PRAGMA quick_check").fetchone()
            finally:
                connection.close()
            if not result or result[0] != "ok":
                problems.append(f"database failed quick_check: {rel}")
        except sqlite3.Error as exc:
            problems.append(f"database unreadable: {rel}: {exc}")
    return {"ok": not problems, "problems": problems, "files": manifest.get("files"),
            "bytes": manifest.get("bytes")}


def _safe_path(home: Path, rel: str) -> Path:
    path = (home / rel).resolve()
    if path != home.resolve() and home.resolve() not in path.parents:
        raise ValueError(f"path escapes home: {rel!r}")
    return path


def _write(path: Path, data: bytes, mode: int | None = None) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + ".af-tmp")
    fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, mode if mode is not None else 0o644)
    with os.fdopen(fd, "wb") as handle:
        handle.write(data)
    if mode is not None:
        os.chmod(temporary, mode)
    os.replace(temporary, path)


def _deep_merge(base, overlay):
    """Overlay wins. Mappings merge key by key, in place, so ruamel keeps the file's comments. A
    list of named entries (custom_providers) merges by name, so a user's own entries survive."""
    for key, value in overlay.items():
        current = base.get(key)
        if isinstance(value, dict) and isinstance(current, dict):
            _deep_merge(current, value)
        elif (isinstance(value, list) and isinstance(current, list)
              and all(isinstance(e, dict) and "name" in e for e in [*value, *current])):
            names = {e["name"] for e in value}
            base[key] = [e for e in current if e["name"] not in names] + value
        else:
            base[key] = value
    return base


def _fill_defaults(base, defaults):
    """Base wins: add only what's absent, so a user's later edits to a default survive."""
    for key, value in defaults.items():
        if key not in base:
            base[key] = value
        elif isinstance(value, dict) and isinstance(base[key], dict):
            _fill_defaults(base[key], value)
    return base


def _update_env(path: Path, updates: dict[str, str]) -> None:
    lines = path.read_text(encoding="utf-8").splitlines() if path.exists() else []
    lines = [line for line in lines if line.split("=", 1)[0].strip() not in updates]
    lines.extend(f"{key}={value}" for key, value in updates.items())
    _write(path, ("\n".join(lines) + "\n").encode(), PRIVATE_MODE)


def apply(home: Path, bundle_path: Path) -> dict:
    from ruamel.yaml import YAML

    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    home.mkdir(parents=True, exist_ok=True)
    report = {"sealed": 0, "template_files": 0, "template": None}
    if INSTALL_ROOT.is_dir():
        for name in INSTALL_LINKS:
            link = home / name
            if not link.is_symlink():
                if link.exists():
                    shutil.rmtree(link)
                link.symlink_to(INSTALL_ROOT / name)

    for rel, content in bundle.get("sealed", {}).items():
        _write(_safe_path(home, rel), base64.b64decode(content), PRIVATE_MODE)
        report["sealed"] += 1

    template = bundle.get("template") or {}
    marker = home / TEMPLATE_MARKER
    first_launch = not marker.exists()
    if template and first_launch:
        for entry in template.get("files", []):
            path = _safe_path(home, entry["path"])
            if not path.exists():
                _write(path, base64.b64decode(entry["content"]), entry.get("mode"))
                report["template_files"] += 1
    if template:
        report["template"] = template.get("name")
        _write(marker, json.dumps(
            {"name": template.get("name"), "applied": int(time.time())}).encode())

    yaml = YAML()
    yaml.preserve_quotes = True
    config_path = home / "config.yaml"
    config = yaml.load(config_path.read_text(encoding="utf-8")) if config_path.exists() else None
    config = config if isinstance(config, dict) else {}
    if first_launch:
        _fill_defaults(config, bundle.get("config_defaults") or {})
    _deep_merge(config, bundle.get("config_managed") or {})
    from io import StringIO
    buffer = StringIO()
    yaml.dump(config, buffer)
    _write(config_path, buffer.getvalue().encode())

    env_path = home / ".env"
    existing = set()
    if env_path.exists():
        existing = {line.split("=", 1)[0].strip() for line in env_path.read_text(encoding="utf-8").splitlines()}
    env = {k: v for k, v in (bundle.get("env_defaults") or {}).items() if k not in existing}
    env.update(bundle.get("env") or {})
    if env:
        _update_env(env_path, env)

    session_token = bundle.get("session_token")
    if session_token:
        _write(home / "webapp" / "session-token", (session_token + "\n").encode(), PRIVATE_MODE)
        os.chmod(home / "webapp", 0o700)

    for rel in (".env", "auth.json"):
        path = home / rel
        if path.exists():
            os.chmod(path, PRIVATE_MODE)
    return report


def main(argv: list[str]) -> int:
    command = argv[1] if len(argv) > 1 else ""
    if command == "stage" and len(argv) == 4:
        print(json.dumps(stage(Path(argv[2]), Path(argv[3]))))
        return 0
    if command == "seal-read" and len(argv) == 3:
        print(json.dumps(seal_read(Path(argv[2]))))
        return 0
    if command == "verify" and len(argv) == 3:
        result = verify(Path(argv[2]))
        print(json.dumps(result))
        return 0 if result["ok"] else 1
    if command == "apply" and len(argv) == 4:
        print(json.dumps(apply(Path(argv[2]), Path(argv[3]))))
        return 0
    print(__doc__, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
