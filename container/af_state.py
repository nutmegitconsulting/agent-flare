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
import secrets
import shutil
import sqlite3
import stat
import sys
import time
from io import StringIO
from pathlib import Path

MANIFEST = ".agent-flare-manifest.json"
TEMPLATE_MARKER = ".agent-flare-template.json"
SQLITE_MAGIC = b"SQLite format 3\x00"

# Hermes' own definition of its credential stores decides what is secret. Secrets never enter a
# snapshot, because the bucket may be replicated. They're sealed into KV instead.
HERMES_SOURCE = "/opt/hermes-install/hermes-agent"
# Stores that are never sealed: rebuildable (webapp's credential is re-derived on every boot) or
# Hermes' own recovery copies of other stores.
NOT_SEALED_STORES = ("webapp", "backups", "state-snapshots")
# KV holds 25 MB per value, and sealing grows data by about 1.8x.
MAX_SEALED_BYTES = 12_000_000

# Rebuildable or process-bound, and only where Hermes itself puts them. Names like "logs" or "cache"
# inside a skill or a project are the user's data.
EXCLUDED_TOP_LEVEL = {
    "logs", "cache", "image_cache", "audio_cache", "document_cache", "browser_screenshots", "sandboxes",
    "tmp", "hermes-agent", "source-checks", "telemetry", "runtime", "plugin-update-checks",
}
EXCLUDED_TOP_LEVEL_FILES = ("*.lock", ".startup-status", "gateway_state.json", "gateway.pid", "gateway.sock")
# Never meaningful, anywhere.
EXCLUDED_DIRS = {"__pycache__", "node_modules"}
EXCLUDED_FILES = ("*.db-wal", "*.db-shm", "*.db-journal", "*.pid", "*.sock", "*.pyc")
# Hermes keeps its dependency state and Python under the home root, but the install lives in the
# image, outside the snapshot. These links bridge the two; apply recreates them after a restore.
INSTALL_ROOT = Path("/opt/hermes-install")
INSTALL_LINKS = ("installs", "tools")
# Agents work here by default, because it's inside what gets snapshotted.
WORKSPACE = "workspace"
PRIVATE_MODE = 0o600


def _credential_check():
    """Hermes' own test for "is this path a credential store". Importing it can't be optional: a
    guess here puts tokens in the bucket, so a failed import fails the snapshot."""
    if HERMES_SOURCE not in sys.path:
        sys.path.insert(0, HERMES_SOURCE)
    from hermes_cli.profiles import profile_path_is_private  # noqa: PLC0415
    return profile_path_is_private


def _is_secret(rel: str) -> bool:
    parts = tuple(Path(rel).parts)
    # A profile is a home of its own, with the same stores.
    if len(parts) >= 3 and parts[0] == "profiles":
        parts = parts[2:]
    return _credential_check()(parts)


def _is_critical_db(rel: str) -> bool:
    """Databases Hermes can't run without. Others are the user's project files: copied as well as
    possible, and never a reason to refuse a snapshot or distrust a restore."""
    parts = Path(rel).parts
    if len(parts) >= 3 and parts[0] == "profiles":
        parts = parts[2:]
    return parts in (("state.db",), ("cron", "executions.db"))


def _is_excluded_file(rel: str, name: str) -> bool:
    if any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_FILES):
        return True
    return "/" not in rel and any(fnmatch.fnmatch(name, pattern) for pattern in EXCLUDED_TOP_LEVEL_FILES)


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
    _credential_check()
    # Hydration always writes config.yaml. Without it the home is gone or going, as in a container
    # that's shutting down, and an empty backup would outrank every good one.
    if not (home / "config.yaml").is_file():
        raise RuntimeError(f"refusing to snapshot {home}: no config.yaml")
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
            if name in EXCLUDED_DIRS or _is_secret(rel) or (not rel_root and (name in EXCLUDED_TOP_LEVEL or name in INSTALL_LINKS)):
                continue
            if os.path.islink(os.path.join(root, name)):
                os.symlink(os.readlink(os.path.join(root, name)), stage_dir / rel)
                files += 1
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
            # The manifest restored from the previous snapshot describes that one, not this one.
            if rel == MANIFEST or _is_secret(rel) or _is_excluded_file(rel, name):
                continue
            critical = _is_critical_db(rel)
            try:
                info = src.lstat()
                if stat.S_ISLNK(info.st_mode):
                    os.symlink(os.readlink(src), dst)
                elif not stat.S_ISREG(info.st_mode):
                    continue
                elif critical or _is_sqlite(src):
                    try:
                        _copy_sqlite(src, dst)
                    except sqlite3.Error:
                        if critical:
                            raise
                        dst.unlink(missing_ok=True)
                        shutil.copy2(src, dst)
                    if critical:
                        _check_database(dst, rel)
                        databases.append(rel)
                else:
                    shutil.copy2(src, dst)
                files += 1
                bytes_total += dst.lstat().st_size
            except (OSError, sqlite3.Error) as exc:
                # A critical database we can't capture must fail the snapshot, not produce a backup
                # that replaces a good one. Any other file can vanish mid-walk; note it and carry on.
                if critical:
                    raise RuntimeError(f"could not capture database {rel}: {exc}") from exc
                skipped.append(rel)
    manifest = {"created": int(time.time()), "files": files, "bytes": bytes_total,
                "databases": databases, "skipped": skipped}
    (stage_dir / MANIFEST).write_text(json.dumps(manifest), encoding="utf-8")
    return manifest


def _check_database(path: Path, rel: str) -> None:
    if path.stat().st_size == 0:
        raise RuntimeError(f"database is empty: {rel}")
    connection = sqlite3.connect(f"file:{path}?mode=ro", uri=True, timeout=30)
    try:
        result = connection.execute("PRAGMA quick_check").fetchone()
    finally:
        connection.close()
    if not result or result[0] != "ok":
        raise RuntimeError(f"database failed quick_check: {rel}")


def seal_read(home: Path) -> dict:
    """Secret files as base64, for the Worker to encrypt. Smallest first, so if there's more than
    fits, what's dropped is the bulky browser data rather than API keys. Dropped paths are reported."""
    _credential_check()
    candidates: list[tuple[int, str]] = []
    for root, dirs, names in os.walk(home, followlinks=False):
        rel_root = os.path.relpath(root, home)
        rel_root = "" if rel_root == "." else rel_root
        dirs[:] = [d for d in dirs if not (not rel_root and (d in EXCLUDED_TOP_LEVEL or d in INSTALL_LINKS or d in NOT_SEALED_STORES))
                   and d not in EXCLUDED_DIRS]
        for name in names:
            rel = os.path.join(rel_root, name)
            path = Path(root) / name
            if _is_excluded_file(rel, name) or path.is_symlink() or not path.is_file() or not _is_secret(rel):
                continue
            candidates.append((path.stat().st_size, rel))
    files: dict[str, str] = {}
    dropped: list[str] = []
    total = 0
    for size, rel in sorted(candidates):
        if total + size > MAX_SEALED_BYTES:
            dropped.append(rel)
            continue
        total += size
        files[rel] = base64.b64encode((home / rel).read_bytes()).decode()
    return {"files": files, "dropped": dropped, "bytes": total}


def verify(home: Path) -> dict:
    """Trust a restored tree only if it holds everything its manifest promised."""
    problems: list[str] = []
    manifest_path = home / MANIFEST
    if not manifest_path.is_file():
        return {"ok": False, "problems": ["manifest missing"]}
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    except ValueError as exc:
        return {"ok": False, "problems": [f"manifest unreadable: {exc}"]}

    files = bytes_total = 0
    for root, dirs, names in os.walk(home, followlinks=False):
        linked = [d for d in dirs if os.path.islink(os.path.join(root, d))]
        files += len(linked)
        dirs[:] = [d for d in dirs if d not in linked]
        for name in names:
            path = Path(root) / name
            if path == manifest_path:
                continue
            files += 1
            bytes_total += path.lstat().st_size
    if not (home / "config.yaml").is_file():
        problems.append("config.yaml missing")
    if files != manifest.get("files"):
        problems.append(f"expected {manifest.get('files')} files, found {files}")
    if bytes_total != manifest.get("bytes"):
        problems.append(f"expected {manifest.get('bytes')} bytes, found {bytes_total}")

    for rel in manifest.get("databases", []):
        path = home / rel
        if not path.is_file():
            problems.append(f"database missing: {rel}")
            continue
        try:
            _check_database(path, rel)
        except (RuntimeError, sqlite3.Error) as exc:
            problems.append(f"{rel}: {exc}")
    return {"ok": not problems, "problems": problems, "files": files, "bytes": bytes_total}


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


def _env_values(path: Path) -> dict[str, str]:
    if not path.exists():
        return {}
    pairs = (line.split("=", 1) for line in path.read_text(encoding="utf-8").splitlines() if "=" in line)
    return {key.strip(): value.strip() for key, value in pairs if not key.lstrip().startswith("#")}


def _select_provider(config: dict, candidates: list[dict], env: dict[str, str], ours: str | None,
                     our_model: str | None = None) -> str | None:
    """Make the template's first provider with a credential the selected one. Hermes needs this: a
    provider that's only listed leaves it reporting that nothing is connected. Runs on every boot, so a
    secret added later takes effect, but it never overrides a choice the user made. A selection this
    code made is replaced once its credential has gone, or when the role's default changes.
    Returns what this code has selected, if anything."""
    usable = [c for c in candidates if env.get(c["key_env"])]
    model = config.get("model")
    current = model.get("provider") if isinstance(model, dict) else None
    # Anything that names a model is a choice; only an empty slot is ours to fill.
    empty = not model or (isinstance(model, dict) and not model.get("default") and not model.get("model"))
    stale = bool(ours) and current == ours and not any(c["provider"] == ours for c in usable)
    if not empty and not stale:
        if current != ours or not ours:
            return None
        if our_model and model.get("default") != our_model:
            return None  # Same provider, but the user picked another model.
        if usable and our_model and usable[0]["provider"] == ours and usable[0]["model"] != our_model:
            model["default"] = usable[0]["model"]
        return ours
    if usable:
        config["model"] = {"default": usable[0]["model"], "provider": usable[0]["provider"]}
        return usable[0]["provider"]
    config.pop("model", None)
    return None


def _seed_ui_preferences(home: Path, defaults: dict[str, str]) -> list[str]:
    """Add webapp preferences the store lacks, in the document Hermes's own ui_preferences module writes.
    Never changes one that's there: that's the user's. An unreadable store is Hermes's to deal with."""
    path = home / "ui-preferences.json"
    document: dict = {}
    if path.exists():
        try:
            document = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            return []
        if not isinstance(document, dict):
            return []
    values = document.get("values") if isinstance(document.get("values"), dict) else {}
    added = [key for key in defaults if key not in values]
    if not added:
        return []
    revision = document.get("revision") if isinstance(document.get("revision"), int) else 0
    _write(path, json.dumps({
        "version": 1, "generation": document.get("generation") or secrets.token_hex(8), "revision": revision + 1,
        "values": {**values, **{key: defaults[key] for key in added}},
    }).encode())
    return added


def apply(home: Path, bundle_path: Path) -> dict:
    from ruamel.yaml import YAML
    from ruamel.yaml.error import YAMLError

    bundle = json.loads(bundle_path.read_text(encoding="utf-8"))
    home.mkdir(parents=True, exist_ok=True)
    report = {"sealed": 0, "template_files": 0, "template": None, "config_recovered": False}
    if INSTALL_ROOT.is_dir():
        for name in INSTALL_LINKS:
            link = home / name
            if not link.is_symlink():
                if link.exists():
                    shutil.rmtree(link)
                link.symlink_to(INSTALL_ROOT / name)
    (home / WORKSPACE).mkdir(exist_ok=True)

    for rel, content in bundle.get("sealed", {}).items():
        _write(_safe_path(home, rel), base64.b64decode(content), PRIVATE_MODE)
        report["sealed"] += 1

    marker_path = home / TEMPLATE_MARKER
    try:
        marker = json.loads(marker_path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        marker = {}
    first_launch = not marker
    template = bundle.get("template") or {}
    # A template's defaults and files apply the first time a user gets that template, which may be
    # long after their first launch: assigning someone a template later still fills them in.
    new_template = bool(template) and marker.get("name") != template.get("name")
    if new_template:
        for entry in template.get("files", []):
            path = _safe_path(home, entry["path"])
            if not path.exists():
                _write(path, base64.b64decode(entry["content"]), entry.get("mode"))
                report["template_files"] += 1
    report["template"] = template.get("name")

    yaml = YAML()
    yaml.preserve_quotes = True
    config_path = home / "config.yaml"
    config = None
    if config_path.exists():
        try:
            config = yaml.load(config_path.read_text(encoding="utf-8"))
        except (YAMLError, UnicodeDecodeError):
            # A user's broken config must not stop their agent booting. It's kept, not lost.
            os.replace(config_path, home / f"config.yaml.corrupt.{int(time.time())}")
            report["config_recovered"] = True
            first_launch = True
    config = config if isinstance(config, dict) else {}
    if first_launch:
        _fill_defaults(config, bundle.get("platform_defaults") or {})
    if first_launch or new_template:
        _fill_defaults(config, bundle.get("config_defaults") or {})
    managed_config = bundle.get("config_managed") or {}
    # Providers the last boot managed and this one doesn't must leave, or Hermes keeps listing them.
    current_providers = {p["name"] for p in managed_config.get("custom_providers", [])}
    dropped_providers = set(marker.get("managed_providers", [])) - current_providers
    if dropped_providers and isinstance(config.get("custom_providers"), list):
        config["custom_providers"] = [p for p in config["custom_providers"]
                                      if not (isinstance(p, dict) and p.get("name") in dropped_providers)]
    _deep_merge(config, managed_config)

    env_path = home / ".env"
    lines = env_path.read_text(encoding="utf-8").splitlines() if env_path.exists() else []
    existing = {line.split("=", 1)[0].strip() for line in lines}
    managed = bundle.get("env") or {}
    # Values the last template managed and this one doesn't must leave, or a removed shared token
    # would stay in .env and be resealed on every snapshot.
    removed = set(marker.get("managed_env", [])) - set(managed)
    if removed:
        lines = [line for line in lines if line.split("=", 1)[0].strip() not in removed]
        _write(env_path, ("\n".join(lines) + "\n").encode(), PRIVATE_MODE)
    env = {k: v for k, v in (bundle.get("env_defaults") or {}).items() if k not in existing}
    env.update(managed)
    if env:
        _update_env(env_path, env)

    candidates = bundle.get("provider_candidates") or []
    env_values = _env_values(env_path)
    selected = _select_provider(config, candidates, env_values, marker.get("selected_provider"),
                                marker.get("selected_model"))
    model = config.get("model")
    report["inference"] = {  # Names only: this goes to the logs.
        "selected": model.get("provider") if isinstance(model, dict) else ("auto" if model else None),
        "missing": sorted({c["key_env"] for c in candidates if not env_values.get(c["key_env"])}),
    }

    buffer = StringIO()
    yaml.dump(config, buffer)
    _write(config_path, buffer.getvalue().encode())

    _write(marker_path, json.dumps({
        "name": template.get("name"), "applied": int(time.time()), "managed_env": sorted(managed),
        "managed_providers": sorted(current_providers), "selected_provider": selected,
        "selected_model": model.get("default") if selected and isinstance(model, dict) else None,
    }).encode())

    session_token = bundle.get("session_token")
    if session_token:
        _write(home / "webapp" / "session-token", (session_token + "\n").encode(), PRIVATE_MODE)
        os.chmod(home / "webapp", 0o700)

    report["ui_defaults"] = _seed_ui_preferences(home, bundle.get("ui_defaults") or {})

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
