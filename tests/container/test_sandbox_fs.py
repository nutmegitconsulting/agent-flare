"""Hermes' file routes read the dev sandbox. Run with the image's Python: see tests/container/run.sh.

The Worker here is a stand-in that runs each command in a local bash and cuts output at 1 MiB, as the
real one does. Its "sandbox" is a temp folder, so every path in these tests is under it.
"""
import asyncio
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PLUGIN = os.environ.get(
    "AF_SANDBOX_PLUGIN", "/opt/hermes-install/hermes-agent/plugins/cloudflare_sandbox/__init__.py")
MAX_OUTPUT = 1024 * 1024


class Worker(BaseHTTPRequestHandler):
    home = ""

    def log_message(self, *args):
        pass

    def _send(self, body):
        data = json.dumps(body).encode()
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        self._send({"home": self.home})

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers["content-length"])))
        proc = subprocess.run(["bash", "-c", body["command"]], input=(body.get("stdin") or "").encode(),
                              capture_output=True, cwd=self.home, env={**os.environ, "HOME": self.home})
        out = proc.stdout
        text = out.decode(errors="replace") if len(out) <= MAX_OUTPUT else out[:MAX_OUTPUT].decode(errors="replace") + "\n[cut]\n"
        self._send({"stdout": text, "stderr": proc.stderr.decode(errors="replace"), "exit_code": proc.returncode})


class SandboxFs(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.home = Path(cls.tmp.name) / "sandbox-home"
        cls.home.mkdir()
        hermes_home = Path(cls.tmp.name) / "hermes"
        hermes_home.mkdir()
        (hermes_home / "config.yaml").write_text("terminal:\n  backend: cloudflare_sandbox\n  cwd: /home/hermes/.hermes/workspace\n")
        os.environ["HERMES_HOME"] = str(hermes_home)
        os.environ.pop("TERMINAL_ENV", None)

        Worker.home = str(cls.home)
        cls.server = ThreadingHTTPServer(("127.0.0.1", 0), Worker)
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()
        os.environ["CF_DEV_SANDBOX_URL"] = "http://127.0.0.1:%d" % cls.server.server_port
        os.environ["CF_DEV_SANDBOX_TOKEN"] = "test"

        spec = importlib.util.spec_from_file_location("cloudflare_sandbox_plugin", PLUGIN)
        cls.plugin = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.plugin)

        class Ctx:
            def register_terminal_environment_provider(self, provider):
                cls.provider = provider

        cls.plugin.register(Ctx())
        cls.plugin.register(Ctx())  # a second load must not wrap the wrapper

        from hermes_cli import ssh_workspace_fs
        cls.module = ssh_workspace_fs
        cls.fs = ssh_workspace_fs.get_ssh_workspace_fs("current", {"backend": "cloudflare_sandbox", "cwd": "/home/hermes/x"})

        (cls.home / "project").mkdir()
        (cls.home / "project" / "notes.txt").write_text("hello\n")
        (cls.home / "b.txt").write_text("b")
        (cls.home / "A.txt").write_text("a")
        cls.big = os.urandom(3 * 1024 * 1024 + 17)  # three requests and a bit
        (cls.home / "shot.png").write_bytes(cls.big)
        (cls.home / "empty").write_bytes(b"")

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.tmp.cleanup()

    def test_other_backends_are_left_alone(self):
        self.assertIsNone(self.module.get_ssh_workspace_fs("current", {"backend": "local"}))
        self.assertIsNone(self.module.get_ssh_workspace_fs("current", {}))

    def test_opens_in_the_sandbox_home_not_a_folder_beside_hermes(self):
        self.assertEqual(self.fs.cwd, str(self.home))
        self.assertEqual(self.fs.normalize("~/project"), str(self.home / "project"))

    def test_one_reader_per_profile(self):
        again = self.module.get_ssh_workspace_fs("current", {"backend": "cloudflare_sandbox", "cwd": "/home/hermes/x"})
        self.assertIs(again, self.fs)

    def test_lists_a_folder(self):
        listing = self.fs.list_dir("~", frozenset({"empty"}))
        self.assertEqual([e["name"] for e in listing["entries"]], ["project", "A.txt", "b.txt", "shot.png"])
        self.assertTrue(listing["entries"][0]["isDirectory"])
        self.assertEqual(listing["entries"][1]["path"], str(self.home / "A.txt"))
        self.assertEqual(self.fs.list_dir("~/nope", frozenset())["error"], "ENOENT")

    def test_reads_a_file_larger_than_one_command_returns(self):
        data, size, target = self.fs.read_bytes("~/shot.png", max_bytes=16 * 1024 * 1024)
        self.assertEqual((data, size, target), (self.big, len(self.big), str(self.home / "shot.png")))

    def test_preview_reads_only_its_limit(self):
        data, size, _ = self.fs.read_bytes("~/shot.png", max_bytes=64 * 1024 * 1024, read_limit=1000)
        self.assertEqual((data, size), (self.big[:1000], len(self.big)))
        self.assertEqual(self.fs.read_bytes("~/empty", max_bytes=10)[:2], (b"", 0))

    def test_read_errors_use_the_codes_the_routes_map(self):
        for path, limit, code in (("~/nope", 10, "ENOENT"), ("~/project", 10, "ENOTREG"), ("~/shot.png", 10, "EFBIG")):
            with self.assertRaises(self.module.SshWorkspaceFsError) as raised:
                self.fs.read_bytes(path, max_bytes=limit)
            self.assertEqual(raised.exception.code, code)

    def test_streams_whole_and_by_range(self):
        path = str(self.home / "shot.png")
        self.assertEqual(b"".join(self.fs.stream_file(path)), self.big)
        self.assertEqual(b"".join(self.fs.stream_file(path, offset=700_000, length=900_000)), self.big[700_000:1_600_000])
        self.assertEqual(b"".join(self.fs.stream_file(path, offset=len(self.big) - 5)), self.big[-5:])

    def test_download_target(self):
        self.assertEqual(self.fs.inspect_file("~/project/notes.txt"), (str(self.home / "project" / "notes.txt"), 6))

    def test_saves_a_file(self):
        target, size = self.fs.write_text("~/project/new.md", "# héllo\n", max_bytes=1024)
        self.assertEqual(size, 9)
        self.assertEqual(Path(target).read_text(encoding="utf-8"), "# héllo\n")

    def test_environment_still_fetches_a_file_for_delivery(self):
        env = self.plugin.CloudflareSandboxEnvironment(cwd="~", timeout=30, sync_files=False)
        dest = Path(self.tmp.name) / "out.bin"
        env.fetch_file(str(self.home / "shot.png"), dest, max_bytes=50 * 1024 * 1024)
        self.assertEqual(dest.read_bytes(), self.big)

    def test_the_routes_read_the_sandbox(self):
        from hermes_cli.web_routers import files
        self.assertEqual(asyncio.run(files.fs_default_cwd())["cwd"], str(self.home))
        listing = asyncio.run(files.fs_list(str(self.home / "project"), None))
        self.assertEqual([e["name"] for e in listing["entries"]], ["new.md", "notes.txt"] if (self.home / "project" / "new.md").exists() else ["notes.txt"])
        text = asyncio.run(files.fs_read_text(str(self.home / "project" / "notes.txt")))
        self.assertEqual((text["text"], text["binary"]), ("hello\n", False))
        image = asyncio.run(files.fs_read_data_url(str(self.home / "shot.png"), None))
        self.assertTrue(image["dataUrl"].startswith("data:image/png;base64,"))


if __name__ == "__main__":
    unittest.main()
