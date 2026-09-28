import json
import re
import subprocess
from collections import Counter

from common import context
from common.events import Emitter, FirestoreEventsPlugin
from common.guardrails import GuardrailPlugin, safe_path
from common.model import gemini, thinking
from common.repo import Repo, github_token
from common.stage import env_int, guarded, run_workflow, set_stage
from google.adk import Agent, Event, Workflow
from pydantic import BaseModel, Field

from . import scanners

MAX_FILE_BYTES = 200_000
MAX_FINDINGS_IN_PROMPT = 80
SEVERITY_ORDER = {"CRITICAL": 0, "ERROR": 1, "HIGH": 1, "WARNING": 2, "MEDIUM": 2}


class FixedIssue(BaseModel):
    title: str
    severity: str
    files: list[str]
    change: str = Field(description="What was changed and why it removes the risk.")


class RemainingIssue(BaseModel):
    title: str
    reason: str = Field(
        description="Why it was not fixed in code (needs infra, a human decision, or a false positive)."
    )


class FixReport(BaseModel):
    summary: str = Field(description="Two or three sentences for the human approver.")
    fixed: list[FixedIssue]
    remaining: list[RemainingIssue]


INSTRUCTION = """You are CodeGuard, a security engineer hardening an AI-generated web app before it goes to production on Google Cloud.

The app is in the current folder. Scanner findings are below. Fix the real security problems in code:
- Remove hardcoded secrets and committed .env files. Read secrets from environment variables on the server only; never ship keys to the browser.
- Move any client-side calls that need an API key behind a server endpoint.
- Fix injection (command, path traversal, XSS), add input validation, restrict CORS, stop leaking stack traces, listen on process.env.PORT.
- Send standard security headers (e.g. helmet for Express) and stop advertising the framework (X-Powered-By).
- Upgrade vulnerable dependencies in package.json to the version latest_version returns (never downgrade), adapt code to breaking changes, then call update_lockfile.
- Harden the Dockerfile (pinned slim base image, non-root user, npm ci, no secrets copied).
Scanners miss things: read every source file and also fix security problems they did not report.
Keep changes minimal and keep the app working. Do not add features. Leave infrastructure (databases, auth providers, secret storage) to later stages and list it under remaining.
After editing, call rescan once and fix anything new you introduced. Then return the FixReport.

Scanner findings ({finding_count} total):
{findings}
"""


def build(run: context.RunContext, client, emitter: Emitter, repo: Repo):
    root = run.app_dir

    def list_files(path: str = ".") -> dict:
        """List files under a folder of the app, skipping node_modules, dist and .git.

        Args:
          path: Folder relative to the app root.
        """
        base = safe_path(root, path)
        files = [
            str(p.relative_to(root))
            for p in sorted(base.rglob("*"))
            if p.is_file()
            and not scanners.SKIP_DIRS.intersection(p.relative_to(root).parts)
        ]
        return {"files": files[:500]}

    def read_file(path: str) -> dict:
        """Read a text file of the app.

        Args:
          path: File path relative to the app root.
        """
        target = safe_path(root, path)
        if target.stat().st_size > MAX_FILE_BYTES:
            return {"error": "file too large to read"}
        return {"path": path, "content": target.read_text()}

    def write_file(path: str, content: str) -> dict:
        """Create or overwrite a text file of the app with the full new content.

        Args:
          path: File path relative to the app root.
          content: Complete new file content.
        """
        target = safe_path(root, path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return {"path": path, "bytes": len(content.encode())}

    def delete_file(path: str) -> dict:
        """Delete a file of the app, for example a committed .env file.

        Args:
          path: File path relative to the app root.
        """
        target = safe_path(root, path)
        target.unlink()
        return {"deleted": path}

    def update_lockfile() -> dict:
        """Regenerate package-lock.json after changing dependency versions in package.json."""
        proc = subprocess.run(
            [
                "npm",
                "install",
                "--package-lock-only",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
            ],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )
        return {
            "exit_code": proc.returncode,
            "output": (proc.stdout + proc.stderr)[-1500:],
        }

    def latest_version(package: str) -> dict:
        """Return the latest published version of an npm package.

        Args:
          package: npm package name, for example multer.
        """
        if not re.fullmatch(r"(@[a-z0-9._-]+/)?[a-z0-9._-]+", package):
            return {"error": "invalid package name"}
        proc = subprocess.run(
            ["npm", "view", package, "version"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
            timeout=60,
        )
        if proc.returncode != 0:
            return {"error": proc.stderr[-300:]}
        return {"package": package, "latest": proc.stdout.strip()}

    def rescan() -> dict:
        """Run all scanners again and return the remaining findings."""
        results = scanners.scan_all(root)
        flat = [f for items in results.values() for f in items]
        return {"total": len(flat), "findings": flat[:MAX_FINDINGS_IN_PROMPT]}

    tools = [
        list_files,
        read_file,
        write_file,
        delete_file,
        latest_version,
        update_lockfile,
        rescan,
    ]

    async def checkout():
        await emitter.safe_emit(
            "status", "codeguard", f"Cloning {run.repo} ({run.base_branch})"
        )
        commit = repo.checkout()
        await (
            client.collection("runs")
            .document(run.run_id)
            .update({"app.commit": commit})
        )
        await emitter.safe_emit(
            "status", "codeguard", f"Checked out {commit[:7]} on branch {run.branch}"
        )
        return Event(state={"commit": commit})

    async def scan():
        results = {}
        for name, fn in scanners.SCANNERS.items():
            await emitter.safe_emit(
                "tool_call", "codeguard", name, {"args": {"path": run.app_path}}
            )
            results[name] = fn(root)
            await emitter.safe_emit(
                "tool_result",
                "codeguard",
                name,
                {
                    "result": {
                        "findings": len(results[name]),
                        "sample": results[name][:5],
                    }
                },
            )
        flat = [f for items in results.values() for f in items]
        flat.sort(key=lambda f: SEVERITY_ORDER.get(f["severity"], 3))
        await emitter.safe_emit(
            "output",
            "codeguard",
            f"{len(flat)} findings: "
            + ", ".join(
                f"{n} {k}" for k, n in Counter(f["tool"] for f in flat).items()
            ),
        )
        return Event(
            state={
                "before": {k: len(v) for k, v in results.items()},
                "finding_count": len(flat),
                "findings": json.dumps(flat[:MAX_FINDINGS_IN_PROMPT], indent=1),
            }
        )

    fixer = Agent(
        name="fixer",
        model=gemini(),
        planner=thinking(),
        instruction=INSTRUCTION,
        tools=tools,
        output_schema=FixReport,
        output_key="fix_report",
    )

    async def verify():
        results = scanners.scan_all(root)
        after = {k: len(v) for k, v in results.items()}
        await emitter.safe_emit(
            "output",
            "codeguard",
            f"Findings after fixes: {sum(after.values())}",
            {"after": after},
        )
        return Event(state={"after": after})

    async def open_pr(fix_report: dict, before: dict, after: dict):
        changed = repo.changed_files()
        if not changed:
            await emitter.safe_emit(
                "output", "codeguard", "No code changes were needed"
            )
            return Event(state={"pr": None})
        body = _pr_body(fix_report, before, after)
        repo.commit_and_push(f"CodeGuard: security fixes for run {run.run_id}")
        pr = repo.open_pr(f"CodeGuard: {len(fix_report['fixed'])} security fixes", body)
        await emitter.safe_emit(
            "output", "codeguard", f"Opened PR #{pr['number']}", {"url": pr["url"]}
        )
        return Event(state={"pr": pr})

    async def finish(fix_report: dict, pr: dict | None, before: dict, after: dict):
        artifacts = []
        if pr:
            artifacts.append(
                {
                    "kind": "pr",
                    "title": f"CodeGuard: {len(fix_report['fixed'])} security fixes",
                    "url": pr["url"],
                    "meta": {
                        k: pr[k]
                        for k in (
                            "number",
                            "additions",
                            "deletions",
                            "changed_files",
                            "state",
                        )
                    },
                }
            )
        summary = (
            f"{fix_report['summary']} Findings {sum(before.values())} -> {sum(after.values())}; "
            f"{len(fix_report['remaining'])} left for later stages."
        )
        await set_stage(
            client,
            run,
            "awaiting_approval",
            summary=summary,
            artifacts=artifacts,
            result={
                "before": before,
                "after": after,
                "fixed": fix_report["fixed"],
                "remaining": fix_report["remaining"],
                "pr_number": pr["number"] if pr else None,
            },
        )
        await emitter.safe_emit("status", "codeguard", "Waiting for approval")

    return Workflow(
        name="codeguard",
        edges=[("START", checkout, scan, fixer, verify, open_pr, finish)],
    ), {t.__name__ for t in tools}


def _pr_body(report: dict, before: dict, after: dict) -> str:
    lines = [report["summary"], "", "## Fixed"]
    lines += [
        f"- **{i['title']}** ({i['severity']}): {i['change']} `{', '.join(i['files'])}`"
        for i in report["fixed"]
    ]
    if report["remaining"]:
        lines += ["", "## Left for later stages"]
        lines += [f"- **{i['title']}**: {i['reason']}" for i in report["remaining"]]
    lines += [
        "",
        "## Scanner findings",
        "",
        "| Scanner | Before | After |",
        "|---|---|---|",
    ]
    lines += [f"| {k} | {before.get(k, 0)} | {after.get(k, 0)} |" for k in before]
    lines += [
        "",
        "Opened by the Vibe2Prod CodeGuard agent. A human approves before the next stage.",
    ]
    return "\n".join(lines)


async def main() -> int:
    client = context.db()
    run = await context.load(client)
    emitter = Emitter(client, run)

    async def body():
        repo = Repo(run, github_token(run.project))
        workflow, tool_names = build(run, client, emitter, repo)
        plugins = [
            GuardrailPlugin(tool_names, run.app_dir, emitter),
            FirestoreEventsPlugin(emitter),
        ]
        await run_workflow(
            workflow,
            run,
            plugins,
            prompt="Harden the app.",
            state={},
            max_llm_calls=env_int("MAX_LLM_CALLS", 150),
            timeout_s=env_int("STAGE_TIMEOUT_S", 1800),
        )

    return await guarded(client, run, emitter, body)
