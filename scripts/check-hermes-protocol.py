"""Regression checks for native renderer requests; standard library only."""

import importlib.util
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location(
    "marginote_protocol_fixture.runtime", Path(__file__).resolve().parents[1] / "plugins/marginote-hermes/runtime.py")
runtime = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runtime)


class NativeRequestTests(unittest.TestCase):
    def setUp(self):
        self.sent = []
        self.callbacks = []
        self.answer = False

        def call(method, params):
            self.callbacks.append((method, params))
            return self.answer

        self.turn = runtime.NativeTurn(None, None, call, threading.Event())
        self.turn.live = "native-child"
        self.turn.server = SimpleNamespace(dispatch=lambda frame, transport: self.sent.append(frame))
        self.frame = {"jsonrpc": "2.0", "id": "srq-wire-id", "method": "approval", "params": {
            "session_id": "native-child", "request_id": "approval-queue-id",
            "command": "rm -rf ./approval-fixture", "choices": ["once", "session", "always", "deny"]}}

    def test_denial_answers_wire_id_and_preserves_review_details(self):
        self.turn._server_request(self.frame)
        self.assertEqual(self.sent, [{"jsonrpc": "2.0", "id": "srq-wire-id",
                                     "result": {"choice": "deny", "all": False}}])
        method, params = self.callbacks[0]
        self.assertEqual(method, "marginote/approve")
        self.assertEqual(params["id"], "approval-queue-id")
        self.assertIn("rm -rf ./approval-fixture", params["detail"])

    def test_consent_is_once_only(self):
        self.answer = True
        self.turn._server_request(self.frame)
        self.assertEqual(self.sent[0]["result"], {"choice": "once", "all": False})

    def test_truthy_values_are_not_consent(self):
        for answer in ["once", "always", 1, {"approved": True}, None]:
            with self.subTest(answer=answer):
                self.answer = answer
                self.turn._server_request(self.frame)
                self.assertEqual(self.sent[-1]["result"]["choice"], "deny")

    def test_unsupported_interaction_errors_instead_of_waiting(self):
        self.frame["method"] = "secret"
        with self.assertRaisesRegex(RuntimeError, "unsupported request secret"):
            self.turn._server_request(self.frame)
        self.assertIn("error", self.sent[0])
        self.assertEqual(self.sent[0]["id"], "srq-wire-id")
        self.assertFalse(self.callbacks)

    def test_foreign_session_never_reaches_human_callback(self):
        self.frame["params"]["session_id"] = "another-child"
        with self.assertRaisesRegex(RuntimeError, "different session"):
            self.turn._server_request(self.frame)
        self.assertFalse(self.callbacks)
        self.assertNotIn("result", self.sent[0])

    def test_missing_approval_identity_is_rejected(self):
        del self.frame["params"]["request_id"]
        with self.assertRaisesRegex(RuntimeError, "exact request"):
            self.turn._server_request(self.frame)
        self.assertFalse(self.callbacks)

    def test_cancellation_during_review_never_grants_consent(self):
        def cancelled_review(*args):
            self.turn.cancelled.set()
            return True
        self.turn.call_client = cancelled_review
        with self.assertRaisesRegex(RuntimeError, "cancelled"):
            self.turn._server_request(self.frame)
        self.assertNotIn("result", self.sent[0])

    def test_transport_retains_peer_requests_and_legacy_events(self):
        legacy = {"method": "event", "params": {"type": "approval.request"}}
        self.turn.write({"method": "event", "params": {"type": "message.delta"}})
        self.turn.write(self.frame)
        self.turn.write(legacy)
        self.assertEqual(self.turn.frames.get_nowait(), self.frame)
        self.assertEqual(self.turn.frames.get_nowait(), legacy)
        self.assertTrue(self.turn.frames.empty())

    def test_turn_loop_routes_both_approval_protocols(self):
        for legacy in [False, True]:
            with self.subTest(legacy=legacy):
                self.setUp()
                config = {"_branched_from": "origin", "_marginote_delivery_row_id": 2}
                self.turn.db = SimpleNamespace(get_session=lambda sid: {"model": "fixture", "model_config": config})
                self.turn.ctx = SimpleNamespace(register_tool=lambda **kwargs: None)
                names = {"marginote_read_document", "marginote_suggest_edit"}
                agent = SimpleNamespace(session_id="child", model="fixture", enabled_toolsets=[],
                                        disabled_toolsets=[], valid_tool_names=names)
                record = {"session_key": "child", "agent": agent, "running": False}

                def dispatch(frame, transport):
                    method = frame.get("method")
                    if method == "session.resume":
                        return {"result": {"session_id": "native-child"}}
                    if method == "prompt.submit":
                        if legacy:
                            transport.write({"method": "event", "params": {"type": "approval.request",
                                "session_id": "native-child", "payload": self.frame["params"]}})
                        else:
                            transport.write(self.frame)
                        transport.write({"method": "event", "params": {"type": "message.complete",
                            "session_id": "native-child", "payload": {"status": "complete", "text": "Declined."}}})
                    if method == "approval.respond":
                        self.sent.append(frame)
                        return {"result": {"resolved": 1}}
                    if not method:
                        self.sent.append(frame)
                    return {"result": {}}

                server = SimpleNamespace(dispatch=dispatch, _sessions={"native-child": record},
                                         _load_enabled_toolsets=lambda source: [])
                modules = {"marginote_protocol_fixture.bridge": SimpleNamespace(_config=lambda source: config),
                           "tui_gateway": SimpleNamespace(server=server),
                           "model_tools": SimpleNamespace(get_tool_definitions=lambda **kwargs:
                               [{"function": {"name": name}} for name in names])}
                with patch.dict(sys.modules, modules):
                    result = self.turn.run({"sessionId": "child", "originSessionId": "origin", "text": "Review",
                        "tools": [{"name": name, "description": "Artifact tool", "inputSchema": {"type": "object"}} for name in names]})
                self.assertEqual(result, {"sessionId": "child", "text": "Declined."})
                self.assertEqual([method for method, _ in self.callbacks], ["marginote/model", "marginote/approve", "marginote/model"])
                self.assertEqual(len(self.sent), 1)
                if legacy:
                    self.assertEqual(self.sent[0]["params"], {"session_id": "native-child",
                        "request_id": "approval-queue-id", "choice": "deny", "all": False})
                else:
                    self.assertEqual(self.sent[0]["id"], "srq-wire-id")
                    self.assertEqual(self.sent[0]["result"], {"choice": "deny", "all": False})


if __name__ == "__main__":
    unittest.main()
