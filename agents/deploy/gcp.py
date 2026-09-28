import io
import os
import tarfile
import time
from pathlib import Path

import google.auth
from google.auth.transport.requests import AuthorizedSession

REGION = os.environ.get("DEPLOY_REGION", "us-central1")
SOURCE_BUCKET = os.environ.get("BUILD_SOURCE_BUCKET", "vibe2prod-509620_cloudbuild")
AR_REPO = os.environ.get("AR_REPO", "vibe2prod")
BUILD_SA = os.environ.get(
    "BUILD_SA", "vibe2prod-app-build@vibe2prod-509620.iam.gserviceaccount.com"
)
SKIP_DIRS = {".git", "node_modules", "dist", ".terraform"}
BUILD_DONE = {"SUCCESS", "FAILURE", "INTERNAL_ERROR", "TIMEOUT", "CANCELLED", "EXPIRED"}


class ApiError(RuntimeError):
    pass


class Gcp:
    """Google REST calls as this job's identity; Agent Identity tokens need the *.mtls hosts."""

    def __init__(self, project: str):
        self.project = project
        self.creds, _ = google.auth.default(
            scopes=["https://www.googleapis.com/auth/cloud-platform"]
        )
        self.session = AuthorizedSession(self.creds)
        self.session.configure_mtls_channel()

    def _url(self, service: str, path: str) -> str:
        host = (
            f"{service}.mtls.googleapis.com"
            if self.session.is_mtls
            else f"{service}.googleapis.com"
        )
        return f"https://{host}{path}"

    def call(self, method: str, service: str, path: str, **kwargs) -> dict:
        resp = self.session.request(
            method, self._url(service, path), timeout=60, **kwargs
        )
        if resp.status_code >= 400:
            raise ApiError(
                f"{method} {service}{path.split('?')[0]} -> {resp.status_code}: {resp.text[:500]}"
            )
        return resp.json() if resp.content else {}

    def upload_source(self, root: Path, object_name: str) -> None:
        data = _tarball(root)
        self.call(
            "POST",
            "storage",
            f"/upload/storage/v1/b/{SOURCE_BUCKET}/o",
            params={"uploadType": "media", "name": object_name},
            data=data,
            headers={"Content-Type": "application/gzip"},
        )

    def create_build(self, object_name: str, image: str, run_id: str) -> str:
        body = {
            "source": {
                "storageSource": {"bucket": SOURCE_BUCKET, "object": object_name}
            },
            "steps": [
                {
                    "name": "gcr.io/cloud-builders/docker",
                    "args": ["build", "-t", image, "."],
                }
            ],
            "images": [image],
            "serviceAccount": f"projects/{self.project}/serviceAccounts/{BUILD_SA}",
            # A user-specified build SA requires an explicit logging mode.
            "options": {"logging": "CLOUD_LOGGING_ONLY"},
            "timeout": "1200s",
            "tags": ["vibe2prod", f"v2p-run-{run_id}"[:128]],
        }
        op = self.call(
            "POST",
            "cloudbuild",
            f"/v1/projects/{self.project}/locations/{REGION}/builds",
            json=body,
        )
        return op["metadata"]["build"]["id"]

    def get_build(self, build_id: str) -> dict:
        return self.call(
            "GET",
            "cloudbuild",
            f"/v1/projects/{self.project}/locations/{REGION}/builds/{build_id}",
        )

    def service(self, name: str) -> dict:
        return self.call(
            "GET",
            "run",
            f"/v2/projects/{self.project}/locations/{REGION}/services/{name}",
        )

    def service_iam(self, name: str) -> dict:
        return self.call(
            "GET",
            "run",
            f"/v2/projects/{self.project}/locations/{REGION}/services/{name}:getIamPolicy",
        )

    def secret_exists(self, secret: str) -> bool:
        path = (
            secret
            if secret.startswith("projects/")
            else f"projects/{self.project}/secrets/{secret}"
        )
        try:
            self.call("GET", "secretmanager", f"/v1/{path}")
            return True
        except ApiError as err:
            if "-> 404" in str(err):
                return False
            raise

    def recent_logs(
        self, service_name: str, since_rfc3339: str, limit: int = 5
    ) -> list[dict]:
        body = {
            "resourceNames": [f"projects/{self.project}"],
            "filter": (
                'resource.type="cloud_run_revision" '
                f'AND resource.labels.service_name="{service_name}" '
                f'AND timestamp>="{since_rfc3339}"'
            ),
            "orderBy": "timestamp desc",
            "pageSize": limit,
        }
        return self.call("POST", "logging", "/v2/entries:list", json=body).get(
            "entries", []
        )


def _tarball(root: Path) -> bytes:
    def keep(info: tarfile.TarInfo) -> tarfile.TarInfo | None:
        return None if SKIP_DIRS.intersection(Path(info.name).parts) else info

    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w:gz") as tar:
        for child in sorted(root.iterdir()):
            tar.add(child, arcname=child.name, filter=keep)
    return buf.getvalue()


def rfc3339(ts: float) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(ts))
