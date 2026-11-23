"""Hermes' file routes and its git read the dev sandbox. Run with the image's Python: see tests/container/run.sh.

The Worker here is a stand-in that runs each command in a local bash and cuts output at 1 MiB, as the
real one does. Its "sandbox" is a temp folder, so every path in these tests is under it.
"""
import asyncio
import importlib.util
import json
import os
import shutil
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
HOST_WORKSPACE = "/home/hermes/.hermes/workspace"  # what agent-flare sets as terminal.cwd


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

        cls.work = cls.home / "workspace"
        cls.plugin._WORKSPACE = str(cls.work)  # /workspace in a real sandbox
        cls.plugin.register(Ctx())
        cls.plugin.register(Ctx())  # a second load must not wrap the wrapper

        from hermes_cli import ssh_workspace_fs
        cls.module = ssh_workspace_fs
        cls.fs = ssh_workspace_fs.get_ssh_workspace_fs("current", {"backend": "cloudflare_sandbox", "cwd": HOST_WORKSPACE})

        (cls.work / "made-by-agent.txt").write_text("in the sandbox\n")
        (cls.work / "sub").mkdir()
        (cls.work / "sub" / "deep.txt").write_text("deep\n")
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

    def test_opens_in_the_sandbox_workspace_and_the_terminal_starts_there(self):
        self.assertEqual(self.fs.cwd, str(self.work))  # made on first use: the folder did not exist
        self.assertEqual(self.provider.default_cwd, str(self.work))

    def test_hermes_own_workspace_folder_shows_the_sandbox_workspace(self):
        listing = self.fs.list_dir(HOST_WORKSPACE, frozenset())
        self.assertEqual([(e["name"], e["path"]) for e in listing["entries"]],
                         [("sub", HOST_WORKSPACE + "/sub"), ("made-by-agent.txt", HOST_WORKSPACE + "/made-by-agent.txt")])
        self.assertEqual(self.fs.list_dir(HOST_WORKSPACE + "/sub", frozenset())["entries"][0]["path"], HOST_WORKSPACE + "/sub/deep.txt")
        self.assertEqual(self.fs.read_bytes(HOST_WORKSPACE + "/sub/deep.txt", max_bytes=100)[0], b"deep\n")
        self.assertEqual(self.fs.read_bytes(str(self.work / "made-by-agent.txt"), max_bytes=100)[0], b"in the sandbox\n")
        self.assertEqual(self.fs.normalize(HOST_WORKSPACE + "-other/x"), HOST_WORKSPACE + "-other/x")

    def test_home_paths(self):
        self.assertEqual(self.fs.normalize("~/project"), str(self.home / "project"))

    def test_one_reader_per_profile(self):
        again = self.module.get_ssh_workspace_fs("current", {"backend": "cloudflare_sandbox", "cwd": HOST_WORKSPACE})
        self.assertIs(again, self.fs)

    def test_lists_a_folder(self):
        listing = self.fs.list_dir("~", frozenset({"empty", "workspace"}))
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
        self.assertEqual(asyncio.run(files.fs_default_cwd())["cwd"], str(self.work))
        shown = asyncio.run(files.fs_list(HOST_WORKSPACE, None))
        self.assertEqual([e["name"] for e in shown["entries"]], ["sub", "made-by-agent.txt"])
        self.assertEqual(asyncio.run(files.fs_read_text(HOST_WORKSPACE + "/made-by-agent.txt"))["text"], "in the sandbox\n")
        listing = asyncio.run(files.fs_list(str(self.home / "project"), None))
        self.assertEqual([e["name"] for e in listing["entries"]], ["new.md", "notes.txt"] if (self.home / "project" / "new.md").exists() else ["notes.txt"])
        text = asyncio.run(files.fs_read_text(str(self.home / "project" / "notes.txt")))
        self.assertEqual((text["text"], text["binary"]), ("hello\n", False))
        image = asyncio.run(files.fs_read_data_url(str(self.home / "shot.png"), None))
        self.assertTrue(image["dataUrl"].startswith("data:image/png;base64,"))

    # --- git, and a session's folder ---------------------------------------------------------------
    def _repo(self, name):
        """A folder of the workspace, in the sandbox only, gone again after the test."""
        (self.work / name).mkdir()
        self.addCleanup(shutil.rmtree, self.work / name, True)
        self.addCleanup(shutil.rmtree, HOST_WORKSPACE + "/" + name, True)
        return HOST_WORKSPACE + "/" + name

    def test_the_git_functions_the_plugin_wraps_are_still_there(self):
        # A Hermes that renamed one of these leaves git in the UI acting on the wrong disk, and says so
        # only in a log line.
        from hermes_cli import web_git
        from tui_gateway import git_probe
        self.assertTrue(getattr(web_git._run, "_cloudflare_sandbox", False))
        for name in self.plugin._WEB_GIT_NAMES:
            self.assertEqual(getattr(web_git, name).__module__, self.plugin.__name__, name)
        self.assertEqual(git_probe.run_git.__module__, self.plugin.__name__)

    def test_a_worktree_is_made_in_the_sandbox(self):
        from hermes_cli import web_git
        repo = self._repo("app")
        made = web_git.worktree_add(repo, {"name": "feat", "branch": "feat"})
        self.assertEqual(made, {"path": repo + "/.worktrees/feat", "branch": "feat", "repoRoot": repo})
        self.assertTrue((self.work / "app" / ".worktrees" / "feat" / ".git").exists())
        self.assertFalse(os.path.exists(repo + "/.git"))  # nothing of the repository beside Hermes
        self.assertEqual(os.listdir(made["path"]), [])  # only the empty folder a session's check needs
        self.assertEqual([tree["path"] for tree in web_git.worktree_list(repo)], [repo, made["path"]])
        self.assertEqual(web_git.repo_status(made["path"])["branch"], "feat")
        again = web_git.worktree_add(repo, {"name": "feat", "branch": "feat-2"})
        self.assertEqual(again["path"], repo + "/.worktrees/feat-2")
        web_git.worktree_remove(repo, again["path"], False)
        self.assertFalse((self.work / "app" / ".worktrees" / "feat-2").exists())

    def test_git_answers_in_the_name_it_was_asked_in(self):
        from hermes_cli import web_git
        repo = self._repo("named")
        web_git.worktree_add(repo, {"name": "one"})
        inside = str(self.work / "named")
        self.assertEqual([tree["path"] for tree in web_git.worktree_list(inside)], [inside, inside + "/.worktrees/one"])
        self.assertIsNone(web_git.repo_status(HOST_WORKSPACE + "/no-such-folder"))

    def test_the_review_pane_reads_the_sandbox(self):
        from hermes_cli import web_git
        repo = self._repo("review")
        web_git._ensure_repo(repo)
        (self.work / "review" / "new.txt").write_text("made by the agent\n")
        status = web_git.repo_status(repo)
        self.assertEqual([entry["path"] for entry in status["files"]], ["new.txt"])
        self.assertIn("+made by the agent", web_git.review_diff(repo, "new.txt", "uncommitted", None, False))

    def test_a_session_shows_its_branch(self):
        from hermes_cli import web_git
        from tui_gateway import git_probe
        repo = self._repo("probe")
        tree = web_git.worktree_add(repo, {"name": "lane", "branch": "lane"})["path"]
        self.assertEqual(git_probe.branch(tree), "lane")
        self.assertEqual(git_probe.resolve(tree), {"repo_root": repo, "worktree_root": tree})
        self.assertIsNone(git_probe.resolve(HOST_WORKSPACE + "/sub"))

    def test_only_git_settings_go_to_the_sandbox(self):
        command = self.plugin._git_command(
            ["git", "worktree", "add", HOST_WORKSPACE + "/.worktrees/x"], HOST_WORKSPACE + "/app",
            {"GIT_PAGER": "cat", "GIT_CONFIG_KEY_0": "core.hooksPath", "TEAM_KEY": "secret", "GIT_TOKEN": "secret",
             "CF_DEV_SANDBOX_TOKEN": "secret"}, HOST_WORKSPACE)
        self.assertNotIn("secret", command)
        self.assertIn("GIT_PAGER=cat", command)
        self.assertIn("GIT_CONFIG_KEY_0=core.hooksPath", command)
        self.assertTrue(command.startswith("cd -- %s/app " % self.work))
        self.assertTrue(command.endswith("git worktree add %s/.worktrees/x" % self.work))

    def test_a_session_folder_in_the_workspace_is_that_folder_in_the_sandbox(self):
        self.addCleanup(os.environ.pop, "TERMINAL_CWD", None)
        for asked, starts in ((HOST_WORKSPACE + "/app/.worktrees/feat", str(self.work / "app" / ".worktrees" / "feat")),
                              (HOST_WORKSPACE, str(self.work)), (HOST_WORKSPACE + "-other", str(self.work)),
                              ("/home/hermes/elsewhere", str(self.work)), ("", str(self.work))):
            os.environ["TERMINAL_CWD"] = asked
            self.assertEqual(self.provider.default_cwd, starts, asked)
        # What Hermes' file tools and a moved session read off the environment.
        from tools.terminal_tool_config import translate_mounted_host_path
        env = self.plugin.CloudflareSandboxEnvironment(cwd=str(self.work), timeout=30, sync_files=False)
        self.assertEqual(translate_mounted_host_path(HOST_WORKSPACE + "/app/a.txt", env.host_cwd, env.host_cwd_mount),
                         str(self.work / "app" / "a.txt"))

    def test_a_folder_the_ui_is_shown_can_hold_a_session(self):
        # Hermes checks beside itself that a session's folder exists; the folder is only in the sandbox.
        self.addCleanup(shutil.rmtree, HOST_WORKSPACE, True)
        self.fs.list_dir(HOST_WORKSPACE, frozenset())
        self.assertEqual(os.listdir(HOST_WORKSPACE), ["sub"])
        self.assertEqual(os.listdir(HOST_WORKSPACE + "/sub"), [])
        self.fs.list_dir("~", frozenset())  # outside the workspace: nothing is made beside Hermes
        self.assertFalse(os.path.exists(str(self.home / "project").replace(str(self.work), HOST_WORKSPACE) + "-x"))
        self.assertEqual(os.listdir(HOST_WORKSPACE), ["sub"])

    def test_noted_folders_come_back_after_a_restart(self):
        self.addCleanup(shutil.rmtree, HOST_WORKSPACE, True)
        self.addCleanup(shutil.rmtree, self.work / "kept", True)
        os.makedirs(HOST_WORKSPACE + "/kept/deeper")
        os.makedirs(HOST_WORKSPACE + "/kept/node_modules/pkg")
        self.plugin._restore_noted_folders(HOST_WORKSPACE)
        self.assertTrue((self.work / "kept" / "deeper").is_dir())
        self.assertFalse((self.work / "kept" / "node_modules").exists())


if __name__ == "__main__":
    unittest.main()
