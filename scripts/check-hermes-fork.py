"""Run with the installed Hermes Python runtime. Synthetic sessions, no models."""

import copy
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

WORKSPACE = Path(__file__).resolve().parents[1]
PLUGIN = WORKSPACE / "plugins" / "marginote-hermes"
spec = importlib.util.spec_from_file_location("marginote_hermes_bridge", PLUGIN / "bridge.py")
bridge = importlib.util.module_from_spec(spec)
spec.loader.exec_module(bridge)


class NativeForkTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="marginote-hermes-")
        self.root = Path(self.temp.name).resolve()
        self.previous_home = os.environ.get("HERMES_HOME")
        os.environ["HERMES_HOME"] = str(self.root)
        from hermes_state import SessionDB

        self.db = SessionDB(self.root / "state.db")
        self.config = {"provider": "synthetic-provider", "base_url": "http://127.0.0.1:1", "reasoning_config": {"enabled": True}}
        self.db.create_session("original", source="cli", model="synthetic-model", model_config=self.config,
                               system_prompt="Keep the original instructions.", cwd=str(self.root))
        self.messages = [
            {"role": "user", "content": "Remember CODE-123", "api_content": "Remember CODE-123\nNative context", "timestamp": 1},
            {"role": "assistant", "content": None, "tool_calls": [{"id": "call-1", "type": "function", "function": {"name": "read_file", "arguments": '{"path":"report.md"}'}}], "finish_reason": "tool_calls", "reasoning": "Inspect the report", "timestamp": 2},
            {"role": "tool", "content": "Native tool result", "tool_call_id": "call-1", "tool_name": "read_file", "timestamp": 3},
            {"role": "assistant", "content": "Delivered report", "finish_reason": "stop", "reasoning_details": [{"type": "reasoning.text", "text": "Native sidecar"}], "timestamp": 4},
        ]
        self.db.append_messages_batch("original", copy.deepcopy(self.messages))
        self.delivery = self.db.get_messages("original")[-1]["id"]

    def tearDown(self):
        self.db.close()
        if self.previous_home is None:
            os.environ.pop("HERMES_HOME", None)
        else:
            os.environ["HERMES_HOME"] = self.previous_home
        self.temp.cleanup()

    def test_exact_prefix_native_sidecars_and_independent_parent(self):
        self.db.append_messages_batch("original", [{"role": "user", "content": "Later discussion"}, {"role": "assistant", "content": "Later answer", "finish_reason": "stop"}])
        before_rows = self.db.get_messages("original")
        before_session = self.db.get_session("original")
        result = bridge.fork_delivery(self.db, "original", self.delivery)
        child = result["sessionId"]
        rows = self.db.get_messages(child)
        self.assertEqual(len(rows), 4)
        self.assertEqual(bridge.payloads(rows), bridge.payloads(before_rows[:4]))
        self.assertFalse({row["id"] for row in rows} & {row["id"] for row in before_rows})
        self.assertEqual(self.db.get_messages("original"), before_rows)
        self.assertEqual(self.db.get_session("original"), before_session)
        self.db.append_messages_batch("original", [{"role": "user", "content": "Even later parent message"}])
        model, display = self.db.get_resume_conversations(child)
        self.assertNotIn("Later discussion", json.dumps([model, display]))
        self.assertIn("Native tool result", json.dumps(model))
        self.assertIn("Native context", json.dumps(model))
        self.assertEqual(self.db.get_session(child)["model"], "synthetic-model")

    def test_compacted_history_is_preserved_without_reactivating_it(self):
        archived = self.db.get_messages("original")
        self.db.archive_and_compact("original", [
            {"role": "user", "content": "Native compacted context", "_compressed_summary": True},
            {"role": "assistant", "content": "New completed delivery", "finish_reason": "stop"},
        ])
        active = self.db.get_messages("original")
        result = bridge.fork_delivery(self.db, "original", active[-1]["id"])
        self.assertEqual(bridge.payloads(self.db.get_messages(result["sessionId"])), bridge.payloads(active))
        inherited = self.db.get_messages(result["sessionId"], include_inactive=True)
        self.assertEqual(bridge.payloads([row for row in inherited if row["compacted"]]), bridge.payloads(archived))
        with self.assertRaisesRegex(ValueError, "compacted/rewound"):
            bridge.fork_delivery(self.db, "original", self.delivery)

    def test_old_compression_ancestors_become_independent_archives(self):
        original = self.db.get_messages("original")
        self.db.end_session("original", "compression")
        self.db.create_session("tip", source="cli", model="synthetic-model", model_config=self.config,
                               system_prompt="Keep the original instructions.", cwd=str(self.root), parent_session_id="original")
        self.db.append_messages_batch("tip", [{"role": "user", "content": "Summary"}, {"role": "assistant", "content": "Tip delivery", "finish_reason": "stop"}])
        result = bridge.fork_delivery(self.db, "tip", self.db.get_messages("tip")[-1]["id"])
        inherited = self.db.get_messages(result["sessionId"], include_inactive=True)
        self.assertEqual(bridge.payloads([row for row in inherited if row["compacted"]]), bridge.payloads(original))
        self.assertEqual(result["activeMessages"], 2)
        self.assertEqual(result["archivedMessages"], 4)

    def test_invalid_boundaries_never_create_a_child(self):
        before = self.db.list_sessions_rich(limit=100)
        for target in [True, "1", -1, self.delivery + 100, self.delivery - 1, self.delivery - 2]:
            with self.assertRaises(ValueError):
                bridge.fork_delivery(self.db, "original", target)
        self.assertEqual(self.db.list_sessions_rich(limit=100), before)

    def test_native_serializer_loss_rolls_back_only_the_new_child(self):
        original = self.db.get_messages("original")
        real_append = self.db.append_messages_batch

        def lossy_append(session, rows, **kwargs):
            for row in rows:
                row["api_content"] = None
            return real_append(session, rows, **kwargs)

        self.db.append_messages_batch = lossy_append
        with self.assertRaisesRegex(ValueError, "every native message payload"):
            bridge.fork_delivery(self.db, "original", self.delivery)
        self.assertEqual(self.db.get_messages("original"), original)
        self.assertEqual(len(self.db.list_sessions_rich(limit=100)), 1)

    def test_concurrent_parent_change_discards_only_the_snapshot(self):
        real_create = self.db.create_session

        def concurrent_create(*args, **kwargs):
            result = real_create(*args, **kwargs)
            self.db.append_messages_batch("original", [{"role": "user", "content": "Concurrent parent work"}])
            return result

        self.db.create_session = concurrent_create
        with self.assertRaisesRegex(ValueError, "history changed"):
            bridge.fork_delivery(self.db, "original", self.delivery)
        self.assertEqual(self.db.get_messages("original")[-1]["content"], "Concurrent parent work")
        self.assertEqual(len(self.db.list_sessions_rich(limit=100)), 1)

    def test_missing_provider_identity_is_not_replaced_with_a_default(self):
        self.db.create_session("unknown-provider", source="cli", model="synthetic-model", cwd=str(self.root))
        self.db.append_messages_batch("unknown-provider", copy.deepcopy(self.messages))
        row = self.db.get_messages("unknown-provider")[-1]
        with self.assertRaisesRegex(ValueError, "routable provider identity"):
            bridge.fork_delivery(self.db, "unknown-provider", row["id"])
        self.assertEqual(len(self.db.list_sessions_rich(limit=100)), 2)

    def test_installed_hermes_discovers_plugin_and_serves_stdio(self):
        shutil.copytree(PLUGIN, self.root / "plugins" / "marginote-hermes", ignore=shutil.ignore_patterns("__pycache__"))
        (self.root / "config.yaml").write_text("plugins:\n  enabled: [marginote-hermes]\n")
        requests = [
            {"id": 1, "method": "initialize"},
            {"id": 2, "method": "fork_delivery", "params": {"sessionId": "original", "messageId": self.delivery}},
        ]
        response = subprocess.run(["hermes", "marginote-bridge"], input="".join(json.dumps(request) + "\n" for request in requests), text=True,
                                  capture_output=True, env=dict(os.environ), cwd=self.root, timeout=40)
        self.assertEqual(response.returncode, 0, response.stderr[-2000:])
        replies = [json.loads(line) for line in response.stdout.splitlines() if line.strip()]
        self.assertEqual(replies[0]["result"]["capabilities"], ["fork_delivery", "wait_delivery", "prompt"])
        result = replies[1].get("result")
        self.assertIsNotNone(result, replies[1])
        self.assertEqual(len(self.db.get_messages(result["sessionId"])), 4)

    def test_delivery_wait_does_not_choose_an_old_or_unrelated_answer(self):
        cancelled = threading.Event()
        self.db.create_session("unrelated", source="cli", model="other")
        self.db.append_messages_batch("unrelated", [{"role": "assistant", "content": "Not this session", "finish_reason": "stop"}])
        with self.assertRaises(TimeoutError):
            bridge.wait_delivery(self.db, "original", self.delivery, cancelled, timeout=0)
        self.db.append_messages_batch("original", [{"role": "user", "content": "Launch review"},
            {"role": "assistant", "content": "Tool preamble", "finish_reason": "tool_calls", "tool_calls": [{"id": "pending"}]}])
        with self.assertRaises(TimeoutError):
            bridge.wait_delivery(self.db, "original", self.delivery, cancelled, timeout=0)
        self.db.append_messages_batch("original", [{"role": "assistant", "content": "Review ready", "finish_reason": "stop"}])
        result = bridge.wait_delivery(self.db, "original", self.delivery, cancelled, timeout=0)
        self.assertEqual(result, {"sessionId": "original", "messageId": self.db.get_messages("original")[-1]["id"]})
        cancelled.set()
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            bridge.wait_delivery(self.db, "original", self.delivery, cancelled)

    def test_native_tui_lazily_resumes_only_the_child_without_a_model(self):
        result = bridge.fork_delivery(self.db, "original", self.delivery)
        code = '''
import json, queue, sys
output = sys.stdout
from tui_gateway import server
class Capture:
    def __init__(self): self.frames = queue.Queue()
    def write(self, frame): self.frames.put(frame); return True
transport = Capture()
def request(id, method, params):
    result = server.dispatch({"jsonrpc": "2.0", "id": id, "method": method, "params": params}, transport=transport)
    if result is not None: return result
    while True:
        frame = transport.frames.get(timeout=15)
        if frame.get("id") == id: return frame
reply = request(1, "session.resume", {"session_id": sys.argv[1], "lazy": True})
assert "error" not in reply, reply
live = reply["result"]["session_id"]
record = server._sessions[live]
assert record["session_key"] == sys.argv[1]
assert record["agent"] is None
history = json.dumps(record["history"])
assert "Native tool result" in history
assert "Native context" in history
assert "CODE-123" in history
request(2, "session.close", {"session_id": live})
print("PASS: native TUI resumed the child history without building an agent", file=output, flush=True)
'''
        response = subprocess.run([sys.executable, "-c", code, result["sessionId"]], text=True, capture_output=True,
                                  env=dict(os.environ), cwd=self.root, timeout=30)
        self.assertEqual(response.returncode, 0, response.stderr[-2500:])
        self.assertIn("PASS: native TUI", response.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
