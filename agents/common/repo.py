import base64
import os
import subprocess
import time
from pathlib import Path

import google.auth
import google.auth.transport.requests
import requests
from google.auth import crypt, jwt

from .context import RunContext

GITHUB_API = "https://api.github.com"
APP_CLIENT_ID = os.environ.get("GITHUB_APP_CLIENT_ID", "Iv23li6wJsHm9yHUg14w")
APP_KEY_SECRET = os.environ.get("GITHUB_APP_KEY_SECRET", "github-app-private-key")
BOT_NAME = "vibe2prod-agent[bot]"
BOT_EMAIL = "337132811+vibe2prod-agent[bot]@users.noreply.github.com"
TOKEN_MAX_AGE_S = 45 * 60


def read_secret(project: str, name: str) -> str:
    """Reads a secret as this job's own identity (mTLS when on Cloud Run)."""
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
        f"https://{host}/v1/projects/{project}/secrets/{name}/versions/latest:access",
        timeout=30,
    )
    resp.raise_for_status()
    return base64.b64decode(resp.json()["payload"]["data"]).decode().strip()


class GitHubApp:
    """Installation tokens for one repo, minted as the vibe2prod-agent GitHub App."""

    def __init__(self, project: str, repo: str):
        self._signer = crypt.RSASigner.from_string(read_secret(project, APP_KEY_SECRET))
        self._repo = repo
        self._token = ""
        self._minted = 0.0

    def _jwt_headers(self) -> dict:
        now = int(time.time())
        assertion = jwt.encode(
            self._signer, {"iat": now - 60, "exp": now + 540, "iss": APP_CLIENT_ID}
        ).decode()
        return {
            "Authorization": f"Bearer {assertion}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    def token(self) -> str:
        # Tokens live one hour; stages can run close to two, so re-mint before expiry.
        if time.time() - self._minted < TOKEN_MAX_AGE_S:
            return self._token
        headers = self._jwt_headers()
        resp = requests.get(
            f"{GITHUB_API}/repos/{self._repo}/installation", headers=headers, timeout=30
        )
        if resp.status_code == 404:
            raise RuntimeError(f"GitHub App is not installed on {self._repo}")
        resp.raise_for_status()
        resp = requests.post(
            f"{GITHUB_API}/app/installations/{resp.json()['id']}/access_tokens",
            headers=headers,
            json={"repositories": [self._repo.split("/")[1]]},
            timeout=30,
        )
        resp.raise_for_status()
        self._token = resp.json()["token"]
        self._minted = time.time()
        return self._token


class Repo:
    """Git and GitHub operations; the token is passed per command and never written to disk."""

    def __init__(self, run: RunContext):
        self.run = run
        self._app = GitHubApp(run.project, run.repo)
        self._app.token()

    def _git(self, *args: str, cwd: Path | None = None, auth: bool = False) -> str:
        cmd = ["git", *args]
        token = self._app.token() if auth else ""
        if auth:
            basic = base64.b64encode(f"x-access-token:{token}".encode()).decode()
            cmd[1:1] = ["-c", f"http.extraHeader=Authorization: Basic {basic}"]
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
            stderr = proc.stderr.replace(token, "***") if token else proc.stderr
            raise RuntimeError(f"git {args[0]} failed: {stderr[-500:]}")
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
            "Authorization": f"Bearer {self._app.token()}",
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

    def set_pr_section(self, number: int, marker: str, markdown: str) -> dict:
        """Replaces the PR body section between <!-- marker:start/end --> comments, or appends it."""
        url = f"{GITHUB_API}/repos/{self.run.repo}/pulls/{number}"
        resp = requests.get(url, headers=self._headers(), timeout=30)
        resp.raise_for_status()
        body = resp.json().get("body") or ""
        start, end = f"<!-- {marker}:start -->", f"<!-- {marker}:end -->"
        section = f"{start}\n{markdown}\n{end}"
        if start in body and end in body:
            body = (
                body[: body.index(start)] + section + body[body.index(end) + len(end) :]
            )
        else:
            body = f"{body}\n\n{section}" if body else section
        resp = requests.patch(
            url, headers=self._headers(), json={"body": body}, timeout=30
        )
        resp.raise_for_status()
        return self._pr_info(number)
