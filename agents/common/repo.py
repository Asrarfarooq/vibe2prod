import base64
import os
import subprocess
from pathlib import Path

import google.auth
import google.auth.transport.requests
import requests

from .context import RunContext

GITHUB_API = "https://api.github.com"
TOKEN_SECRET = os.environ.get("GITHUB_TOKEN_SECRET", "github-agent-token")
BOT_NAME = "Vibe2Prod"
BOT_EMAIL = "vibe2prod-bot@users.noreply.github.com"


def github_token(project: str) -> str:
    """Reads the GitHub token from Secret Manager as this job's own identity (mTLS when on Cloud Run)."""
    creds, _ = google.auth.default(
        scopes=["https://www.googleapis.com/auth/cloud-platform"]
    )
    session = google.auth.transport.requests.AuthorizedSession(creds)
    session.configure_mtls_channel()
    host = (
        "secretmanager.mtls.googleapis.com"
        if session.is_mtls
        else "secretmanager.googleapis.com"
    )
    resp = session.get(
        f"https://{host}/v1/projects/{project}/secrets/{TOKEN_SECRET}/versions/latest:access",
        timeout=30,
    )
    resp.raise_for_status()
    return base64.b64decode(resp.json()["payload"]["data"]).decode().strip()


class Repo:
    """Git and GitHub operations; the token is passed per command and never written to disk."""

    def __init__(self, run: RunContext, token: str):
        self.run = run
        self._token = token
        basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
        self._auth = ["-c", f"http.extraHeader=Authorization: Basic {basic}"]

    def _git(self, *args: str, cwd: Path | None = None, auth: bool = False) -> str:
        cmd = ["git", *(self._auth if auth else []), *args]
        proc = subprocess.run(
            cmd,
            cwd=cwd or self.run.workdir,
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
            env={**os.environ, "GIT_TERMINAL_PROMPT": "0"},
        )
        if proc.returncode != 0:
            raise RuntimeError(
                f"git {args[0]} failed: {proc.stderr.replace(self._token, '***')[-500:]}"
            )
        return proc.stdout.strip()

    def checkout(self) -> str:
        """Clones the run's base branch at the run's commit and creates the run branch. Returns the commit."""
        self.run.workdir.parent.mkdir(parents=True, exist_ok=True)
        url = f"https://github.com/{self.run.repo}.git"
        self._git(
            "clone",
            "--branch",
            self.run.base_branch,
            url,
            str(self.run.workdir),
            cwd=self.run.workdir.parent,
            auth=True,
        )
        # Later stages continue on the branch an earlier stage pushed, so one PR collects every stage.
        remote = self._git("ls-remote", "--heads", "origin", self.run.branch, auth=True)
        if remote:
            self._git("fetch", "origin", self.run.branch, auth=True)
            self._git("checkout", "-b", self.run.branch, "FETCH_HEAD")
        else:
            if self.run.commit:
                self._git("checkout", self.run.commit)
            self._git("checkout", "-b", self.run.branch)
        return self._git("rev-parse", "HEAD")

    def changed_files(self) -> list[str]:
        out = self._git(
            "ls-files",
            "-z",
            "--modified",
            "--others",
            "--exclude-standard",
            "--",
            self.run.app_path,
        )
        return sorted(set(filter(None, out.split("\0"))))

    def commit_and_push(self, message: str) -> None:
        self._git("add", "--all", "--", self.run.app_path)
        self._git(
            "-c",
            f"user.name={BOT_NAME}",
            "-c",
            f"user.email={BOT_EMAIL}",
            "commit",
            "-m",
            message,
        )
        self._git("push", "origin", f"HEAD:refs/heads/{self.run.branch}", auth=True)

    def _headers(self) -> dict:
        return {
            "Authorization": f"Bearer {self._token}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def _pr_info(self, number: int) -> dict:
        resp = requests.get(
            f"{GITHUB_API}/repos/{self.run.repo}/pulls/{number}",
            headers=self._headers(),
            timeout=30,
        )
        resp.raise_for_status()
        pr = resp.json()
        return {
            "number": number,
            "url": pr["html_url"],
            "additions": pr.get("additions", 0),
            "deletions": pr.get("deletions", 0),
            "changed_files": pr.get("changed_files", 0),
            "state": pr.get("state", "open"),
        }

    def open_pr(self, title: str, body: str) -> dict:
        resp = requests.post(
            f"{GITHUB_API}/repos/{self.run.repo}/pulls",
            headers=self._headers(),
            json={
                "title": title,
                "body": body,
                "head": self.run.branch,
                "base": self.run.base_branch,
            },
            timeout=30,
        )
        resp.raise_for_status()
        return self._pr_info(resp.json()["number"])

    def update_pr(self, number: int, title: str, body: str) -> dict:
        resp = requests.patch(
            f"{GITHUB_API}/repos/{self.run.repo}/pulls/{number}",
            headers=self._headers(),
            json={"title": title, "body": body},
            timeout=30,
        )
        resp.raise_for_status()
        return self._pr_info(number)

    def find_pr(self) -> dict | None:
        """Returns the open PR for the run branch, or None."""
        owner = self.run.repo.split("/")[0]
        resp = requests.get(
            f"{GITHUB_API}/repos/{self.run.repo}/pulls",
            headers=self._headers(),
            params={"head": f"{owner}:{self.run.branch}", "state": "open"},
            timeout=30,
        )
        resp.raise_for_status()
        pulls = resp.json()
        return self._pr_info(pulls[0]["number"]) if pulls else None
