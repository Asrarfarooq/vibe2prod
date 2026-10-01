import asyncio
import json
import re
import time
from datetime import datetime, timezone
from typing import Literal

from common import context
from common.events import Emitter, FirestoreEventsPlugin
from common.guardrails import GuardrailPlugin
from common.model import gemini, thinking
from common.repo import Repo, github_token
from common.stage import env_int, guarded, run_workflow, set_stage
from google.adk import Agent, Event, Workflow
from pydantic import BaseModel, Field

from . import audit, gate, probe, terraform
from .gcp import AR_REPO, BUILD_DONE, REGION, Gcp, rfc3339

AUTHOR = "deploy"
BUILD_POLL_S = 10
Category = Literal["Security", "Reliability", "Cost", "Observability", "Deploy health"]


class JudgedCheck(BaseModel):
    name: str
    category: Category
    passed: bool
    detail: str = Field(description="One sentence of evidence from the probe data.")


class CategoryNote(BaseModel):
    name: Category
    note: str = Field(description="One short sentence on the main gap or strength.")


class AuditReport(BaseModel):
    summary: str = Field(description="Two sentences for the human approver.")
    markdown: str = Field(
        description="Readiness report in markdown: verdict, failed checks with fixes, what passed."
    )
    notes: list[CategoryNote]
    judged_checks: list[JudgedCheck] = Field(
        description="At most 4 extra checks that need judgment, e.g. stack traces or internal details in the 404 body, permissive CORS."
    )


INSTRUCTION = """You are the production readiness auditor for an app that was just deployed to Cloud Run.

Deterministic checks already ran; do not change their results. Your job:
1. Read the probe evidence (HTTP responses of the live app) and add at most 4 judged_checks for issues that need judgment and are not already covered, such as stack traces, framework versions or file paths in error bodies, permissive CORS headers, or a home page that is not the app. Only report what the evidence shows.
2. Write one note per category (Security, Reliability, Cost, Observability, Deploy health).
3. Write the markdown report: a one-line verdict, a table of failed checks with a concrete fix for each, then a short list of what passed. No marketing language.

Deterministic checks:
{checks_json}

Probe evidence:
{evidence}
"""


def _tail(text: str, n: int = 1500) -> str:
    return text[-n:]


def build(
    run: context.RunContext,
    client,
    emitter: Emitter,
    repo: Repo,
    gcp: Gcp,
    run_doc: dict,
):
    stages = run_doc.get("stages") or {}
    iac = (stages.get("iac") or {}).get("result") or {}
    infra = run.app_dir / "infra"
    store: dict = {}

    async def checkout():
        await emitter.safe_emit("status", AUTHOR, f"Checking out {run.branch}")
        commit = await asyncio.to_thread(repo.checkout)
        await emitter.safe_emit(
            "status", AUTHOR, f"Checked out {commit[:7]} on {run.branch}"
        )
        return Event(state={"commit": commit})

    async def build_image(commit: str):
        image = (
            f"{REGION}-docker.pkg.dev/{run.project}/{AR_REPO}/app-{run.run_id}:{commit}"
        )
        obj = f"deploy/{run.run_id}/{commit}-{int(time.time())}.tgz"
        await emitter.safe_emit(
            "tool_call",
            AUTHOR,
            "cloud_build",
            {"args": {"image": image, "source": obj}},
        )
        await asyncio.to_thread(gcp.upload_source, run.app_dir, obj)
        build_id = await asyncio.to_thread(gcp.create_build, obj, image, run.run_id)
        started = time.monotonic()
        while True:
            info = await asyncio.to_thread(gcp.get_build, build_id)
            if info.get("status") in BUILD_DONE:
                break
            await asyncio.sleep(BUILD_POLL_S)
        seconds = round(time.monotonic() - started)
        result = {
            "build_id": build_id,
            "status": info["status"],
            "seconds": seconds,
            "log_url": info.get("logUrl"),
        }
        await emitter.safe_emit(
            "tool_result", AUTHOR, "cloud_build", {"result": result}
        )
        if info["status"] != "SUCCESS":
            detail = (
                (info.get("failureInfo") or {}).get("detail")
                or info.get("statusDetail")
                or ""
            )
            raise RuntimeError(
                f"Cloud Build {build_id} {info['status']}: {detail} ({info.get('logUrl')})"
            )
        digest = info["results"]["images"][0]["digest"]
        image_ref = f"{image.rsplit(':', 1)[0]}@{digest}"
        await emitter.safe_emit(
            "output", AUTHOR, f"Built {image} in {seconds}s", {"digest": digest}
        )
        return Event(state={"image": image, "image_ref": image_ref})

    async def plan(image_ref: str):
        if not (infra / "main.tf").exists() and not list(infra.glob("*.tf")):
            raise RuntimeError(f"No Terraform found in {run.app_path}/infra")
        var = iac.get("image_var") or "image"
        await emitter.safe_emit(
            "tool_call",
            AUTHOR,
            "terraform_plan",
            {"args": {"dir": f"{run.app_path}/infra", var: image_ref}},
        )
        await asyncio.to_thread(terraform.init, infra, run.run_id)
        plan_json = await asyncio.to_thread(terraform.plan, infra, {var: image_ref})
        store["plan"] = plan_json
        summary = gate.summarize(plan_json)
        await emitter.safe_emit(
            "tool_result", AUTHOR, "terraform_plan", {"result": summary}
        )
        return Event(state={"plan_summary": summary})

    async def gate_plan():
        found = gate.violations(store["plan"], run.run_id, run.project)
        if found:
            await emitter.safe_emit(
                "error",
                "guardrails",
                f"Plan rejected: {len(found)} violations",
                {"violations": found},
            )
            raise gate.PlanRejected(
                "Plan rejected by the deploy gate: " + "; ".join(found[:10])
            )
        await emitter.safe_emit(
            "status",
            "guardrails",
            "Plan passed the deploy gate (no deletes, replaces or foreign resources)",
        )

    async def apply():
        await emitter.safe_emit(
            "tool_call",
            AUTHOR,
            "terraform_apply",
            {"args": {"plan": terraform.PLAN_FILE}},
        )
        out = await asyncio.to_thread(terraform.apply, infra)
        outputs = await asyncio.to_thread(terraform.outputs, infra)
        match = re.search(r"Apply complete! Resources: [^\n]*", out)
        apply_summary = match.group(0) if match else _tail(out, 300)
        service_url = outputs.get("service_url")
        if not service_url:
            raise RuntimeError("Terraform output service_url is missing")
        await emitter.safe_emit(
            "tool_result",
            AUTHOR,
            "terraform_apply",
            {"result": {"summary": apply_summary, "service_url": service_url}},
        )
        return Event(state={"service_url": service_url, "apply_summary": apply_summary})

    async def probe_app(service_url: str):
        api_path = probe.find_api_path(run.app_dir)
        await emitter.safe_emit(
            "tool_call",
            AUTHOR,
            "http_probe",
            {"args": {"url": service_url, "api": api_path}},
        )
        started = time.time()
        result = await asyncio.to_thread(probe.probe, service_url, api_path)
        store["probe"] = result
        store["probe_started"] = started
        await emitter.safe_emit(
            "tool_result", AUTHOR, "http_probe", {"result": probe.compact(result)}
        )

    async def audit_checks(image_ref: str):
        planned = gate.planned_service(store["plan"])
        name = planned.get("name") or f"app-{run.run_id}"
        service = await asyncio.to_thread(gcp.service, name)
        iam = await asyncio.to_thread(gcp.service_iam, name)
        env = (
            (((service.get("template") or {}).get("containers") or [{}])[0]).get("env")
            or []
        )
        refs = [
            e["valueSource"]["secretKeyRef"]["secret"]
            for e in env
            if (e.get("valueSource") or {}).get("secretKeyRef")
        ]
        secrets = {s: await asyncio.to_thread(gcp.secret_exists, s) for s in refs}
        logs = []
        for _ in range(6):
            logs = await asyncio.to_thread(
                gcp.recent_logs, name, rfc3339(store["probe_started"] - 5)
            )
            if logs:
                break
            await asyncio.sleep(15)
        plan_types = {rc["type"] for rc in store["plan"].get("resource_changes", [])}
        checks = (
            audit.security_checks(
                service,
                iam,
                secrets,
                store["probe"],
                audit.codeguard_counts(stages.get("codeguard") or {}),
            )
            + audit.reliability_checks(service)
            + audit.cost_checks(service, planned, audit.cost_total(iac.get("cost")))
            + audit.observability_checks(service, logs, plan_types)
            + audit.deploy_checks(service, store["probe"], image_ref)
        )
        failed = [c["name"] for c in checks if not c["passed"]]
        await emitter.safe_emit(
            "output",
            AUTHOR,
            f"{len(checks) - len(failed)}/{len(checks)} checks passed",
            {"failed": failed},
        )
        return Event(
            state={
                "checks": checks,
                "checks_json": json.dumps(checks, indent=1),
                "evidence": json.dumps(probe.compact(store["probe"]), indent=1),
            }
        )

    auditor = Agent(
        name="auditor",
        model=gemini(),
        planner=thinking(),
        instruction=INSTRUCTION,
        output_schema=AuditReport,
        output_key="audit_report",
    )

    async def finish(
        audit_report: dict,
        checks: list,
        service_url: str,
        image: str,
        image_ref: str,
        apply_summary: str,
    ):
        judged = [
            audit.check(j["name"], j["category"], j["passed"], j["detail"])
            for j in audit_report.get("judged_checks", [])[:4]
        ]
        all_checks = checks + judged
        notes = {n["name"]: n["note"] for n in audit_report.get("notes", [])}
        score = audit.score(all_checks, notes)
        public_checks = [
            {k: c[k] for k in ("name", "category", "passed", "detail")}
            for c in all_checks
        ]
        artifacts = [
            {"kind": "link", "title": "Live app", "url": service_url, "meta": {}},
            {
                "kind": "report",
                "title": "Readiness audit",
                "url": None,
                "meta": {"markdown": audit_report["markdown"], "checks": public_checks},
            },
        ]
        now = datetime.now(timezone.utc)
        await (
            client.collection("runs")
            .document(run.run_id)
            .update({"score": score, "app.url": service_url})
        )
        if run_doc.get("project_id"):
            await (
                client.collection("projects")
                .document(run_doc["project_id"])
                .update({"app_url": service_url, "updated_at": now})
            )
        result = {
            "service_url": service_url,
            "image": image,
            "image_ref": image_ref,
            "apply_summary": apply_summary,
            "score": score,
        }
        summary = f"Live at {service_url}. Readiness {score['total']}/100. {audit_report['summary']}"
        await set_stage(
            client,
            run,
            "awaiting_approval",
            summary=summary,
            artifacts=artifacts,
            result=result,
        )
        await emitter.safe_emit("status", AUTHOR, "Waiting for approval")

    return Workflow(
        name="deploy",
        edges=[
            (
                "START",
                checkout,
                build_image,
                plan,
                gate_plan,
                apply,
                probe_app,
                audit_checks,
                auditor,
                finish,
            )
        ],
    )


async def main() -> int:
    client = context.db()
    run = await context.load(client)
    emitter = Emitter(client, run)

    async def body():
        snapshot = await client.collection("runs").document(run.run_id).get()
        repo = Repo(run, github_token(run.project))
        gcp = Gcp(run.project)
        workflow = build(run, client, emitter, repo, gcp, snapshot.to_dict())
        plugins = [
            GuardrailPlugin(set(), run.app_dir, emitter),
            FirestoreEventsPlugin(emitter),
        ]
        await run_workflow(
            workflow,
            run,
            plugins,
            prompt="Deploy and audit the app.",
            state={},
            max_llm_calls=env_int("MAX_LLM_CALLS", 500),
            timeout_s=env_int("STAGE_TIMEOUT_S", 3600),
        )

    return await guarded(client, run, emitter, body)
