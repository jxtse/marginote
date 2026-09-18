"""One native TUI continuation, restricted to an already-bound Marginote child."""

import copy
import json
import os
import queue
import threading
import time


class NativeTurn:
    def __init__(self, db, ctx, call_client, cancelled):
        self.db = db
        self.ctx = ctx
        self.call_client = call_client
        self.cancelled = cancelled
        self.frames = queue.Queue(maxsize=512)
        self.server = None
        self.live = None
        self.agent = None
        self.sequence = 0
        self.registrations = []

    def write(self, frame):
        if self.cancelled.is_set():
            return False
        # Stream deltas/tool output stay in the native transcript. The parent
        # needs only terminal results and explicit permission/interactive events.
        if frame.get("method") == "event":
            kind = (frame.get("params") or {}).get("type", "")
            if kind not in {"message.complete", "error"} and not kind.endswith(".request"):
                return True
        try:
            self.frames.put_nowait(frame)
            return True
        except queue.Full:
            self.cancelled.set()
            return False

    def close(self):
        pass  # Lifecycle is owned by the stdio bridge, not native transports.

    def _next(self, deadline):
        while not self.cancelled.is_set():
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                raise TimeoutError("Native Hermes operation timed out")
            try:
                return self.frames.get(timeout=min(0.2, remaining))
            except queue.Empty:
                continue
        raise RuntimeError("Hermes conversation cancelled")

    def _request(self, method, params, timeout=60):
        self.sequence += 1
        request_id = f"native-{self.sequence}"
        immediate = self.server.dispatch({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params}, transport=self)
        deferred = []
        try:
            deadline = time.monotonic() + timeout
            while immediate is None:
                frame = self._next(deadline)
                if frame.get("id") == request_id:
                    immediate = frame
                else:
                    deferred.append(frame)
            if "error" in immediate:
                raise RuntimeError((immediate["error"] or {}).get("message", "Native Hermes request failed"))
            return immediate.get("result") or {}
        finally:
            for frame in deferred:
                self.frames.put_nowait(frame)

    def cancel(self):
        if self.server and self.live:
            record = self.server._sessions.get(self.live)
            if record and record.get("running"):
                self.server.dispatch({"id": "native-cancel", "method": "session.interrupt", "params": {"session_id": self.live}}, transport=self)

    def _approval(self, payload):
        request_id = payload.get("request_id")
        if not isinstance(request_id, str) or not request_id:
            raise RuntimeError("Hermes approval did not identify the exact request")
        answer = self.call_client("marginote/approve", {"id": request_id, "detail": json.dumps(payload, ensure_ascii=False, indent=2)})
        if self.cancelled.is_set():
            raise RuntimeError("Hermes conversation cancelled")
        return {"choice": "once" if answer is True else "deny", "all": False}

    def _server_request(self, frame):
        # Current Hermes asks the renderer via peer JSON-RPC, rather than a
        # *.request event. Reply to the wire id, not the approval queue id.
        request_id = frame.get("id")
        try:
            payload = frame.get("params") or {}
            if not isinstance(request_id, str) or not request_id:
                raise RuntimeError("Hermes interactive request has no valid id")
            if payload.get("session_id") != self.live:
                raise RuntimeError("Hermes interactive request belongs to a different session")
            if frame["method"] != "approval":
                raise RuntimeError(f"Continue in the native Hermes client: unsupported request {frame['method']}")
            result = self._approval(payload)
        except Exception as error:
            self.server.dispatch({"jsonrpc": "2.0", "id": request_id,
                                  "error": {"code": -32601, "message": str(error)}}, transport=self)
            raise
        self.server.dispatch({"jsonrpc": "2.0", "id": request_id, "result": result}, transport=self)

    def _tools(self, definitions, child_id):
        expected = {"marginote_read_document", "marginote_suggest_edit"}
        if not isinstance(definitions, list) or {tool.get("name") for tool in definitions if isinstance(tool, dict)} != expected or len(definitions) != 2:
            raise ValueError("The two scoped Marginote artifact tools are required")
        for definition in definitions:
            name = definition["name"]
            schema = definition.get("inputSchema")
            if not isinstance(schema, dict) or schema.get("type") != "object":
                raise ValueError("Invalid artifact tool schema")

            def handler(args, _name=name, **kwargs):
                if self.cancelled.is_set():
                    return json.dumps({"error": "Conversation cancelled"})
                task_id = kwargs.get("task_id")
                if task_id and task_id != child_id:
                    return json.dumps({"error": "Artifact tools belong to the bound child only"})
                if self.agent is None:
                    return json.dumps({"error": "Native model identity is unavailable"})
                # Native fallback routing may change the model within a turn.
                # Attribute each artifact action to the current native model.
                self.call_client("marginote/model", {"model": self.agent.model})
                response = self.call_client("marginote/tool", {"name": _name, "arguments": args})
                return json.dumps(response, ensure_ascii=False)

            registration = self.ctx.register_tool(name=name, toolset="marginote-artifact", description=definition["description"],
                schema={"name": name, "description": definition["description"], "parameters": copy.deepcopy(schema)}, handler=handler)
            self.registrations.append(registration)

    def run(self, params):
        from .bridge import _config

        child_id = params.get("sessionId")
        origin_id = params.get("originSessionId")
        text = params.get("text")
        if not isinstance(child_id, str) or not isinstance(origin_id, str) or child_id == origin_id:
            raise ValueError("An exact distinct Hermes child session is required")
        source = self.db.get_session(child_id)
        config = _config(source or {})
        if not source or config.get("_branched_from") != origin_id or not config.get("_marginote_delivery_row_id"):
            raise ValueError("The Hermes child is not a verified Marginote delivery snapshot")
        if not isinstance(text, str) or not text.strip() or len(text.encode()) > 512 * 1024:
            raise ValueError("Invalid artifact discussion prompt")
        previous_toolsets = os.environ.get("HERMES_TUI_TOOLSETS")
        try:
            self._tools(params.get("tools"), child_id)
            # Use native protocol handlers without entry.main(): that entry point
            # also schedules a profile-wide orphan sweep, which this bridge must not run.
            from tui_gateway import server

            self.server = server
            # Native coding posture can return before it adds plugin toolsets.
            # Preserve its exact selection and add only our scoped capability
            # through Hermes's existing process-local toolset parameter.
            selected = server._load_enabled_toolsets(source.get("source") or "cli")
            if selected and "marginote-artifact" not in selected:
                os.environ["HERMES_TUI_TOOLSETS"] = ",".join([*selected, "marginote-artifact"])
            resumed = self._request("session.resume", {"session_id": child_id, "source": source.get("source") or "cli", "omit_messages": True, "eager_build": True})
            self.live = resumed.get("session_id")
            record = server._sessions.get(self.live)
            if not record or record.get("session_key") != child_id:
                raise RuntimeError("Hermes resumed a different native session")
            agent = record.get("agent")
            self.agent = agent
            if agent is None or agent.session_id != child_id or agent.model != source["model"]:
                raise RuntimeError(f"Hermes did not restore the recorded session and model (expected model {source['model']!r}, received {getattr(agent, 'model', None)!r}; session matched: {getattr(agent, 'session_id', None) == child_id})")
            actual_provider = getattr(agent, "provider", None)
            # Native custom routes resolve to the generic transport class;
            # validate the durable route metadata plus endpoint in that case.
            expected_provider = config.get("provider")
            if expected_provider and not str(expected_provider).startswith("custom:") and actual_provider != expected_provider:
                raise RuntimeError("Hermes restored a different provider")
            if config.get("base_url") and str(getattr(agent, "base_url", "")).rstrip("/") != str(config["base_url"]).rstrip("/"):
                raise RuntimeError("Hermes restored a different provider endpoint")
            from model_tools import get_tool_definitions
            catalog = get_tool_definitions(enabled_toolsets=agent.enabled_toolsets, disabled_toolsets=agent.disabled_toolsets,
                                           quiet_mode=True, skip_tool_search_assembly=True)
            required = {"marginote_read_document", "marginote_suggest_edit"}
            visible = getattr(agent, "valid_tool_names", set())
            if not required.issubset({tool["function"]["name"] for tool in catalog}) or not (required.issubset(visible) or {"tool_search", "tool_describe", "tool_call"}.issubset(visible)):
                raise RuntimeError("Hermes artifact tools are disabled or unavailable in this session")
            self.call_client("marginote/model", {"model": agent.model})
            self._request("prompt.submit", {"session_id": self.live, "text": text + "\n\nThe Marginote artifact tools may be deferred by native Tool Search. If their schemas are not visible, use tool_search/tool_describe and invoke them through tool_call with their exact names."})
            deadline = time.monotonic() + 600
            while True:
                frame = self._next(deadline)
                if frame.get("method") and "id" in frame:
                    self._server_request(frame)
                    continue
                if frame.get("method") != "event":
                    continue
                event = frame.get("params") or {}
                if event.get("session_id") != self.live:
                    continue
                kind, payload = event.get("type"), event.get("payload") or {}
                if kind == "approval.request":
                    decision = self._approval(payload)
                    result = self._request("approval.respond", {"session_id": self.live, "request_id": payload["request_id"], **decision})
                    if result.get("resolved") != 1:
                        raise RuntimeError("The native Hermes approval expired or was not resolved")
                elif kind == "message.complete":
                    if payload.get("status") != "complete" or not str(payload.get("text") or "").strip():
                        raise RuntimeError("Hermes did not complete the artifact discussion successfully")
                    # Terminal text precedes the native finally block. Wait for
                    # native persistence/cleanup before allowing process teardown.
                    settled = time.monotonic() + 30
                    while record.get("running") and time.monotonic() < settled and not self.cancelled.is_set():
                        time.sleep(0.02)
                    if record.get("running") or self.cancelled.is_set():
                        raise RuntimeError("Hermes turn did not settle; inspect the child before retrying")
                    if record.get("session_key") != child_id or agent.session_id != child_id:
                        raise RuntimeError("Hermes changed the native session during this turn; inspect it before retrying")
                    self.call_client("marginote/model", {"model": agent.model})
                    return {"sessionId": child_id, "text": payload["text"]}
                elif kind == "error" or str(kind).endswith(".request"):
                    raise RuntimeError(f"Continue in the native Hermes client: unsupported event {kind}")
        finally:
            self.cancel()
            if self.live and not self.cancelled.is_set():
                try:
                    self._request("session.close", {"session_id": self.live}, timeout=10)
                except Exception:
                    pass
            for registration in reversed(self.registrations):
                if registration is not None:
                    registration.dispose()
            if previous_toolsets is None:
                os.environ.pop("HERMES_TUI_TOOLSETS", None)
            else:
                os.environ["HERMES_TUI_TOOLSETS"] = previous_toolsets
