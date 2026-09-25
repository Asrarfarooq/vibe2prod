import asyncio
import hmac
import json
import os
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Literal

from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from google.cloud import firestore, run_v2
from pydantic import BaseModel, Field

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "vibe2prod-509620")
REGION = os.environ.get("REGION", "us-central1")
# JSON object mapping approver email to that person's key, injected from Secret Manager.
APPROVER_KEYS: dict[str, str] = json.loads(os.environ.get("APPROVER_KEYS") or "{}")
STATIC_DIR = Path(
    os.environ.get("STATIC_DIR", Path(__file__).resolve().parent / "static")
)

STAGES = [
    (
        "codeguard",
        "CodeGuard",
        "Scans the app for secrets, vulnerable dependencies and insecure code, then opens a PR with fixes.",
    ),
    (
        "architect",
        "Architect + Critic",
        "Writes the design doc for running the app on GCP; a critic agent reviews it for gaps.",
    ),
    (
        "iac",
        "IaC + Cost",
        "Writes Terraform for the design and estimates the monthly cost.",
    ),
    (
        "deploy",
        "Deploy + Audit",
        "Applies the Terraform, deploys the app and scores production readiness.",
    ),
]
STAGE_KEYS = [key for key, _, _ in STAGES]
STAGE_JOBS = {key: f"{key}-agent" for key in STAGE_KEYS}
HEARTBEAT_SECONDS = 15

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
db = firestore.AsyncClient(project=PROJECT)
sync_db = firestore.Client(project=PROJECT)


@app.middleware("http")
async def security_headers(request: Request, call_next):
    response = await call_next(request)
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "same-origin"
    response.headers["Permissions-Policy"] = "camera=(), microphone=(), geolocation=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; img-src 'self' data:; style-src 'self'; font-src 'self'; "
        "connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
    )
    if request.url.path.startswith("/api/"):
        response.headers["Cache-Control"] = "no-store"
    return response


def approver_for(key: str | None) -> str | None:
    """Returns the approver email whose key matches, comparing every key in constant time."""
    if not key:
        return None
    match = None
    for email, expected in APPROVER_KEYS.items():
        if hmac.compare_digest(key.encode(), expected.encode()):
            match = email
    return match


def iso(value: Any) -> str | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.astimezone(timezone.utc).isoformat()
    return str(value)


def serialize_run(run_id: str, doc: dict) -> dict:
    stored = doc.get("stages", {})
    stages = []
    for key, name, description in STAGES:
        stage = stored.get(key, {})
        decision = stage.get("decision")
        stages.append(
            {
                "key": key,
                "name": name,
                "agent_description": description,
                "status": stage.get("status", "queued"),
                "started_at": iso(stage.get("started_at")),
                "ended_at": iso(stage.get("ended_at")),
                "summary": stage.get("summary"),
                "decision": {**decision, "at": iso(decision.get("at"))}
                if decision
                else None,
                "artifacts": stage.get("artifacts", []),
            }
        )
    return {
        "id": run_id,
        "number": doc.get("number"),
        "project_id": doc.get("project_id"),
        "project": doc.get("project", PROJECT),
        "app": doc.get("app", {}),
        "status": doc.get("status", "running"),
        "current_stage": doc.get("current_stage"),
        "created_at": iso(doc.get("created_at")),
        "updated_at": iso(doc.get("updated_at")),
        "stages": stages,
        "score": doc.get("score"),
    }


def summarize_run(run_id: str, doc: dict) -> dict:
    return {
        "id": run_id,
        "number": doc.get("number"),
        "project_id": doc.get("project_id"),
        "app": doc.get("app", {}),
        "status": doc.get("status", "running"),
        "current_stage": doc.get("current_stage"),
        "created_at": iso(doc.get("created_at")),
        "score_total": (doc.get("score") or {}).get("total"),
    }


def serialize_event(doc: dict) -> dict:
    return {
        "seq": doc.get("seq"),
        "stage": doc.get("stage"),
        "kind": doc.get("kind"),
        "author": doc.get("author", ""),
        "text": doc.get("text", ""),
        "data": doc.get("data"),
        "ts": iso(doc.get("ts")),
    }


async def load_run(run_id: str) -> dict:
    snapshot = await db.collection("runs").document(run_id).get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="Run not found")
    return serialize_run(run_id, snapshot.to_dict())


async def project_runs(project_id: str) -> list[tuple[str, dict]]:
    """Returns the project's runs, newest first. Sorted here to avoid a composite index."""
    query = db.collection("runs").where(
        filter=firestore.FieldFilter("project_id", "==", project_id)
    )
    runs = [(s.id, s.to_dict()) async for s in query.stream()]
    epoch = datetime.min.replace(tzinfo=timezone.utc)
    runs.sort(key=lambda r: r[1].get("created_at") or epoch, reverse=True)
    return runs


async def serialize_project(project_id: str, doc: dict) -> dict:
    runs = await project_runs(project_id)
    history = [
        {
            "run_id": run_id,
            "number": run.get("number"),
            "total": run["score"]["total"],
            "at": iso(run.get("created_at")),
        }
        for run_id, run in reversed(runs)
        if (run.get("score") or {}).get("total") is not None
    ]
    return {
        "id": project_id,
        "name": doc.get("name", project_id),
        "repo": doc.get("repo"),
        "repo_url": doc.get("repo_url"),
        "branch": doc.get("branch", "main"),
        "target_project": doc.get("target_project", PROJECT),
        "app_url": doc.get("app_url"),
        "created_at": iso(doc.get("created_at")),
        "latest_run": summarize_run(*runs[0]) if runs else None,
        "score_history": history,
    }


@app.get("/api/projects")
async def list_projects() -> dict:
    snapshots = [s async for s in db.collection("projects").order_by("name").stream()]
    return {"projects": [await serialize_project(s.id, s.to_dict()) for s in snapshots]}


@app.get("/api/projects/{project_id}")
async def get_project(project_id: str) -> dict:
    snapshot = await db.collection("projects").document(project_id).get()
    if not snapshot.exists:
        raise HTTPException(status_code=404, detail="Project not found")
    return await serialize_project(project_id, snapshot.to_dict())


@app.get("/api/projects/{project_id}/runs")
async def list_project_runs(project_id: str) -> dict:
    await get_project(project_id)
    return {"runs": [summarize_run(i, d) for i, d in await project_runs(project_id)]}


@app.get("/api/runs/{run_id}")
async def get_run(run_id: str) -> dict:
    return await load_run(run_id)


async def events_after(run_id: str, after: int) -> list[dict]:
    query = (
        db.collection("runs")
        .document(run_id)
        .collection("events")
        .where(filter=firestore.FieldFilter("seq", ">", after))
        .order_by("seq")
    )
    return [serialize_event(s.to_dict()) async for s in query.stream()]


@app.get("/api/runs/{run_id}/events")
async def get_events(run_id: str, after: int = -1) -> dict:
    await load_run(run_id)
    return {"events": await events_after(run_id, after)}


def sse(event: str, data: dict, event_id: int | None = None) -> str:
    head = f"id: {event_id}\n" if event_id is not None else ""
    return f"{head}event: {event}\ndata: {json.dumps(data, separators=(',', ':'))}\n\n"


@app.get("/api/runs/{run_id}/stream")
async def stream(
    run_id: str, request: Request, last_event_id: str | None = Header(default=None)
):
    await load_run(run_id)
    try:
        after = int(last_event_id) if last_event_id is not None else -1
    except ValueError:
        after = -1

    loop = asyncio.get_running_loop()
    queue: asyncio.Queue[tuple[str, Any]] = asyncio.Queue()
    run_ref = sync_db.collection("runs").document(run_id)

    def on_run(snapshots, _changes, _read_time):
        for snapshot in snapshots:
            if snapshot.exists:
                loop.call_soon_threadsafe(
                    queue.put_nowait, ("run", serialize_run(run_id, snapshot.to_dict()))
                )

    def on_events(_snapshots, changes, _read_time):
        for change in changes:
            if change.type.name == "ADDED":
                loop.call_soon_threadsafe(
                    queue.put_nowait,
                    ("event", serialize_event(change.document.to_dict())),
                )

    async def body():
        last_seq = after
        for event in await events_after(run_id, after):
            last_seq = max(last_seq, event["seq"])
            yield sse("event", event, event["seq"])
        run_watch = run_ref.on_snapshot(on_run)
        events_watch = (
            run_ref.collection("events")
            .where(filter=firestore.FieldFilter("seq", ">", last_seq))
            .on_snapshot(on_events)
        )
        try:
            while not await request.is_disconnected():
                try:
                    kind, payload = await asyncio.wait_for(
                        queue.get(), timeout=HEARTBEAT_SECONDS
                    )
                except asyncio.TimeoutError:
                    yield ": heartbeat\n\n"
                    continue
                if kind == "event":
                    if payload["seq"] is None or payload["seq"] <= last_seq:
                        continue
                    last_seq = payload["seq"]
                    yield sse("event", payload, payload["seq"])
                else:
                    yield sse("run", payload)
        finally:
            run_watch.unsubscribe()
            events_watch.unsubscribe()

    return StreamingResponse(
        body(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class Decision(BaseModel):
    decision: Literal["approve", "deny"]
    reason: str | None = Field(default=None, max_length=2000)


def start_stage_job(run_id: str, stage: str) -> str | None:
    """Starts the Cloud Run Job for a stage. Returns an error message if it could not start."""
    name = f"projects/{PROJECT}/locations/{REGION}/jobs/{STAGE_JOBS[stage]}"
    overrides = run_v2.RunJobRequest.Overrides(
        container_overrides=[
            run_v2.RunJobRequest.Overrides.ContainerOverride(
                env=[
                    run_v2.EnvVar(name="RUN_ID", value=run_id),
                    run_v2.EnvVar(name="STAGE", value=stage),
                ]
            )
        ]
    )
    try:
        run_v2.JobsClient().run_job(
            request=run_v2.RunJobRequest(name=name, overrides=overrides)
        )
    except Exception as err:  # noqa: BLE001 - surfaced to the run log, never raised to the approver
        return f"Could not start {STAGE_JOBS[stage]}: {err.__class__.__name__}"
    return None


def require_approver(x_requested_with: str | None, x_approver_key: str | None) -> str:
    if x_requested_with != "vibe2prod":
        raise HTTPException(status_code=403, detail="Missing request header")
    user = approver_for(x_approver_key)
    if not user:
        raise HTTPException(status_code=403, detail="Approver key not recognized")
    return user


@app.post("/api/projects/{project_id}/runs", status_code=201)
async def start_run(
    project_id: str,
    x_requested_with: str | None = Header(default=None),
    x_approver_key: str | None = Header(default=None),
):
    user = require_approver(x_requested_with, x_approver_key)
    project_ref = db.collection("projects").document(project_id)
    active_query = db.collection("runs").where(
        filter=firestore.And(
            [
                firestore.FieldFilter("project_id", "==", project_id),
                firestore.FieldFilter("status", "in", ["running", "awaiting_approval"]),
            ]
        )
    )
    now = datetime.now(timezone.utc)

    @firestore.async_transactional
    async def create(transaction) -> str:
        snapshot = await project_ref.get(transaction=transaction)
        if not snapshot.exists:
            raise HTTPException(status_code=404, detail="Project not found")
        async for _ in await transaction.get(active_query):
            raise HTTPException(status_code=409, detail="A run is already in progress")
        project = snapshot.to_dict()
        number = project.get("run_count", 0) + 1
        run_id = f"{project_id}-{number}"
        transaction.update(project_ref, {"run_count": number})
        transaction.set(
            db.collection("runs").document(run_id),
            {
                "project_id": project_id,
                "number": number,
                "project": project.get("target_project", PROJECT),
                "app": {
                    "repo": project.get("repo"),
                    "branch": project.get("branch", "main"),
                    "commit": None,
                    "url": project.get("repo_url"),
                    "path": project.get("path", "."),
                },
                "status": "running",
                "current_stage": STAGE_KEYS[0],
                "created_at": now,
                "updated_at": now,
                "started_by": user,
                "stages": {STAGE_KEYS[0]: {"status": "running", "started_at": now}},
                "score": None,
            },
        )
        return run_id

    run_id = await create(db.transaction())
    error = await asyncio.to_thread(start_stage_job, run_id, STAGE_KEYS[0])
    if error:
        await (
            db.collection("runs")
            .document(run_id)
            .update(
                {
                    "status": "failed",
                    "current_stage": None,
                    f"stages.{STAGE_KEYS[0]}.status": "failed",
                    f"stages.{STAGE_KEYS[0]}.ended_at": datetime.now(timezone.utc),
                    f"stages.{STAGE_KEYS[0]}.summary": error,
                    "updated_at": datetime.now(timezone.utc),
                }
            )
        )
        await append_event(run_id, STAGE_KEYS[0], "error", "dashboard", error)
        raise HTTPException(status_code=502, detail=error)
    return await load_run(run_id)


@app.post("/api/runs/{run_id}/stages/{stage}/decision")
async def decide(
    run_id: str,
    stage: str,
    body: Decision,
    x_requested_with: str | None = Header(default=None),
    x_approver_key: str | None = Header(default=None),
):
    user = require_approver(x_requested_with, x_approver_key)
    if stage not in STAGE_KEYS:
        raise HTTPException(status_code=400, detail="Unknown stage")
    reason = (body.reason or "").strip() or None
    if body.decision == "deny" and not reason:
        raise HTTPException(
            status_code=400, detail="A reason is required to deny a stage"
        )

    run_ref = db.collection("runs").document(run_id)
    now = datetime.now(timezone.utc)
    index = STAGE_KEYS.index(stage)
    next_stage = STAGE_KEYS[index + 1] if index + 1 < len(STAGE_KEYS) else None

    @firestore.async_transactional
    async def apply(transaction) -> dict:
        snapshot = await run_ref.get(transaction=transaction)
        if not snapshot.exists:
            raise HTTPException(status_code=404, detail="Run not found")
        doc = snapshot.to_dict()
        current = doc.get("stages", {}).get(stage, {})
        if current.get("decision"):
            prior = current["decision"]
            raise HTTPException(
                status_code=409,
                detail=f"Already decided by {prior['by']} at {iso(prior['at'])}",
            )
        if current.get("status") != "awaiting_approval":
            raise HTTPException(
                status_code=409, detail="This stage is not waiting for approval"
            )

        record = {"decision": body.decision, "by": user, "at": now, "reason": reason}
        updates: dict[str, Any] = {
            f"stages.{stage}.decision": record,
            f"stages.{stage}.status": "approved"
            if body.decision == "approve"
            else "denied",
            "updated_at": now,
        }
        if body.decision == "deny":
            updates["status"] = "denied"
            updates["current_stage"] = None
            for later in STAGE_KEYS[index + 1 :]:
                updates[f"stages.{later}.status"] = "skipped"
        elif next_stage:
            updates["status"] = "running"
            updates["current_stage"] = next_stage
            updates[f"stages.{next_stage}.status"] = "running"
            updates[f"stages.{next_stage}.started_at"] = now
        else:
            updates["status"] = "succeeded"
            updates["current_stage"] = None
        transaction.update(run_ref, updates)
        transaction.set(
            run_ref.collection("decisions").document(), {"stage": stage, **record}
        )
        return doc

    await apply(db.transaction())

    if body.decision == "approve" and next_stage:
        error = await asyncio.to_thread(start_stage_job, run_id, next_stage)
        if error:
            await append_event(run_id, next_stage, "error", "dashboard", error)
    return await load_run(run_id)


async def append_event(
    run_id: str, stage: str, kind: str, author: str, text: str
) -> None:
    events = db.collection("runs").document(run_id).collection("events")
    latest = [
        s
        async for s in events.order_by("seq", direction=firestore.Query.DESCENDING)
        .limit(1)
        .stream()
    ]
    seq = (latest[0].to_dict()["seq"] + 1) if latest else 0
    await events.document(f"{seq:08d}").set(
        {
            "seq": seq,
            "stage": stage,
            "kind": kind,
            "author": author,
            "text": text,
            "data": None,
            "ts": datetime.now(timezone.utc),
        }
    )


@app.exception_handler(HTTPException)
async def http_error(_request: Request, exc: HTTPException):
    return JSONResponse(status_code=exc.status_code, content={"detail": exc.detail})


if STATIC_DIR.is_dir():
    app.mount(
        "/assets",
        StaticFiles(directory=STATIC_DIR / "assets", check_dir=False),
        name="assets",
    )

    @app.get("/{path:path}", include_in_schema=False)
    async def spa(path: str):
        if path.startswith("api/"):
            raise HTTPException(status_code=404, detail="Not found")
        candidate = (STATIC_DIR / path).resolve()
        if path and candidate.is_file() and STATIC_DIR.resolve() in candidate.parents:
            return FileResponse(candidate)
        return FileResponse(
            STATIC_DIR / "index.html", headers={"Cache-Control": "no-cache"}
        )
