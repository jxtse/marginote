"""Installed Hermes launcher + real Marginote server, synthetic sessions, no models."""

import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch
from urllib.request import urlopen

WORKSPACE = Path(__file__).resolve().parents[1]
PLUGIN = WORKSPACE / "plugins/marginote-hermes"
spec = importlib.util.spec_from_file_location("marginote_launcher", PLUGIN / "launcher.py")
launcher = importlib.util.module_from_spec(spec)
spec.loader.exec_module(launcher)


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="marginote-hermes-launcher-")
        self.root = Path(self.temp.name).resolve()
        self.env_patch = patch.dict(os.environ, {"HERMES_HOME": str(self.root), "HERMES_SESSION_ID": "calling-session"})
        self.env_patch.start()
        from hermes_state import SessionDB

        self.db = SessionDB(self.root / "state.db")
        self.db.create_session("calling-session", source="cli", model="inherited-model", cwd=str(self.root),
            model_config={"provider": "custom:fixture", "base_url": "http://127.0.0.1:1/v1", "reasoning_config": {"enabled": True, "effort": "high"}})
        self.db.append_messages_batch("calling-session", [
            {"role": "user", "content": "Keep the full original history."},
            {"role": "assistant", "content": "Previous completed answer", "finish_reason": "stop"},
            {"role": "user", "content": "Open report.md for review in this turn."}])
        (self.root / "report.md").write_text("# Review artifact\n")
        self.parser = argparse.ArgumentParser()
        launcher.setup(self.parser)

    def tearDown(self):
        self.db.close()
        self.env_patch.stop()
        self.temp.cleanup()

    def test_infers_only_the_calling_session_and_current_boundary(self):
        args = self.parser.parse_args([str(self.root / "report.md"), "--no-open"])
        command = launcher.launch_args(args, self.root)
        marker = self.db.get_messages("calling-session")[-1]["id"]
        self.assertEqual(command[command.index("--origin-session") + 1], "calling-session")
        self.assertEqual(command[command.index("--origin-after") + 1], str(marker))
        self.assertNotIn("--open", command)
        with patch.dict(os.environ, {"HERMES_SESSION_ID": ""}):
            with self.assertRaisesRegex(ValueError, "No current Hermes session"):
                launcher.launch_args(args, self.root)
        args.session = "some-other-session"
        with self.assertRaisesRegex(ValueError, "completed --turn"):
            launcher.launch_args(args, self.root)

    def test_cli_waits_then_automatically_binds_the_actual_session(self):
        shutil.copytree(PLUGIN, self.root / "plugins/marginote-hermes", ignore=shutil.ignore_patterns("__pycache__"))
        (self.root / "config.yaml").write_text(json.dumps({"model": {"default": "different-profile-default"},
            "plugins": {"enabled": ["marginote-hermes"]}}))
        env = {"PATH": os.environ["PATH"], "HOME": str(self.root), "HERMES_HOME": str(self.root),
               "HERMES_SESSION_ID": "calling-session", "LANG": "en_US.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
        configured = subprocess.run(["hermes", "marginote", "--setup", str(WORKSPACE / "packages/cli/bin/marginote.js")],
            cwd=self.root, env=env, capture_output=True, text=True, timeout=30)
        self.assertEqual(configured.returncode, 0, configured.stderr)
        logfile = self.root / "launcher.log"
        with logfile.open("w") as log:
            process = subprocess.Popen(["hermes", "marginote", "report.md", "--no-open"], cwd=self.root,
                env=env, stdout=log, stderr=subprocess.STDOUT, start_new_session=True)
        try:
            deadline = time.monotonic() + 30
            url = None
            while time.monotonic() < deadline:
                output = logfile.read_text()
                match = re.search(r"local\s+(http://127\.0\.0\.1:\d+)", output)
                if match:
                    url = match[1]
                    break
                if process.poll() is not None:
                    self.fail(output)
                time.sleep(0.05)
            self.assertIsNotNone(url, logfile.read_text())

            def status():
                with urlopen(url + "/api/agent/conversation?doc=report.md", timeout=5) as response:
                    return json.load(response)

            self.assertEqual(status()["state"], "connecting")
            self.assertIsNone(status()["sessionId"])
            self.db.create_session("unrelated", source="cli", model="other")
            self.db.append_messages_batch("unrelated", [{"role": "assistant", "content": "Other delivery", "finish_reason": "stop"}])
            self.assertEqual(status()["state"], "connecting")
            self.db.append_messages_batch("calling-session", [{"role": "assistant", "content": "Here is your review link.", "finish_reason": "stop"}])
            before = self.db.get_messages("calling-session")
            source = self.db.get_session("calling-session")
            deadline = time.monotonic() + 20
            while time.monotonic() < deadline:
                result = status()
                if result["state"] == "idle":
                    break
                self.assertNotEqual(result["state"], "error", result)
                time.sleep(0.05)
            self.assertEqual(result["state"], "idle", result)
            self.assertEqual(result["origin"], {"provider": "hermes", "sessionId": "calling-session", "turnId": str(before[-1]["id"])})
            self.assertEqual(result["snapshot"]["model"], "inherited-model")
            self.assertEqual(result["snapshot"]["reasoningEffort"], "high")
            self.assertEqual(result["snapshot"]["activeMessages"], 4)
            self.assertNotEqual(result["sessionId"], "calling-session")
            self.assertEqual(self.db.get_messages("calling-session"), before)
            self.assertEqual(self.db.get_session("calling-session"), source)
            self.assertEqual([r["content"] for r in self.db.get_messages(result["sessionId"])], [r["content"] for r in before])
            print("PASS: short CLI inferred the calling session, waited for its delivery, auto-connected the exact model/history, and left the parent unchanged.")
        finally:
            process.terminate()
            try:
                process.wait(timeout=20)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
                self.fail("The isolated launcher did not shut down cleanly")


if __name__ == "__main__":
    unittest.main(verbosity=2)
