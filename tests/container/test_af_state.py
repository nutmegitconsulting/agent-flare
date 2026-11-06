"""Run with the image's Python: see tests/container/run.sh."""
import base64
import json
import shutil
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


class Hydrated(Base):
    def setUp(self):
        super().setUp()
        (self.home / "config.yaml").write_text("a: 1\n")


class EmptyHome(Base):
    def test_a_home_that_is_gone_or_empty_is_never_snapshotted(self):
        for home in (self.home / "gone", self.home):
            with self.assertRaises(RuntimeError):
                af_state.stage(home, Path(self.tmp.name) / "stage")

    def test_an_empty_backup_fails_verification(self):
        restored = Path(self.tmp.name) / "restored"
        restored.mkdir()
        (restored / af_state.MANIFEST).write_text(json.dumps({"files": 0, "bytes": 0, "databases": []}))
        result = af_state.verify(restored)
        self.assertFalse(result["ok"])
        self.assertIn("config.yaml missing", result["problems"])


class Stage(Hydrated):
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


class UserDataStays(Hydrated):
    def test_names_like_logs_or_cache_are_excluded_only_where_hermes_puts_them(self):
        keep = ["skills/x/cache/data.json", "skills/x/logs/notes.md", "memories/tmp/plan.md",
                "workspace/app/uv.lock", "workspace/app/venv/keep.txt", "workspace/app/sandboxes/a.txt"]
        for rel in keep:
            path = self.home / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("x")
        (self.home / "logs").mkdir()
        (self.home / "logs/gateway.log").write_text("x")
        af_state.stage(self.home, self.stage)
        names = {str(p.relative_to(self.stage)) for p in self.stage.rglob("*") if p.is_file()}
        self.assertEqual(names, {*keep, "config.yaml", af_state.MANIFEST})

    def test_a_broken_project_database_does_not_block_snapshots_or_restores(self):
        (self.home / "workspace").mkdir()
        (self.home / "workspace/trunc.sqlite").write_bytes(b"SQLite format 3\x00" + b"\x01" * 50)
        sqlite3.connect(self.home / "state.db").executescript("CREATE TABLE t (n); INSERT INTO t VALUES (1);")
        manifest = af_state.stage(self.home, self.stage)
        self.assertEqual(manifest["databases"], ["state.db"])
        self.assertTrue((self.stage / "workspace/trunc.sqlite").exists())
        self.assertTrue(af_state.verify(self.stage)["ok"])

    def test_a_corrupt_state_database_refuses_the_snapshot(self):
        (self.home / "state.db").write_bytes(b"SQLite format 3\x00" + b"\x01" * 5000)
        with self.assertRaises(RuntimeError):
            af_state.stage(self.home, self.stage)


class Verify(Hydrated):
    def test_no_manifest_is_untrusted(self):
        self.assertFalse(af_state.verify(self.home)["ok"])

    def test_a_snapshot_of_a_restored_home_verifies(self):
        (self.home / "a.md").write_text("hello")
        for _ in range(3):
            af_state.stage(self.home, self.stage)
            self.assertTrue(af_state.verify(self.stage)["ok"])
            shutil.rmtree(self.home)
            shutil.copytree(self.stage, self.home)

    def test_missing_or_truncated_files_are_untrusted(self):
        sqlite3.connect(self.home / "state.db").executescript("CREATE TABLE t (n); INSERT INTO t VALUES (1);")
        (self.home / "a.md").write_text("hello")
        (self.home / "b.md").write_text("hello")
        af_state.stage(self.home, self.stage)
        self.assertTrue(af_state.verify(self.stage)["ok"])
        (self.stage / "a.md").write_text("he")
        self.assertFalse(af_state.verify(self.stage)["ok"])
        (self.stage / "a.md").write_text("hello")
        (self.stage / "b.md").unlink()
        self.assertFalse(af_state.verify(self.stage)["ok"])

    def test_an_emptied_database_is_untrusted(self):
        sqlite3.connect(self.home / "state.db").executescript("CREATE TABLE t (n); INSERT INTO t VALUES (1);")
        manifest = af_state.stage(self.home, self.stage)
        (self.stage / "state.db").write_bytes(b"")
        self.assertFalse(af_state.verify(self.stage)["ok"], manifest)

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
        sealed = af_state.seal_read(self.home)["files"]
        self.assertEqual(set(sealed), {".env", "mcp-tokens/x.json"})
        self.assertEqual(base64.b64decode(sealed[".env"]), b"K=v\n")

    def test_every_hermes_store_is_sealed_and_kept_out_of_the_stage(self):
        stores = [".anthropic_oauth.json", "google_token.json", "slack_tokens.json", ".op.env",
                  "auth/google_oauth.json", "google_chat_user_tokens/a.json", "auth.json.bak", ".env.bak",
                  "browser-profiles/a/Cookies", "vault/vault.key", "home/.ssh/id_ed25519", "pairing/x.json",
                  "whatsapp/session/creds.json", "profiles/work/.env", "profiles/work/auth.json"]
        for rel in stores:
            path = self.home / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("TOKEN-VALUE")
        (self.home / "config.yaml").write_text("a: 1\n")
        af_state.stage(self.home, self.stage)
        staged = [p for p in self.stage.rglob("*") if p.is_file() and b"TOKEN-VALUE" in p.read_bytes()]
        self.assertEqual(staged, [])
        self.assertEqual(set(af_state.seal_read(self.home)["files"]), set(stores))

    def test_oversized_stores_drop_the_largest_and_say_so(self):
        (self.home / ".env").write_text("K=v\n")
        (self.home / "browser-profiles/a").mkdir(parents=True)
        (self.home / "browser-profiles/a/Cache").write_bytes(b"x" * (af_state.MAX_SEALED_BYTES + 1))
        result = af_state.seal_read(self.home)
        self.assertEqual(set(result["files"]), {".env"})
        self.assertEqual(result["dropped"], ["browser-profiles/a/Cache"])


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

    def test_a_template_assigned_later_still_fills_in(self):
        self.bundle(config_defaults={})
        (self.home / "config.yaml").write_text("model: mine\n")
        report = self.bundle(template={"name": "new", "files": [{"path": "SOUL.md", "content": b64("t")}]},
                             config_defaults={"model": "tmpl", "other": 1})
        self.assertEqual(report["template_files"], 1)
        self.assertEqual(self.config()["model"], "mine")
        self.assertEqual(self.config()["other"], 1)

    def test_a_managed_env_value_leaves_when_the_template_drops_it(self):
        self.bundle(env={"SHARED_TOKEN": "t", "KEEP": "k"})
        (self.home / ".env").write_text((self.home / ".env").read_text() + "MINE=m\n")
        self.bundle(env={"KEEP": "k"})
        lines = dict(l.split("=", 1) for l in (self.home / ".env").read_text().splitlines())
        self.assertEqual(lines, {"KEEP": "k", "MINE": "m"})

    def test_a_broken_config_is_set_aside_not_fatal(self):
        (self.home / "config.yaml").write_text("a: [unclosed\n  b: :\n")
        report = self.bundle(config_managed={"webapp": {"port": 9120}})
        self.assertTrue(report["config_recovered"])
        self.assertEqual(self.config()["webapp"]["port"], 9120)
        self.assertEqual(len(list(self.home.glob("config.yaml.corrupt.*"))), 1)

    def test_managed_keys_win_every_boot_and_keep_user_keys_and_comments(self):
        (self.home / "config.yaml").write_text("# my note\nmodel: mine\nwebapp:\n  port: 1\n  extra: keep\n")
        self.bundle(config_managed={"webapp": {"port": 9120, "enabled": True}})
        text = (self.home / "config.yaml").read_text()
        self.assertIn("# my note", text)
        config = self.config()
        self.assertEqual(config["model"], "mine")
        self.assertEqual(dict(config["webapp"]), {"port": 9120, "extra": "keep", "enabled": True})

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

    GW = {"provider": "gw", "model": "m1", "key_env": "GW_KEY"}
    BYO = {"provider": "byo", "model": "m2", "key_env": "BYO_KEY"}

    def test_first_launch_selects_the_first_provider_with_a_credential(self):
        report = self.bundle(env={"GW_KEY": "t"}, provider_candidates=[self.GW, self.BYO])
        self.assertEqual(dict(self.config()["model"]), {"default": "m1", "provider": "gw"})
        self.assertEqual(report["inference"], {"selected": "gw", "missing": ["BYO_KEY"]})

    def test_a_missing_secret_falls_through_to_the_next_provider(self):
        report = self.bundle(env_defaults={"BYO_KEY": "mine"}, provider_candidates=[self.GW, self.BYO])
        self.assertEqual(dict(self.config()["model"]), {"default": "m2", "provider": "byo"})
        self.assertEqual(report["inference"], {"selected": "byo", "missing": ["GW_KEY"]})

    def test_no_credential_selects_nothing_and_says_so_by_name_only(self):
        report = self.bundle(provider_candidates=[self.GW])
        self.assertNotIn("model", self.config())
        self.assertEqual(report["inference"], {"selected": None, "missing": ["GW_KEY"]})

    def test_a_secret_added_later_selects_on_the_next_boot(self):
        self.bundle(provider_candidates=[self.GW])
        report = self.bundle(env={"GW_KEY": "t"}, provider_candidates=[self.GW])
        self.assertEqual(self.config()["model"]["provider"], "gw")
        self.assertEqual(report["inference"]["selected"], "gw")

    def test_a_user_key_in_env_counts(self):
        (self.home / ".env").write_text("BYO_KEY=mine\n")
        self.bundle(provider_candidates=[self.BYO])
        self.assertEqual(self.config()["model"]["provider"], "byo")

    def test_an_empty_value_is_not_a_credential(self):
        (self.home / ".env").write_text("GW_KEY=\n")
        self.bundle(provider_candidates=[self.GW])
        self.assertNotIn("model", self.config())

    def test_a_users_own_choice_is_never_replaced(self):
        self.bundle(env={"GW_KEY": "t"}, provider_candidates=[self.GW])
        (self.home / "config.yaml").write_text("model:\n  default: theirs\n  provider: other\n")
        report = self.bundle(env={"GW_KEY": "t"}, provider_candidates=[self.GW])
        self.assertEqual(dict(self.config()["model"]), {"default": "theirs", "provider": "other"})
        self.assertEqual(report["inference"]["selected"], "other")
        self.bundle(provider_candidates=[self.GW])
        self.assertEqual(self.config()["model"]["provider"], "other")

    def test_a_selection_whose_secret_is_withdrawn_moves_on(self):
        self.bundle(env={"GW_KEY": "t", "BYO_KEY": "b"}, provider_candidates=[self.GW, self.BYO])
        self.assertEqual(self.config()["model"]["provider"], "gw")
        self.bundle(env={"BYO_KEY": "b"}, provider_candidates=[self.GW, self.BYO])
        self.assertEqual(self.config()["model"]["provider"], "byo")
        self.bundle(provider_candidates=[self.GW, self.BYO])
        self.assertNotIn("model", self.config())

    def test_a_role_change_moves_our_default_but_not_a_users_pick(self):
        self.bundle(env={"GW_KEY": "t"}, provider_candidates=[self.GW])
        moved = {**self.GW, "model": "m3"}
        self.bundle(env={"GW_KEY": "t"}, provider_candidates=[moved])
        self.assertEqual(self.config()["model"]["default"], "m3")
        config = (self.home / "config.yaml").read_text().replace("default: m3", "default: picked")
        (self.home / "config.yaml").write_text(config)
        self.bundle(env={"GW_KEY": "t"}, provider_candidates=[self.GW])
        self.assertEqual(self.config()["model"]["default"], "picked")

    def test_the_status_chip_is_installed_and_a_failure_is_harmless(self):
        source = Path(self.tmp.name) / "plugin.js"
        source.write_text("v2")
        target = self.home / "desktop-plugins/agent-flare/plugin.js"
        original = af_state.DESKTOP_PLUGIN
        try:
            af_state.DESKTOP_PLUGIN = source
            self.assertTrue(self.bundle()["desktop_plugin"])
            self.assertEqual(target.read_text(), "v2")
            af_state.DESKTOP_PLUGIN = Path(self.tmp.name) / "missing.js"
            self.assertFalse(self.bundle()["desktop_plugin"])
        finally:
            af_state.DESKTOP_PLUGIN = original

    def test_a_ui_default_fills_an_empty_store_and_never_replaces_a_choice(self):
        store = self.home / "ui-preferences.json"
        mode = "hermes-desktop-mode-v1"
        self.assertEqual(self.bundle(ui_defaults={mode: "dark"})["ui_defaults"], [mode])
        first = json.loads(store.read_text())
        self.assertEqual((first["version"], first["values"][mode]), (1, "dark"))
        self.assertTrue(first["generation"])
        store.write_text(json.dumps({"version": 1, "generation": "g", "revision": 7, "values": {mode: "light", "k": "v"}}))
        self.assertEqual(self.bundle(ui_defaults={mode: "dark"})["ui_defaults"], [])
        self.assertEqual(json.loads(store.read_text())["values"][mode], "light")
        store.write_text(json.dumps({"version": 1, "generation": "g", "revision": 7, "values": {"k": "v"}}))
        self.bundle(ui_defaults={mode: "dark"})
        kept = json.loads(store.read_text())
        self.assertEqual((kept["generation"], kept["revision"], kept["values"]), ("g", 8, {"k": "v", mode: "dark"}))
        store.write_text("not json")
        self.assertEqual(self.bundle(ui_defaults={mode: "dark"})["ui_defaults"], [])
        self.assertEqual(store.read_text(), "not json")

    def test_a_provider_the_template_dropped_leaves_and_a_users_own_stays(self):
        (self.home / "config.yaml").write_text("custom_providers:\n- name: mine\n  base_url: u\n")
        self.bundle(config_managed={"custom_providers": [{"name": "gw", "base_url": "b"}]})
        self.bundle(config_managed={})
        self.assertEqual([p["name"] for p in self.config()["custom_providers"]], ["mine"])

    def test_provider_credentials_stay_out_of_config_and_the_stage(self):
        self.bundle(env={"GW_KEY": "s3cret-value"}, provider_candidates=[self.GW],
                    config_managed={"custom_providers": [{"name": "gw", "base_url": "b", "key_env": "GW_KEY"}]})
        self.assertNotIn("s3cret-value", (self.home / "config.yaml").read_text())

    def test_paths_cannot_escape_home(self):
        with self.assertRaises(ValueError):
            self.bundle(sealed={"../outside": b64("x")})
        with self.assertRaises(ValueError):
            self.bundle(template={"name": "t", "files": [{"path": "/etc/x", "content": b64("x")}]})


if __name__ == "__main__":
    unittest.main()
