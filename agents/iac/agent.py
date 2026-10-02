import json
import posixpath
import re
import subprocess
import tempfile
from pathlib import Path

from common import context
from common.events import Emitter, FirestoreEventsPlugin
from common.guardrails import GuardrailPlugin, PathNotAllowed, safe_path
from common.model import gemini, thinking
from common.npm import latest_version
from common.repo import Repo
from common.stage import env_int, guarded, run_workflow, set_stage
from google.adk import Agent, Event, Workflow
from pydantic import BaseModel, Field

from . import pricing, terraform

REGION = "us-central1"
MAX_ROUNDS = 3
MAX_FILE_BYTES = 200_000
MAX_DESIGN_MD = 40_000
SKIP_DIRS = {"node_modules", "dist", "build", ".git", ".terraform", "coverage"}
TF_FILE = re.compile(r"infra/[a-z0-9_]+\.tf")
PINNED = {"infra/versions.tf"}
NODE_CHECK = {".js", ".mjs", ".cjs"}


class AppliedChange(BaseModel):
    file: str = Field(description="Path relative to the app root.")
    change: str = Field(description="What was changed in this file.")


class TerraformReport(BaseModel):
    summary: str = Field(description="Two or three sentences for the human approver.")
    deviations: list[str] = Field(
        description="Where the Terraform or code differs from the design doc and why; empty if none."
    )
    code_changes_applied: list[AppliedChange] = Field(
        description="App code edits made for the design's code_changes; empty if none were listed."
    )


INSTRUCTION = """You are the Terraform engineer of Vibe2Prod. Turn the approved design doc in the user message into complete, self-contained Terraform for this app. The deploy stage runs terraform apply from infra/ without any edits, so the stack must work on the first apply.

Files: write infra/main.tf, infra/variables.tf and infra/outputs.tf (add more infra/*.tf files only if it helps readability). infra/versions.tf is written by the platform (backend, provider pins, provider project/region, default labels, and the locals local.project, local.region, local.name, local.runtime_sa, local.run_label); read it, use its locals, never redefine them, and do not add terraform, backend or provider blocks.

Rules:
- Create every resource in the design doc's resources list and every IAM binding in its iam list, using the google provider 8.x resource types it names. Nothing else, except the two observability resources below.
- Observability (always, even if the design doc omits them): (1) google_logging_metric with name "${local.name}-errors", filter resource.type="cloud_run_revision" AND resource.labels.service_name=<the Cloud Run service name> AND severity>=ERROR, metric_descriptor metric_kind DELTA, value_type INT64. (2) google_monitoring_alert_policy with display_name "${local.name} 5xx responses", combiner OR, no notification_channels, one condition_threshold whose filter is resource.type = "cloud_run_revision" AND resource.labels.service_name = <the service name> AND metric.type = "run.googleapis.com/request_count" AND metric.labels.response_code_class = "5xx", comparison COMPARISON_GT, threshold_value 5, duration "0s", aggregations alignment_period "300s", per_series_aligner ALIGN_SUM, cross_series_reducer REDUCE_SUM. Reference the service name from the Cloud Run resource, not a literal.
- Names: Cloud Run service, Firestore database id and secret ids start with local.name. The bucket name is local.name followed by a hyphen and local.project, because bucket names are global.
- Labels come from the provider default_labels; do not repeat them.
- variable "image" (string, no default): the container image URL, set by the deploy stage. The Cloud Run container image must be var.image.
- output "service_url" = the Cloud Run service uri. Add outputs for other resource names the deploy stage may need.
- Cloud Run: exactly one google_cloud_run_v2_service in local.region, deletion_protection = false, template.service_account = local.runtime_sa (a shared runtime service account the platform owns; never create a service account), the design's cpu, memory, scaling, concurrency, timeout, port and probes. For a public app set invoker_iam_disabled = true and ingress INGRESS_TRAFFIC_ALL. Never grant allUsers or allAuthenticatedUsers anything. Set the port with ports.container_port only; never set env PORT, K_SERVICE, K_REVISION or K_CONFIGURATION (Cloud Run reserves them). Health endpoints and probe paths use /health; Cloud Run reserves URL paths ending in z (e.g. /healthz).
- Secret-backed env vars use value_source.secret_key_ref with version "latest". Every secret must get a google_secret_manager_secret_version so the service starts on the first apply; app-internal tokens use random_password (special = false) as secret_data. Add depends_on from the service to the secret versions and secret IAM grants.
- IAM: only additive *_iam_member resources. Every grant goes to member "serviceAccount:${local.runtime_sa}". Resource-level grants on the bucket and secrets. roles/aiplatform.user is already granted by the platform; do not add it. Project-level google_project_iam_member only for roles/datastore.user, with a condition block whose expression is resource.name == "projects/<project>/databases/<database id>" built from local.project and the database resource.
- Firestore: google_firestore_database with name = local.name, type FIRESTORE_NATIVE, location_id local.region, deletion_policy = "DELETE", delete_protection_state = "DELETE_PROTECTION_DISABLED". Never touch the (default) database.
- Cloud Storage: uniform_bucket_level_access = true, public_access_prevention = "enforced", force_destroy = true, location upper(local.region).
- Forbidden: google_service_account and any IAM on service accounts, data sources, modules, provisioners, import blocks, google_project_service, authoritative IAM (_iam_policy, _iam_binding), billing budgets, references to any resource this stack does not create.

App code: if the design doc lists code_changes, implement exactly those in the app source so the app works on this infrastructure, reading the env var names the Terraform sets. Keep edits minimal and keep existing behavior and security fixes; no refactors, no new features, no Dockerfile base-image changes. If a change needs a new npm dependency, call latest_version and add it to package.json as a caret range of that version, then call update_lockfile. Never remove a dependency the code still uses. If code_changes is empty or absent, do not edit any app file. Gemini calls in app code use model gemini-3.8-flash with location global; never another model id.

Work: read infra/versions.tf and the app files you need, write the files, then call run_validate. It formats the Terraform, runs terraform validate and plan, applies the platform policy checks, and syntax-checks changed JavaScript. Fix every error it reports and call it again until it returns ok. Then return the TerraformReport."""


def build(run: context.RunContext, client, emitter: Emitter, repo: Repo):
    root = run.app_dir
    infra = root / "infra"
    infra_rel = posixpath.normpath(posixpath.join(run.app_path, "infra"))
    plan_path = Path(tempfile.gettempdir()) / f"{run.run_id}-plan.json"

    def _walk(base: Path) -> list[Path]:
        return [
            p
            for p in sorted(base.rglob("*"))
            if p.is_file() and not SKIP_DIRS.intersection(p.relative_to(root).parts)
        ]

    code_allowed = {"on": False}
    app_prefix = (
        "" if run.app_path in ("", ".") else posixpath.normpath(run.app_path) + "/"
    )

    def _rel(path: str) -> str:
        """Tool paths are relative to the app root; a leading app_path/ from the model is tolerated."""
        rel = posixpath.normpath(path or ".").lstrip("/")
        if app_prefix and (rel + "/").startswith(app_prefix):
            rel = posixpath.normpath(rel[len(app_prefix) :] or ".")
        return rel

    def _app_rel(repo_rel: str) -> str:
        repo_rel = repo_rel.strip('"')
        return repo_rel.removeprefix(app_prefix)

    def _target(path: str) -> Path:
        rel = _rel(path)
        if rel.startswith("infra/") or rel == "infra":
            if (
                not TF_FILE.fullmatch(rel)
                or rel in PINNED
                or rel.endswith("override.tf")
            ):
                raise PathNotAllowed(
                    f"{path}: under infra/ only <name>.tf files other than versions.tf may be written"
                )
        elif not code_allowed["on"]:
            raise PathNotAllowed(
                f"{path}: the design lists no code_changes, so only infra/*.tf may be written"
            )
        elif SKIP_DIRS.intersection(Path(rel).parts) or rel == "package-lock.json":
            raise PathNotAllowed(f"{path}: generated or protected path")
        return safe_path(root, rel)

    def _node_errors() -> list[str]:
        errors = []
        changed = {_app_rel(c) for c in repo.changed_files()}
        for rel in sorted(changed):
            path = root / rel
            if path.suffix in NODE_CHECK and path.is_file():
                proc = subprocess.run(
                    ["node", "--check", str(path)],
                    capture_output=True,
                    text=True,
                    check=False,
                    timeout=60,
                )
                if proc.returncode != 0:
                    errors.append(f"{rel}: {proc.stderr.strip()[-800:]}")
            if (
                path.name == "package.json"
                and (path.parent / "package-lock.json").exists()
            ):
                # Keeps the lockfile in sync deterministically; npm is a no-op when nothing changed.
                proc = _npm_lock(path.parent)
                if proc.returncode != 0:
                    errors.append(
                        f"npm could not update the lockfile for {rel}: "
                        + (proc.stdout + proc.stderr)[-800:]
                    )
        return errors

    def _full_check() -> dict:
        result = terraform.check(infra, run.run_id)
        code = _node_errors()
        if code:
            result = {
                **result,
                "ok": False,
                "step": "code" if result["ok"] else result["step"],
            }
            result["errors"] = result["errors"] + code
        return result

    def list_files(path: str = ".") -> dict:
        """List files under a folder of the app, skipping node_modules, dist and .git.

        Args:
          path: Folder relative to the app root.
        """
        files = [str(p.relative_to(root)) for p in _walk(safe_path(root, _rel(path)))]
        return {"files": files[:500]}

    def read_file(path: str) -> dict:
        """Read a text file of the app, including the Terraform under infra/.

        Args:
          path: File path relative to the app root.
        """
        target = safe_path(root, _rel(path))
        if not target.is_file():
            return {
                "error": f"{_rel(path)} does not exist (paths are relative to the app root)"
            }
        if target.stat().st_size > MAX_FILE_BYTES:
            return {"error": "file too large to read"}
        return {"path": _rel(path), "content": target.read_text(errors="replace")}

    def write_file(path: str, content: str) -> dict:
        """Create or overwrite a file with the full new content: Terraform under infra/, or app source for the design's code_changes.

        Args:
          path: File path relative to the app root, for example infra/main.tf or server.js.
          content: Complete new file content.
        """
        try:
            target = _target(path)
        except PathNotAllowed as err:
            return {"error": str(err)}
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(content)
        return {"path": _rel(path), "bytes": len(content.encode())}

    def delete_file(path: str) -> dict:
        """Delete a Terraform file under infra/ that should not exist.

        Args:
          path: File path relative to the app root, for example infra/extra.tf.
        """
        try:
            if not _rel(path).startswith("infra/"):
                raise PathNotAllowed(f"{path}: only infra/*.tf files may be deleted")
            target = _target(path)
        except PathNotAllowed as err:
            return {"error": str(err)}
        target.unlink(missing_ok=True)
        return {"deleted": _rel(path)}

    def _npm_lock(cwd: Path) -> subprocess.CompletedProcess:
        return subprocess.run(
            [
                "npm",
                "install",
                "--package-lock-only",
                "--ignore-scripts",
                "--no-audit",
                "--no-fund",
            ],
            cwd=cwd,
            capture_output=True,
            text=True,
            check=False,
            timeout=300,
        )

    def update_lockfile() -> dict:
        """Regenerate package-lock.json after adding a dependency to package.json."""
        if not code_allowed["on"]:
            return {"error": "the design lists no code_changes"}
        proc = _npm_lock(root)
        return {
            "exit_code": proc.returncode,
            "output": (proc.stdout + proc.stderr)[-1500:],
        }

    def run_validate() -> dict:
        """Format, validate and plan infra/, run the platform policy checks and syntax-check changed JavaScript. Returns ok or the errors to fix."""
        result = _full_check()
        if not result["ok"]:
            return {"ok": False, "step": result["step"], "errors": result["errors"]}
        return {"ok": True, "plan": terraform.summarize(result["plan"])}

    tools = [
        list_files,
        read_file,
        write_file,
        delete_file,
        latest_version,
        update_lockfile,
        run_validate,
    ]

    async def checkout():
        await emitter.safe_emit(
            "status", "iac", f"Checking out {run.branch} from {run.repo}"
        )
        commit = repo.checkout()
        await emitter.safe_emit("status", "iac", f"At commit {commit[:7]}")
        return Event(state={"commit": commit})

    async def load_design():
        snapshot = await client.collection("runs").document(run.run_id).get()
        stages = (snapshot.to_dict() or {}).get("stages", {})
        design = (stages.get("architect") or {}).get("result")
        if not design:
            raise RuntimeError("No design doc: stages.architect.result is empty")
        code_allowed["on"] = bool(design.get("code_changes"))
        infra.mkdir(parents=True, exist_ok=True)
        versions = terraform.versions_tf(run.run_id, run.project, REGION)
        (infra / "versions.tf").write_text(versions)
        (infra / ".gitignore").write_text(
            ".terraform/\n*.tfstate*\n*.tfplan\ntf.plan\n"
        )
        doc_path = root / "docs" / "DESIGN.md"
        markdown = (
            doc_path.read_text(errors="replace")[:MAX_DESIGN_MD]
            if doc_path.exists()
            else ""
        )
        brief = {
            k: v for k, v in design.items() if k not in ("critic", "rounds", "doc_path")
        }
        files = [str(p.relative_to(root)) for p in _walk(root)]
        parts = [
            "## Design doc (JSON, approved by a human)",
            json.dumps(brief, indent=1),
            "",
            "## Design doc (markdown)",
            markdown or "Not found on the branch.",
            "",
            "## infra/versions.tf (platform-owned, read-only)",
            "```hcl",
            versions,
            "```",
            "",
            "## App file tree",
            *files[:300],
        ]
        brief_text = context.feedback_block(run) + "\n".join(parts)
        await emitter.safe_emit(
            "tool_result",
            "iac",
            "load_design",
            {
                "result": {
                    "resources": len(design.get("resources") or []),
                    "iam": len(design.get("iam") or []),
                    "design_md": bool(markdown),
                }
            },
        )
        return Event(
            output=brief_text,
            state={
                "brief": brief_text,
                "usage": design.get("usage_assumptions") or {},
                "rounds": 0,
                "tf_report": None,
            },
        )

    writer = Agent(
        name="writer",
        model=gemini(),
        planner=thinking(),
        instruction=INSTRUCTION,
        tools=tools,
        output_schema=TerraformReport,
        output_key="tf_report",
    )

    async def validate(rounds: int, brief: str, tf_report: dict | None):
        rounds += 1
        await emitter.safe_emit(
            "tool_call",
            "iac",
            "terraform",
            {"args": {"steps": "fmt, init, validate, plan, policy"}},
        )
        result = _full_check()
        if result["ok"] and not tf_report:
            # An empty model response leaves no report; valid files still need one before finishing.
            result = {
                **result,
                "ok": False,
                "step": "report",
                "errors": [
                    "The files pass all checks, but no TerraformReport was returned. Return it now."
                ],
            }
        if result["ok"]:
            summary = terraform.summarize(result["plan"])
            plan_path.write_text(json.dumps(result["plan"]))
            await emitter.safe_emit(
                "tool_result",
                "iac",
                "terraform",
                {"result": {"ok": True, "plan": summary}},
            )
            await emitter.safe_emit(
                "output",
                "iac",
                f"Plan: {summary['add']} to add, {summary['change']} to change, {summary['destroy']} to destroy",
            )
            return Event(route="ok", state={"rounds": rounds, "plan_summary": summary})
        await emitter.safe_emit(
            "tool_result",
            "iac",
            "terraform",
            {
                "result": {
                    "ok": False,
                    "step": result["step"],
                    "errors": result["errors"],
                }
            },
        )
        if rounds >= MAX_ROUNDS:
            raise RuntimeError(
                f"Terraform still failing after {rounds} rounds at {result['step']}: "
                + "; ".join(result["errors"])[:600]
            )
        revision = "\n".join(
            [
                brief,
                "",
                f"## Terraform check failed at step {result['step']} (fix all of these)",
                *(f"- {e}" for e in result["errors"]),
                "",
                "Read the current files, fix them, and call run_validate until it returns ok; then return the TerraformReport.",
            ]
        )
        return Event(
            output=revision, route="fix", state={"rounds": rounds, "tf_report": None}
        )

    async def price(usage: dict):
        await emitter.safe_emit(
            "tool_call",
            "iac",
            "billing_catalog",
            {"args": {"currency": "USD", "region": REGION}},
        )
        cost = pricing.estimate(json.loads(plan_path.read_text()), usage, REGION)
        await emitter.safe_emit(
            "tool_result",
            "iac",
            "billing_catalog",
            {
                "result": {
                    "monthly_total": cost["monthly_total"],
                    "items": len(cost["items"]),
                }
            },
        )
        await emitter.safe_emit(
            "output", "iac", f"Estimated cost: ${cost['monthly_total']:.2f}/month"
        )
        return Event(state={"cost": cost})

    async def commit():
        changed = [c.strip('"') for c in repo.changed_files()]
        code_files = sorted(
            c for c in changed if not c.startswith(f"{infra_rel}/") and c != infra_rel
        )
        if changed:
            what = "Terraform and app wiring" if code_files else "Terraform"
            repo.commit_and_push(f"IaC: {what} for run {run.run_id}")
            await emitter.safe_emit(
                "output",
                "iac",
                f"Pushed {what.lower()} to {run.branch}",
                {"code_files": code_files},
            )
        return Event(state={"pr": repo.find_pr(), "code_files": code_files})

    async def finish(
        tf_report: dict,
        plan_summary: dict,
        cost: dict,
        pr: dict | None,
        rounds: int,
        code_files: list,
    ):
        files = sorted(
            str(p.relative_to(run.workdir))
            for p in infra.iterdir()
            if p.is_file() and (p.suffix == ".tf" or p.name == ".terraform.lock.hcl")
        )
        contents = [
            {"path": f, "content": (run.workdir / f).read_text()} for f in files
        ]
        artifacts = [
            {
                "kind": "terraform",
                "title": f"Terraform ({plan_summary['add']} resources)",
                "url": f"https://github.com/{run.repo}/tree/{run.branch}/{infra_rel}",
                "meta": {"files": contents},
            },
            {
                "kind": "cost",
                "title": f"Estimated ${cost['monthly_total']:.2f}/month",
                "url": None,
                "meta": cost,
            },
        ]
        if pr:
            artifacts.append(
                {
                    "kind": "pr",
                    "title": f"Vibe2Prod run {run.run_id}",
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
        result = {
            "files": files,
            "plan_summary": plan_summary,
            "cost": cost,
            "image_var": "image",
            "infra_dir": infra_rel,
            "backend": {
                "bucket": terraform.STATE_BUCKET,
                "prefix": f"apps/{run.run_id}",
            },
            "deviations": tf_report.get("deviations") or [],
            "code_changes_applied": tf_report.get("code_changes_applied") or [],
            "code_files": code_files,
        }
        code_note = (
            f" App wiring changed {', '.join(code_files)}." if code_files else ""
        )
        summary = (
            f"{tf_report['summary']}{code_note} Plan: {plan_summary['add']} to add after {rounds} check round(s). "
            f"Estimated ${cost['monthly_total']:.2f}/month at the design's usage assumptions."
        )
        await set_stage(
            client,
            run,
            "awaiting_approval",
            summary=summary,
            artifacts=artifacts,
            result=result,
        )
        await emitter.safe_emit("status", "iac", "Waiting for approval")

    return Workflow(
        name="iac",
        edges=[
            ("START", checkout, load_design, writer, validate),
            (validate, {"fix": writer, "ok": price}),
            (price, commit, finish),
        ],
    ), {t.__name__ for t in tools}


async def main() -> int:
    client = context.db()
    run = await context.load(client)
    emitter = Emitter(client, run)

    async def body():
        repo = Repo(run)
        workflow, tool_names = build(run, client, emitter, repo)
        plugins = [
            GuardrailPlugin(tool_names, run.app_dir, emitter),
            FirestoreEventsPlugin(emitter),
        ]
        await run_workflow(
            workflow,
            run,
            plugins,
            prompt="Write the Terraform and estimate the cost.",
            state={},
            max_llm_calls=env_int("MAX_LLM_CALLS", 500),
            timeout_s=env_int("STAGE_TIMEOUT_S", 7200),
        )

    return await guarded(client, run, emitter, body)
