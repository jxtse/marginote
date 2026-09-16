"""Native Hermes + actual Marginote tools against a local fake model, no external AI."""

import copy
import json
import os
from pathlib import Path
import secrets
import shutil
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

WORKSPACE = Path(__file__).resolve().parents[1]


def run():
    requests = []
    failures = []
    nonce = "CODE-" + secrets.token_hex(6).upper()

    class FakeModel(BaseHTTPRequestHandler):
        def log_message(self, *args):
            pass

        def do_GET(self):
            if self.path != "/v1/models":
                self.send_error(404)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.end_headers()
            self.wfile.write(json.dumps({"object": "list", "data": [{"id": "synthetic-model", "object": "model"}]}).encode())

        def do_POST(self):
            if self.path != "/v1/chat/completions":
                self.send_error(404)
                return
            payload = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            messages = payload["messages"]
            last_user = next(message for message in reversed(messages) if message["role"] == "user")
            # Native title generation repeats the opening user message but
            # intentionally omits the chat history. Identify that auxiliary
            # request by its explicit system instruction, not its user text.
            title_request = any(message["role"] == "system" and str(message["content"]).startswith("You name chat sessions.") for message in messages)
            discussion = not title_request and str(last_user["content"]).lstrip().startswith(("Read the artifact,", "Follow-up:", "Approval-check:"))
            if discussion:
                requests.append(payload)
                if payload.get("model") != "synthetic-model" or nonce not in json.dumps(messages):
                    failures.append(f"Native history check: model={payload.get('model')!r}, nonce_present={nonce in json.dumps(messages)}")
                    self.send_error(400, failures[-1])
                    return
            tool_calls = [call for message in messages if message["role"] == "assistant" for call in message.get("tool_calls", [])]
            previous = tool_calls[-1]["function"]["name"] if tool_calls else None
            if previous == "tool_call":
                previous = json.loads(tool_calls[-1]["function"]["arguments"])["name"]
            call = None
            if not discussion:
                content = '{"title":"Synthetic artifact review"}' if title_request else "Synthetic artifact review."
            elif "Approval-check:" in str(last_user["content"]):
                if previous == "terminal":
                    content = "The proposed deletion was declined."
                else:
                    call = {"id": "approval-1", "type": "function", "function": {"name": "terminal", "arguments": json.dumps({"command": "rm -rf ./approval-fixture", "timeout": 5})}}
                    content = None
            elif "Follow-up:" in str(last_user["content"]):
                content = f"The accepted revision retains {nonce}."
            elif previous == "marginote_suggest_edit":
                content = f"Proposed a revision remembering {nonce}."
            elif previous == "marginote_read_document":
                result = json.loads(next(message["content"] for message in reversed(messages) if message["role"] == "tool"))
                source = json.loads(result["content"][0]["text"])
                args = {"revision": source["revision"], "old_text": "This claim needs discussion.", "new_text": f"This claim remembers {nonce}.", "reason": "Preserve our inherited discussion"}
                call = {"id": "edit-1", "type": "function", "function": {"name": "marginote_suggest_edit", "arguments": json.dumps(args)}}
                content = None
            else:
                call = {"id": "read-1", "type": "function", "function": {"name": "marginote_read_document", "arguments": "{}"}}
                content = None
            message = {"role": "assistant", "content": content}
            if call:
                available = {tool["function"]["name"] for tool in payload.get("tools", [])}
                if call["function"]["name"] not in available:
                    assert "tool_call" in available, "Native tool discovery bridge is absent"
                    call["function"] = {"name": "tool_call", "arguments": json.dumps({"name": call["function"]["name"], "arguments": json.loads(call["function"]["arguments"])})}
                message["tool_calls"] = [call]
            reason = "tool_calls" if call else "stop"
            self.send_response(200)
            if payload.get("stream"):
                self.send_header("Content-Type", "text/event-stream")
                self.end_headers()
                delta = copy.deepcopy(message)
                if call:
                    delta["tool_calls"][0]["index"] = 0
                chunks = [{"id": "synthetic-response", "object": "chat.completion.chunk", "created": 1, "model": "synthetic-model", "choices": [{"index": 0, "delta": delta, "finish_reason": None}]},
                          {"id": "synthetic-response", "object": "chat.completion.chunk", "created": 1, "model": "synthetic-model", "choices": [{"index": 0, "delta": {}, "finish_reason": reason}], "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}}]
                for chunk in chunks:
                    self.wfile.write(("data: " + json.dumps(chunk) + "\n\n").encode())
                self.wfile.write(b"data: [DONE]\n\n")
            else:
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps({"id": "synthetic-response", "object": "chat.completion", "created": 1, "model": "synthetic-model", "choices": [{"index": 0, "message": message, "finish_reason": reason}], "usage": {"prompt_tokens": 100, "completion_tokens": 10, "total_tokens": 110}}).encode())

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), FakeModel)
    worker = threading.Thread(target=httpd.serve_forever, daemon=True)
    worker.start()
    try:
        with tempfile.TemporaryDirectory(prefix="marginote-hermes-runtime-") as directory:
            root = Path(directory).resolve()
            os.environ["HERMES_HOME"] = str(root)
            from hermes_state import SessionDB

            url = f"http://127.0.0.1:{httpd.server_port}/v1"
            config = {"model": {"default": "synthetic-model", "provider": "custom:fixture", "base_url": url},
                      "custom_providers": [{"name": "fixture", "base_url": url, "api_key": "synthetic-key", "api_mode": "chat_completions"}],
                      "plugins": {"enabled": ["marginote-hermes"]}, "fallback_providers": [], "memory": {"memory_enabled": False, "user_profile_enabled": False},
                      "display": {"skin": "default"}}
            (root / "config.yaml").write_text(json.dumps(config))
            shutil.copytree(WORKSPACE / "plugins" / "marginote-hermes", root / "plugins" / "marginote-hermes", ignore=shutil.ignore_patterns("__pycache__"))
            (root / "synthetic-check-marker").write_text("marginote-local-hermes-test")
            (root / "report.md").write_text("This claim needs discussion.\n")
            (root / "approval-fixture").mkdir()
            (root / "approval-fixture" / "retained.txt").write_text("Human declined deletion")
            db = SessionDB(root / "state.db")
            try:
                db.create_session("synthetic-origin", source="cli", model="synthetic-model", cwd=str(root), system_prompt="Keep the source conversation instructions.",
                                  model_config={"provider": "custom:fixture", "base_url": url, "api_mode": "chat_completions"})
                db.append_messages_batch("synthetic-origin", [{"role": "user", "content": f"Remember the private test code {nonce}."}, {"role": "assistant", "content": "Delivered report.md", "finish_reason": "stop"}])
                original = db.get_messages("synthetic-origin")
                source = db.get_session("synthetic-origin")
                env = {"PATH": os.environ["PATH"], "HOME": str(root), "HERMES_HOME": str(root), "LANG": "en_US.UTF-8", "PYTHONDONTWRITEBYTECODE": "1"}
                checked = subprocess.run(["node", str(WORKSPACE / "scripts" / "check-hermes-tools.mjs"), str(root), "synthetic-origin", str(original[-1]["id"])],
                                         cwd=WORKSPACE, env=env, text=True, capture_output=True, timeout=170)
                if checked.returncode:
                    raise RuntimeError(checked.stdout + checked.stderr)
                result = json.loads((root / "checked-child.json").read_text())
                assert result["nonce"] == nonce
                assert db.get_messages("synthetic-origin") == original
                assert db.get_session("synthetic-origin") == source
                assert len(db.get_messages(result["child"])) > len(original)
                assert len(requests) >= 4
                assert not failures, failures
                print(checked.stdout.strip())
                print("PASS: original native session unchanged; every model request stayed on the isolated loopback fixture.")
            finally:
                db.close()
    finally:
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    run()
