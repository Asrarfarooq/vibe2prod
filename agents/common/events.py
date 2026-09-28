import json
import logging
from datetime import datetime, timezone
from typing import Any

from google.adk.plugins.base_plugin import BasePlugin
from google.api_core.exceptions import AlreadyExists
from google.cloud import firestore

from .context import RunContext

logger = logging.getLogger(__name__)
MAX_TEXT = 4000
MAX_DATA = 8000


def _clip(value: Any) -> Any:
    encoded = json.dumps(value, default=str)
    if len(encoded) <= MAX_DATA:
        return json.loads(encoded)
    return {"truncated": True, "preview": encoded[:MAX_DATA]}


class Emitter:
    """Writes dashboard events to runs/{id}/events/{seq:08d}."""

    def __init__(self, client: firestore.AsyncClient, run: RunContext):
        self._events = (
            client.collection("runs").document(run.run_id).collection("events")
        )
        self._stage = run.stage
        self._seq: int | None = None
        self.last_error = ""

    async def _next_seq(self) -> int:
        if self._seq is None:
            latest = [
                s
                async for s in self._events.order_by(
                    "seq", direction=firestore.Query.DESCENDING
                )
                .limit(1)
                .stream()
            ]
            self._seq = latest[0].to_dict()["seq"] if latest else -1
        self._seq += 1
        return self._seq

    async def emit(
        self, kind: str, author: str, text: str, data: Any | None = None
    ) -> None:
        doc = {
            "stage": self._stage,
            "kind": kind,
            "author": author,
            "text": text[:MAX_TEXT],
            "data": _clip(data) if data is not None else None,
            "ts": datetime.now(timezone.utc),
        }
        if kind == "error":
            self.last_error = text
        # The dashboard may also append events; retry on a seq collision.
        for _ in range(5):
            seq = await self._next_seq()
            try:
                await self._events.document(f"{seq:08d}").create({"seq": seq, **doc})
                return
            except AlreadyExists:
                continue
        logger.warning("Dropped event after seq collisions: %s", text[:80])

    async def safe_emit(self, *args: Any, **kwargs: Any) -> None:
        try:
            await self.emit(*args, **kwargs)
        except Exception:
            logger.exception("Event write failed")


def _author(event: Any) -> str:
    path = getattr(getattr(event, "node_info", None), "path", None)
    if path:
        parts = path if isinstance(path, (list, tuple)) else str(path).split("/")
        return str(parts[-1])
    return event.author or "agent"


class FirestoreEventsPlugin(BasePlugin):
    """Streams model thoughts, tool calls, tool results and outputs to the dashboard."""

    def __init__(self, emitter: Emitter):
        super().__init__(name="firestore_events")
        self._emitter = emitter

    async def on_event_callback(self, *, invocation_context, event):
        if event.partial:
            return
        author = _author(event)
        if event.error_code:
            await self._emitter.safe_emit(
                "error", author, f"{event.error_code}: {event.error_message or ''}"
            )
        for part in (event.content.parts or []) if event.content else []:
            if part.function_call:
                await self._emitter.safe_emit(
                    "tool_call",
                    author,
                    part.function_call.name,
                    {"args": dict(part.function_call.args or {})},
                )
            elif part.function_response:
                await self._emitter.safe_emit(
                    "tool_result",
                    author,
                    part.function_response.name,
                    {"result": part.function_response.response},
                )
            elif part.text and part.thought:
                await self._emitter.safe_emit("thought", author, part.text)
            elif part.text:
                await self._emitter.safe_emit("output", author, part.text)
        return
