import os
from dataclasses import dataclass
from pathlib import Path

from google.auth.transport import mtls
from google.cloud import firestore
from google.cloud.firestore_v1.services.firestore.async_client import (
    FirestoreAsyncClient,
)
from google.cloud.firestore_v1.services.firestore.transports.grpc_asyncio import (
    FirestoreGrpcAsyncIOTransport,
)

PROJECT = os.environ.get("GOOGLE_CLOUD_PROJECT", "vibe2prod-509620")
WORKDIR = Path(os.environ.get("WORKDIR", "/tmp/work"))


@dataclass(frozen=True)
class RunContext:
    run_id: str
    stage: str
    project: str
    repo: str
    base_branch: str
    commit: str | None
    app_path: str
    workdir: Path
    feedback: str = ""

    @property
    def branch(self) -> str:
        return f"v2p/run-{self.run_id}"

    @property
    def app_dir(self) -> Path:
        return (self.workdir / self.app_path).resolve()


def db() -> firestore.AsyncClient:
    client = firestore.AsyncClient(project=PROJECT)
    if mtls.should_use_client_cert() and mtls.has_default_client_cert_source():
        # The Firestore wrapper always opens a plain TLS channel, which rejects Agent Identity's cert-bound tokens.
        transport = FirestoreGrpcAsyncIOTransport(
            host="firestore.mtls.googleapis.com",
            credentials=client._credentials,
            client_cert_source_for_mtls=mtls.default_client_cert_source(),
        )
        client._transport = transport
        client._firestore_api_internal = FirestoreAsyncClient(transport=transport)
    return client


async def load(client: firestore.AsyncClient) -> RunContext:
    run_id, stage = os.environ["RUN_ID"], os.environ["STAGE"]
    snapshot = await client.collection("runs").document(run_id).get()
    if not snapshot.exists:
        raise RuntimeError(f"Run {run_id} not found")
    doc = snapshot.to_dict()
    app = doc.get("app", {})
    feedback = ((doc.get("stages") or {}).get(stage) or {}).get("feedback") or {}
    return RunContext(
        run_id=run_id,
        stage=stage,
        project=PROJECT,
        repo=app["repo"],
        base_branch=app.get("branch", "main"),
        commit=app.get("commit"),
        app_path=app.get("path", "."),
        workdir=WORKDIR / run_id,
        feedback=feedback.get("text") or "",
    )


def feedback_block(run: RunContext) -> str:
    """Prompt section with the human's feedback on this stage's previous attempt, or ''."""
    if not run.feedback:
        return ""
    return (
        "## Reviewer feedback on the previous attempt of this stage\n"
        "A human sent this stage back with the note below. Address it first; keep everything else that was correct.\n"
        f"{run.feedback}\n\n"
    )
