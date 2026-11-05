"""Run with the image's Python: see tests/container/run.sh."""
import base64
import json
import sqlite3
import sys
import tempfile
import threading
import unittest
from pathlib import Path

sys.path.insert(0, "/usr/local/lib")
import af_state  # noqa: E402


def b64(text):
    return base64.b64encode(text.encode()).decode()


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name) / "home"
        self.stage = Path(self.tmp.name) / "stage"
        self.home.mkdir()

    def tearDown(self):
        self.tmp.cleanup()

    def bundle(self, **fields):
        path = Path(self.tmp.name) / "bundle.json"
        path.write_text(json.dumps(fields))
        return af_state.apply(self.home, path)


class Stage(Base):
    def test_leaves_out_secrets_and_junk_keeps_the_rest(self):
        (self.home / "config.yaml").write_text("a: 1\n")
        (self.home / ".env").write_text("KEY=secret\n")
        (self.home / "auth.json").write_text("{}")
        (self.home / "webapp").mkdir()
        (self.home / "webapp/session-token").write_text("t")
        (self.home / "logs").mkdir()
        (self.home / "logs/big.log").write_text("x" * 1000)
        (self.home / "skills/a").mkdir(parents=True)
        (self.home / "skills/a/SKILL.md").write_text("s")
        (self.home / "gateway.pid").write_text("1")
        manifest = af_state.stage(self.home, self.stage)
        names = {str(p.relative_to(self.stage)) for p in self.stage.rglob("*") if p.is_file()}
        self.assertEqual(names, {"config.yaml", "skills/a/SKILL.md", af_state.MANIFEST})
        self.assertEqual(manifest["files"], 2)

    def test_copies_a_wal_database_while_it_is_being_written(self):
        db = self.home / "state.db"
        live = sqlite3.connect(db, check_same_thread=False)
        live.execute("PRAGMA journal_mode=WAL")
        live.execute("CREATE TABLE t (n INTEGER)")
        live.commit()
        stop = threading.Event()

        def writer():
            n = 0
            while not stop.is_set():
                live.execute("INSERT INTO t VALUES (?)", (n,))
                live.commit()
                n += 1

        thread = threading.Thread(target=writer)
        thread.start()
        try:
            for _ in range(5):
                manifest = af_state.stage(self.home, self.stage)
                self.assertEqual(manifest["databases"], ["state.db"])
                self.assertFalse((self.stage / "state.db-wal").exists())
                self.assertTrue(af_state.verify(self.stage)["ok"])
                copy = sqlite3.connect(self.stage / "state.db")
                self.assertEqual(copy.execute("PRAGMA quick_check").fetchone()[0], "ok")
                copy.close()
        finally:
            stop.set()
            thread.join()
        count = sqlite3.connect(self.stage / "state.db").execute("SELECT count(*) FROM t").fetchone()[0]
        self.assertGreater(count, 0)
        live.close()

    def test_a_wal_only_commit_reaches_the_copy(self):
        db = self.home / "state.db"
        live = sqlite3.connect(db)
        live.execute("PRAGMA journal_mode=WAL")
        live.execute("PRAGMA wal_autocheckpoint=0")
        live.execute("CREATE TABLE t (n INTEGER)")
        live.execute("INSERT INTO t VALUES (42)")
        live.commit()
        self.assertTrue((self.home / "state.db-wal").stat().st_size > 0)
        af_state.stage(self.home, self.stage)
        copy = sqlite3.connect(self.stage / "state.db")
        self.assertEqual(copy.execute("SELECT n FROM t").fetchone()[0], 42)


class Verify(Base):
    def test_no_manifest_is_untrusted(self):
        self.assertFalse(af_state.verify(self.home)["ok"])

    def test_missing_or_corrupt_database_is_untrusted(self):
        sqlite3.connect(self.home / "state.db").executescript("CREATE TABLE t (n); INSERT INTO t VALUES (1);")
        af_state.stage(self.home, self.stage)
        self.assertTrue(af_state.verify(self.stage)["ok"])
        raw = (self.stage / "state.db").read_bytes()
        (self.stage / "state.db").write_bytes(raw[:100] + b"\xff" * (len(raw) - 100))
        self.assertFalse(af_state.verify(self.stage)["ok"])
        (self.stage / "state.db").unlink()
        self.assertFalse(af_state.verify(self.stage)["ok"])


class SealRead(Base):
    def test_returns_secret_files_only(self):
        (self.home / ".env").write_text("K=v\n")
        (self.home / "config.yaml").write_text("a: 1\n")
        (self.home / "mcp-tokens").mkdir()
        (self.home / "mcp-tokens/x.json").write_text("{}")
        sealed = af_state.seal_read(self.home)
        self.assertEqual(set(sealed), {".env", "mcp-tokens/x.json"})
        self.assertEqual(base64.b64decode(sealed[".env"]), b"K=v\n")


class Apply(Base):
    def config(self):
        from ruamel.yaml import YAML
        return YAML().load((self.home / "config.yaml").read_text())

    def test_template_fills_first_launch_only(self):
        template = {"name": "t", "files": [{"path": "SOUL.md", "content": b64("v1")}]}
        report = self.bundle(template=template, config_defaults={"model": "m1", "display": {"theme": "x"}})
        self.assertEqual(report["template_files"], 1)
        self.assertEqual((self.home / "SOUL.md").read_text(), "v1")
        self.assertEqual(self.config()["model"], "m1")

        # The user edits things, and the template later changes. The user's edits stand.
        (self.home / "SOUL.md").write_text("mine")
        (self.home / "config.yaml").write_text("model: mine\n")
        template["files"][0]["content"] = b64("v2")
        report = self.bundle(template=template, config_defaults={"model": "m2"})
        self.assertEqual(report["template_files"], 0)
        self.assertEqual((self.home / "SOUL.md").read_text(), "mine")
        self.assertEqual(self.config()["model"], "mine")

    def test_managed_keys_win_every_boot_and_keep_user_keys_and_comments(self):
        (self.home / "config.yaml").write_text("# my note\nmodel: mine\nwebapp:\n  port: 1\n  extra: keep\n")
        self.bundle(config_managed={"webapp": {"port": 443, "enabled": True}})
        text = (self.home / "config.yaml").read_text()
        self.assertIn("# my note", text)
        config = self.config()
        self.assertEqual(config["model"], "mine")
        self.assertEqual(dict(config["webapp"]), {"port": 443, "extra": "keep", "enabled": True})

    def test_named_lists_merge_by_name(self):
        (self.home / "config.yaml").write_text(
            "custom_providers:\n- name: mine\n  base_url: u\n- name: gw\n  base_url: old\n")
        self.bundle(config_managed={"custom_providers": [{"name": "gw", "base_url": "new"}]})
        providers = {p["name"]: p["base_url"] for p in self.config()["custom_providers"]}
        self.assertEqual(providers, {"mine": "u", "gw": "new"})

    def test_env_defaults_yield_to_the_user_and_managed_env_does_not(self):
        (self.home / ".env").write_text("USER_KEY=mine\nMANAGED=old\n")
        self.bundle(env_defaults={"USER_KEY": "prefill", "NEW": "n"}, env={"MANAGED": "new"})
        lines = dict(l.split("=", 1) for l in (self.home / ".env").read_text().splitlines())
        self.assertEqual(lines, {"USER_KEY": "mine", "NEW": "n", "MANAGED": "new"})
        self.assertEqual((self.home / ".env").stat().st_mode & 0o777, 0o600)

    def test_sealed_files_return_private(self):
        self.bundle(sealed={".env": b64("K=v\n"), "mcp-tokens/x.json": b64("{}")})
        self.assertEqual((self.home / ".env").read_text(), "K=v\n")
        self.assertEqual((self.home / "mcp-tokens/x.json").stat().st_mode & 0o777, 0o600)

    def test_session_token_is_private(self):
        token = "a" * 43
        self.bundle(session_token=token)
        path = self.home / "webapp/session-token"
        self.assertEqual(path.read_text().strip(), token)
        self.assertEqual(path.stat().st_mode & 0o777, 0o600)

    def test_paths_cannot_escape_home(self):
        with self.assertRaises(ValueError):
            self.bundle(sealed={"../outside": b64("x")})
        with self.assertRaises(ValueError):
            self.bundle(template={"name": "t", "files": [{"path": "/etc/x", "content": b64("x")}]})


if __name__ == "__main__":
    unittest.main()
