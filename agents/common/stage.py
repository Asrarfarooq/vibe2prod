import asyncio
import logging
import os
from datetime import datetime, timezone
from typing import Any

from google.adk import Runner
from google.adk.agents.run_config import RunConfig
from google.adk.apps import App
from google.adk.plugins.base_plugin import BasePlugin
from google.adk.sessions import InMemorySessionService
from google.cloud import firestore
from google.genai import types

from .context import RunContext
from .events import Emitter

logger = logging.getLogger(__name__)
USER_ID = "vibe2prod"


async def set_stage(
    client: firestore.AsyncClient,
    run: RunContext,
    status: str,
    summary: str | None = None,
    artifacts: list[dict] | None = None,
    result: dict | None = None,
) -> None:
    """Records the stage outcome on the run doc. awaiting_approval hands control to the dashboard."""
    now = datetime.now(timezone.utc)
    updates: dict[str, Any] = {
        f"stages.{run.stage}.status": status,
        f"stages.{run.stage}.ended_at": now,
        "updated_at": now,
        "status": "awaiting_approval" if status == "awaiting_approval" else "failed",
    }
    if status == "failed":
        updates["current_stage"] = None
    if summary is not None:
        updates[f"stages.{run.stage}.summary"] = summary
    if artifacts is not None:
        updates[f"stages.{run.stage}.artifacts"] = artifacts
    if result is not None:
        updates[f"stages.{run.stage}.result"] = result
    await client.collection("runs").document(run.run_id).update(updates)


async def run_workflow(
    root: Any,
    run: RunContext,
    plugins: list[BasePlugin],
    prompt: str,
    state: dict,
    max_llm_calls: int,
    timeout_s: float,
    partial_on_timeout: bool = False,
) -> dict:
    """Runs one stage headless and returns the final session state.

    With partial_on_timeout, hitting timeout_s returns the state so far with timed_out=True.
    """
    app = App(name=f"vibe2prod_{run.stage}", root_agent=root, plugins=plugins)
    sessions = InMemorySessionService()
    timed_out = False
    async with Runner(app=app, session_service=sessions) as runner:
        session = await sessions.create_session(
            app_name=app.name, user_id=USER_ID, session_id=run.run_id, state=state
        )
        message = types.Content(role="user", parts=[types.Part(text=prompt)])
        config = RunConfig(
            max_llm_calls=max_llm_calls,
            labels={"run_id": run.run_id.lower()[:63], "stage": run.stage},
        )
        try:
            async with asyncio.timeout(timeout_s):
                async for _ in runner.run_async(
                    user_id=USER_ID,
                    session_id=session.id,
                    new_message=message,
                    run_config=config,
                ):
                    pass
        except TimeoutError:
            if not partial_on_timeout:
                raise
            timed_out = True
        final = await sessions.get_session(
            app_name=app.name, user_id=USER_ID, session_id=session.id
        )
    return {**final.state, "timed_out": timed_out}


async def guarded(
    client: firestore.AsyncClient, run: RunContext, emitter: Emitter, body
) -> int:
    """Runs a stage body; any failure marks the stage failed with the error, never left running."""
    await emitter.safe_emit("status", "system", "Stage started")
    try:
        await body()
        return 0
    except Exception as err:
        logger.exception("Stage failed")
        message = f"{err.__class__.__name__}: {err}"[:1000]
        if not emitter.last_error.startswith(message[:200]):
            await emitter.safe_emit("error", "system", message)
        try:
            await set_stage(client, run, "failed", summary=message)
        except Exception:
            logger.exception("Could not record failure")
        return 1


def env_int(name: str, default: int) -> int:
    return int(os.environ.get(name, default))
