import os
from dataclasses import dataclass
from pathlib import Path

from google.cloud import firestore

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

    @property
    def branch(self) -> str:
        return f"v2p/run-{self.run_id}"

    @property
    def app_dir(self) -> Path:
        return (self.workdir / self.app_path).resolve()


def db() -> firestore.AsyncClient:
    return firestore.AsyncClient(project=PROJECT)


async def load(client: firestore.AsyncClient) -> RunContext:
    run_id, stage = os.environ["RUN_ID"], os.environ["STAGE"]
    snapshot = await client.collection("runs").document(run_id).get()
    if not snapshot.exists:
        raise RuntimeError(f"Run {run_id} not found")
    app = snapshot.to_dict().get("app", {})
    return RunContext(
        run_id=run_id,
        stage=stage,
        project=PROJECT,
        repo=app["repo"],
        base_branch=app.get("branch", "main"),
        commit=app.get("commit"),
        app_path=app.get("path", "."),
        workdir=WORKDIR / run_id,
    )
