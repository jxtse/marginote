"""Native Hermes snapshot preparation. This module never invokes a model."""

import copy
import hashlib
import json
from pathlib import Path
import re
import sys
import signal
import threading
import time
import uuid

MAX_ROWS = 20_000
MAX_BYTES = 64 * 1024 * 1024
ID = re.compile(r"^[\w-]{1,160}$")
JSON_FIELDS = {"tool_calls", "reasoning_details", "codex_reasoning_items", "codex_message_items", "display_metadata"}


def payloads(rows):
    """Exclude native row addresses, keeping every persisted payload field."""
    result = []
    for row in rows:
        value = {key: item for key, item in row.items() if key not in {"id", "session_id", "_row_id", "active", "compacted"}}
        for key in JSON_FIELDS:
            if isinstance(value.get(key), str):
                value[key] = json.loads(value[key])
        result.append(value)
    return result


def digest(rows):
    data = json.dumps(payloads(rows), sort_keys=True, ensure_ascii=False).encode()
    if len(data) > MAX_BYTES:
        raise ValueError("Hermes history exceeds the 64 MiB snapshot limit")
    return hashlib.sha256(data).hexdigest()


def _config(session):
    value = session.get("model_config") or {}
    value = json.loads(value) if isinstance(value, str) else copy.deepcopy(value)
    if not isinstance(value, dict):
        raise ValueError("Invalid native Hermes model configuration")
    return value


def _rows(db, session_id):
    rows = db.get_messages(session_id, include_inactive=True, limit=MAX_ROWS + 1)
    if len(rows) > MAX_ROWS:
        raise ValueError("Hermes history exceeds the 20000-row snapshot limit")
    digest(rows)
    return rows


def fork_delivery(db, session_id, message_id):
    """Copy an exact active delivery prefix through native SessionDB APIs.

    Preserves native live context and searchable compacted history. Never ends,
    rewinds, reparents or prompts the source session. Later parent rows stay out.
    """
    for method in ("get_messages", "get_session", "create_session", "append_messages_batch", "archive_and_compact", "delete_session"):
        if not callable(getattr(db, method, None)):
            raise RuntimeError(f"This Hermes runtime lacks required native session operation: {method}")
    if not isinstance(session_id, str) or not ID.fullmatch(session_id):
        raise ValueError("An exact Hermes session ID is required")
    if isinstance(message_id, bool) or not isinstance(message_id, int) or message_id <= 0:
        raise ValueError("An exact positive native message row ID is required")
    source = db.get_session(session_id)
    if not source:
        raise ValueError("Hermes session was not found in the current profile")
    if not source.get("model") or not source.get("cwd"):
        raise ValueError("The Hermes session lacks its original model or working directory")
    cwd = str(Path(source["cwd"]).resolve(strict=True))
    config = _config(source)
    from hermes_state import _BARE_BILLING_PROVIDERS

    provider = config.get("provider") or config.get("billing_provider") or source.get("billing_provider")
    if not isinstance(provider, str) or not provider.strip() or provider.lower() in _BARE_BILLING_PROVIDERS:
        raise ValueError("The Hermes session lacks a routable provider identity; restore it in the native client first")
    own = _rows(db, session_id)
    boundary = next((row for row in own if row["id"] == message_id), None)
    if not boundary or not boundary.get("active"):
        raise ValueError("The delivery row is absent or has been compacted/rewound; select a completed active delivery in the native client")
    if boundary["role"] != "assistant" or boundary.get("tool_calls") or boundary.get("display_kind") or not boundary.get("content"):
        raise ValueError("The delivery must be an assistant answer without pending tool calls")
    if boundary.get("finish_reason") not in {"stop", "end_turn", "stop_sequence"}:
        raise ValueError("The delivery does not have a recorded successful completion")
    active = [row for row in own if row["id"] <= message_id and row.get("active")]
    archives = [row for row in own if row["id"] <= message_id and not row.get("active") and row.get("compacted")]
    # Old Hermes builds represented compaction with parent sessions. Preserve
    # their historical rows as archives in the independent child, never a live
    # parent reference whose later messages could leak into this conversation.
    originals = [(session_id, own)]
    total_rows = len(own)
    total_bytes = len(json.dumps(own).encode())
    current = source
    seen = {session_id}
    for _ in range(100):
        parent_id = current.get("parent_session_id")
        current_config = _config(current)
        if not parent_id or any(current_config.get(key) == parent_id for key in ("_branched_from", "_delegate_from", "_reset_from")):
            break
        if parent_id in seen:
            raise ValueError("Hermes session lineage contains a cycle")
        parent = db.get_session(parent_id)
        if not parent or parent.get("end_reason") != "compression":
            break
        seen.add(parent_id)
        rows = _rows(db, parent_id)
        total_rows += len(rows)
        total_bytes += len(json.dumps(rows).encode())
        if total_rows > MAX_ROWS or total_bytes > MAX_BYTES:
            raise ValueError("Combined Hermes history exceeds the snapshot limit")
        originals.append((parent_id, rows))
        archives = [row for row in rows if row.get("active") or row.get("compacted")] + archives
        current = parent
    else:
        raise ValueError("Hermes compression lineage exceeds 100 sessions")
    if len(archives) + len(active) > MAX_ROWS:
        raise ValueError("Combined Hermes history exceeds the snapshot row limit")
    expected_active, expected_archives = digest(active), digest(archives)
    fingerprints = {key: digest(rows) for key, rows in originals}
    child_id = str(uuid.uuid4())
    child_config = {key: value for key, value in config.items() if key not in {"_branched_from", "_delegate_from", "_reset_from"}}
    child_config.update({"provider": provider, "_branched_from": session_id, "_marginote_delivery_row_id": message_id})
    created = False
    try:
        db.create_session(child_id, source=source.get("source") or "cli", model=source["model"], model_config=child_config,
                          system_prompt=source.get("system_prompt"), parent_session_id=session_id, cwd=cwd,
                          profile_name=source.get("profile_name"), git_repo_root=source.get("git_repo_root"))
        created = True
        if archives:
            db.append_messages_batch(child_id, copy.deepcopy(archives))
            db.archive_and_compact(child_id, copy.deepcopy(active))
        else:
            db.append_messages_batch(child_id, copy.deepcopy(active))
        inherited = _rows(db, child_id)
        if digest([row for row in inherited if row.get("active")]) != expected_active or digest([row for row in inherited if row.get("compacted")]) != expected_archives:
            raise ValueError("Hermes could not preserve every native message payload; the snapshot was discarded")
        copied = db.get_session(child_id)
        if copied["model"] != source["model"] or copied["system_prompt"] != source["system_prompt"] or _config(copied) != child_config:
            raise ValueError("Hermes did not preserve the native runtime metadata")
        for original_id, _ in originals:
            if digest(_rows(db, original_id)) != fingerprints[original_id]:
                raise ValueError("Hermes history changed during the fork; retry from a stable delivery")
        latest = db.get_session(session_id)
        if any(latest.get(key) != source.get(key) for key in ("model", "model_config", "system_prompt", "cwd", "billing_provider", "profile_name")):
            raise ValueError("Hermes runtime metadata changed during the fork; retry from a stable delivery")
        return {"sessionId": child_id, "originSessionId": session_id, "deliveryRowId": message_id,
                "model": source["model"], "provider": provider, "reasoningEffort": (config.get("reasoning_config") or {}).get("effort"),
                "cwd": cwd, "activeMessages": len(active), "archivedMessages": len(archives)}
    except BaseException:
        if created:
            if not db.delete_session(child_id, expected_delete_ids=[child_id]):
                raise RuntimeError(f"Snapshot validation failed; inspect incomplete child {child_id}")
        raise


def wait_delivery(db, session_id, after_message_id, cancelled, timeout=570):
    """Wait only for this caller's next completed answer, never a recent session."""
    if not isinstance(session_id, str) or not ID.fullmatch(session_id):
        raise ValueError("An exact Hermes session ID is required")
    if isinstance(after_message_id, bool) or not isinstance(after_message_id, int) or after_message_id < 0:
        raise ValueError("Invalid delivery marker")
    deadline = time.monotonic() + timeout
    while not cancelled.is_set():
        source = db.get_session(session_id)
        if not source:
            raise ValueError("The originating Hermes session is unavailable in this profile")
        if source.get("end_reason") == "compression":
            raise RuntimeError("Hermes rotated the originating session; reopen review from its current session")
        for row in _rows(db, session_id):
            if (row["id"] > after_message_id and row.get("active") and row["role"] == "assistant"
                    and row.get("content") and not row.get("tool_calls") and not row.get("display_kind")
                    and row.get("finish_reason") in {"stop", "end_turn", "stop_sequence"}):
                return {"sessionId": session_id, "messageId": row["id"]}
        if time.monotonic() >= deadline:
            raise TimeoutError("Hermes delivery has not completed; finish the originating turn, then retry connecting")
        cancelled.wait(0.25)
    raise RuntimeError("Hermes delivery wait cancelled")


class BridgePeer:
    def __init__(self, output):
        self.output = output
        self.lock = threading.RLock()
        self.pending = {}
        self.cancelled = threading.Event()
        self.turn = None
        self.worker = None

    def send(self, frame):
        with self.lock:
            self.output.write(json.dumps(frame, ensure_ascii=False) + "\n")
            self.output.flush()

    def call(self, method, params):
        request_id = "host-" + str(uuid.uuid4())
        event = threading.Event()
        entry = {"event": event, "response": None}
        with self.lock:
            if len(self.pending) >= 8 or self.cancelled.is_set():
                raise RuntimeError("Marginote client is unavailable or has too many pending requests")
            self.pending[request_id] = entry
        try:
            self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            if not event.wait(600) or self.cancelled.is_set():
                raise RuntimeError("Marginote client request cancelled or timed out")
            response = entry["response"] or {}
            if "error" in response:
                raise RuntimeError("Marginote rejected the native callback")
            return response.get("result")
        finally:
            with self.lock:
                self.pending.pop(request_id, None)

    def receive(self, frame):
        with self.lock:
            entry = self.pending.get(frame.get("id"))
            if entry:
                entry["response"] = frame
                entry["event"].set()

    def cancel(self):
        self.cancelled.set()
        with self.lock:
            for entry in self.pending.values():
                entry["event"].set()
        if self.turn:
            self.turn.cancel()

    def start_turn(self, db, ctx, request_id, params):
        if self.worker is not None:
            raise ValueError("Each native bridge process accepts one artifact turn")
        from .runtime import NativeTurn

        self.turn = NativeTurn(db, ctx, self.call, self.cancelled)

        def run():
            try:
                result = self.turn.run(params)
                self.send({"jsonrpc": "2.0", "id": request_id, "result": result})
            except Exception as error:
                self.send({"jsonrpc": "2.0", "id": request_id, "error": {"code": -32000, "message": str(error)}})

        self.worker = threading.Thread(target=run, name="marginote-native-turn", daemon=True)
        self.worker.start()


def main(ctx=None):
    """Bounded JSON-RPC stdio interface; no database path supplied by clients."""
    from hermes_constants import get_hermes_home
    from hermes_state import SessionDB

    # Do not create a profile database merely because the plugin was invoked.
    path = get_hermes_home() / "state.db"
    if not path.is_file():
        raise RuntimeError("No native Hermes session database in the current profile")
    db = SessionDB(path)
    peer = BridgePeer(sys.stdout)
    previous_term = signal.getsignal(signal.SIGTERM)

    def stop(signum, frame):
        peer.cancel()
        raise KeyboardInterrupt()

    signal.signal(signal.SIGTERM, stop)
    try:
        while line := sys.stdin.buffer.readline(1024 * 1024 + 1):
            if len(line) > 1024 * 1024:
                raise ValueError("Marginote bridge request exceeds 1 MiB")
            request_id = None
            try:
                request = json.loads(line)
                request_id = request["id"]
                method = request.get("method")
                if not method:
                    peer.receive(request)
                    continue
                if method == "initialize":
                    result = {"protocolVersion": 1, "capabilities": ["fork_delivery", "wait_delivery"] + (["prompt"] if ctx is not None else [])}
                elif method == "wait_delivery":
                    if peer.worker is not None:
                        raise ValueError("Cannot wait for delivery during a native conversation")
                    params = request.get("params", {})
                    result = wait_delivery(db, params.get("sessionId"), params.get("afterMessageId"), peer.cancelled)
                elif method == "fork_delivery":
                    if peer.worker is not None:
                        raise ValueError("Cannot fork during a native conversation")
                    params = request.get("params", {})
                    result = fork_delivery(db, params.get("sessionId"), params.get("messageId"))
                elif method == "prompt" and ctx is not None:
                    peer.start_turn(db, ctx, request_id, request.get("params", {}))
                    continue
                else:
                    raise ValueError("Unsupported Marginote Hermes operation")
                response = {"jsonrpc": "2.0", "id": request_id, "result": result}
            except Exception as error:
                response = {"jsonrpc": "2.0", "id": request_id, "error": {"code": -32602, "message": str(error)}}
            peer.send(response)
    except KeyboardInterrupt:
        pass
    finally:
        peer.cancel()
        if peer.worker:
            peer.worker.join(timeout=1)
        signal.signal(signal.SIGTERM, previous_term)
        db.close()
