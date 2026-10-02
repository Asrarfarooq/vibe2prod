import json
import posixpath
import re

from common import context
from common.events import Emitter, FirestoreEventsPlugin
from common.guardrails import GuardrailPlugin, safe_path
from common.model import gemini, thinking
from common.repo import Repo, github_token
from common.stage import env_int, guarded, run_workflow, set_stage
from google.adk import Agent, Event, Workflow
from pydantic import BaseModel, Field

REGION = "us-central1"
MAX_ROUNDS = 3
MAX_NAME = 49
MAX_FILE_BYTES = 200_000
MAX_CONTEXT_FILE_BYTES = 40_000
MAX_CONTEXT_BYTES = 150_000
SKIP_DIRS = {"node_modules", "dist", "build", ".git", ".next", "coverage", "docs"}
SKIP_CONTENT = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml"}
TEXT_SUFFIXES = {
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".html", ".css",
    ".md", ".yaml", ".yml", ".toml", ".py", ".txt", ".env", ".example",
}  # fmt: skip
TEXT_NAMES = {"Dockerfile", ".dockerignore", ".gitignore", ".gcloudignore"}
PROJECT_ROLES = ("roles/datastore.user",)
RUNTIME_SA_ID = "vibe2prod-app-runtime"


class Setting(BaseModel):
    key: str = Field(
        description="Terraform-style argument name, e.g. min_instance_count."
    )
    value: str


class Resource(BaseModel):
    type: str = Field(
        description="Exact Terraform resource type from the google provider, e.g. google_cloud_run_v2_service."
    )
    name: str = Field(description="Actual GCP resource name.")
    purpose: str
    config: list[Setting] = Field(
        description="Every setting the Terraform writer needs for this resource."
    )


class Component(BaseModel):
    name: str
    description: str


class IamBinding(BaseModel):
    principal: str = Field(
        description="IAM member string, e.g. serviceAccount:app-x@project.iam.gserviceaccount.com."
    )
    role: str
    resource: str = Field(
        description="Resource the binding is set on: project, or the bucket/secret/service name."
    )
    condition: str = Field(description="CEL IAM condition expression, empty if none.")
    reason: str


class SecretSpec(BaseModel):
    name: str = Field(description="Secret Manager secret id.")
    env_var: str = Field(description="Environment variable the app reads it from.")
    purpose: str
    value_source: str = Field(
        description="Who creates the secret value and how (e.g. random_password in Terraform)."
    )


class EnvVar(BaseModel):
    name: str
    value: str = Field(
        description="Literal value, or empty when source is secret or runtime."
    )
    source: str = Field(
        description="literal, secret (Secret Manager reference), or runtime (set by Cloud Run)."
    )
    purpose: str


class CodeChange(BaseModel):
    file: str = Field(description="Path relative to the app root.")
    change: str = Field(description="Exact change to make.")
    reason: str


class UsageAssumptions(BaseModel):
    monthly_requests: int
    avg_request_seconds: float
    avg_response_kb: float
    storage_gb: float = Field(description="Total stored data (Firestore plus GCS).")
    firestore_storage_gb: float
    gcs_storage_gb: float
    gcs_class_a_ops: int = Field(description="GCS writes/lists per month.")
    gcs_class_b_ops: int = Field(description="GCS reads per month.")
    secret_accesses: int = Field(description="Secret Manager access calls per month.")
    gemini_model: str
    gemini_calls_per_month: int
    avg_input_tokens: int
    avg_output_tokens: int
    firestore_reads: int = Field(description="Document reads per month.")
    firestore_writes: int = Field(description="Document writes per month.")


class DesignDoc(BaseModel):
    summary: str = Field(description="Three or four sentences for the human approver.")
    components: list[Component]
    resources: list[Resource]
    iam: list[IamBinding]
    secrets: list[SecretSpec]
    env_vars: list[EnvVar]
    code_changes: list[CodeChange] = Field(
        description="App code changes this design depends on; empty if none."
    )
    usage_assumptions: UsageAssumptions
    risks: list[str]
    markdown: str = Field(description="The full human-readable design document.")


class Review(BaseModel):
    blocking_issues: list[str] = Field(
        description="Concrete problems that must be fixed before Terraform is written, each with the fix."
    )
    suggestions: list[str]
    approved: bool


CONSTRAINTS = """- Google Cloud project {project}, region {region}. Everything is created by Terraform (google provider) in this project.
- Exactly one Cloud Run service, Terraform type google_cloud_run_v2_service, named {prefix}, serving the UI and the API from the app's own Dockerfile. The container image comes from the Terraform variable image (built and pushed by the deploy stage); do not design image builds, Artifact Registry, or CI.
- Every resource name starts with {prefix}. Every resource that supports labels gets the label v2p-run={label}.
- The org policy forbids IAM bindings to allUsers or allAuthenticatedUsers. If the app must be reachable publicly, set invoker_iam_disabled = true on the service and ingress INGRESS_TRAFFIC_ALL; never add an invoker binding for allUsers.
- The project's (default) Firestore database belongs to the Vibe2Prod platform and must never be used. If the app needs a database, create a Firestore Native database with database id {prefix} in {region} (google_firestore_database).
- Runtime identity: the service runs as the platform's shared service account {runtime_sa}, which already has roles/aiplatform.user. Do not create service accounts. Grant it roles on the resource itself where the resource supports IAM (bucket, secret). The only project-level roles allowed are {project_roles}; roles/datastore.user must carry the condition resource.name == "projects/{project}/databases/{prefix}". No basic roles, no admin roles.
- Gemini: the app must call model gemini-3.8-flash through Vertex AI (location global, served only there) with the runtime service account instead of an API key. If the code uses an API key or any other model id, list the exact code change in code_changes. usage_assumptions.gemini_model is gemini-3.8-flash.
- Secrets live in Secret Manager (google_secret_manager_secret plus a version) and reach the container as secret-backed env vars, never as literal env values. The runtime service account gets roles/secretmanager.secretAccessor on each secret only.
- Cloud Run instances have an in-memory, per-instance filesystem and no shared process memory. For every piece of state the code keeps on local disk or in memory, decide from the code: move it to a managed service (and list the code change), or explain why losing it is acceptable.
- Cost: min_instance_count 0 unless justified, an explicit max_instance_count, cpu and memory sized to this app.
- Startup and liveness probes must hit a cheap path that touches no database or external API. If the app has none, add a dedicated health route as a code change.
- In the @google/genai JavaScript SDK, Vertex AI mode is the constructor option vertexai (all lowercase) set to true, plus project and location.
- Budget alerts need billing-account permissions the pipeline does not have: no google_billing_budget resource; recommend one under operations instead.
- Do not state dollar prices or free-tier claims; the cost stage prices usage_assumptions from the live Cloud Billing Catalog. Describe cost drivers by quantity only."""

WRITER_INSTRUCTION = """You are the Architect of Vibe2Prod. Design how this specific app runs in production on Google Cloud. A security agent already fixed the code; the user message has the app's file tree, its key files and that agent's summary. Use list_files and read_file for anything else you need.

Platform constraints (fixed, do not deviate):
{constraints}

Fill the DesignDoc precisely; the Terraform and cost stages consume it directly:
- resources: one entry per Terraform resource to create (including the service account, secret versions and any random_password). config lists every setting the Terraform writer needs, for example region/location, cpu, memory, min_instance_count, max_instance_count, max_instance_request_concurrency, timeout, ingress, invoker_iam_disabled, container_port, probe paths, storage class, uniform_bucket_level_access, public_access_prevention, lifecycle rules, database type, labels.
- iam: every binding, one per principal+role+resource, with the condition when there is one.
- env_vars and secrets: every environment variable the code reads (search the code for process.env) plus the ones the new design adds.
- usage_assumptions: realistic numbers for a small team app used in a demo, consistent with the markdown (include probe traffic). The cost stage multiplies them by list prices.
- code_changes: the minimal app-code changes needed for the app to work on this infrastructure (read the resource names from the env vars you define, Gemini through Vertex AI, move state to the managed services, health route). The IaC stage implements exactly these, so each entry is small, concrete and names the env vars, packages and endpoints involved. Keep every existing endpoint's request and response contract and validation.
- markdown: the full design doc with these sections: Context, Architecture (with a mermaid flowchart), Data flow, Security, IAM (table), Configuration (env vars and secrets), Cost drivers, Operations and observability, Rollout, Risks, Required code changes. Name this app's real endpoints, files and behaviors. No generic filler.

If the user message contains a previous draft with the critic's blocking issues, fix every blocking issue, keep the rest consistent, and return the complete revised DesignDoc."""

CRITIC_INSTRUCTION = """You are an independent Google Cloud security and reliability reviewer. You did not write this design and you do not trust it. The user message is a DesignDoc (JSON) for deploying the app in the current folder. Check its claims against the code with list_files and read_file.

Platform constraints the design must meet:
{constraints}

Report as blocking only what must change before Terraform is written:
- any constraint above violated;
- least privilege: a project-level role where a resource-level grant exists, a role broader than needed, a missing grant the app needs at runtime;
- an API key or other secret passed as a literal env var, or a secret the code reads that is missing;
- ingress or public access broader than the app needs;
- missing or wrong health probes, missing max_instance_count, min_instance_count above 0 without a reason;
- state kept on local disk or in memory without a decision, or any code path that still uses the replaced state;
- code changes that break an existing endpoint's request or response contract or its input validation (for example generated names that the app's own validation would reject);
- usage_assumptions that contradict the design (for example probe or request frequency implying more reads than assumed);
- env vars the code reads that are missing, resources or IAM in the JSON that disagree with the markdown, wrong Terraform resource types, names without the required prefix, missing code changes the design depends on;
- markdown that is generic instead of specific to this app, or that states prices.
Each blocking issue must name the field or resource and the fix. Put only optional improvements under suggestions; anything that would make the deployed app misbehave, cost more than assumed, or fail review is blocking. approved is true only when blocking_issues is empty."""


def _coerce(value: str):
    low = value.strip().lower()
    if low in ("true", "false"):
        return low == "true"
    if re.fullmatch(r"-?\d+", value.strip()):
        return int(value)
    return value


def build(run: context.RunContext, client, emitter: Emitter, repo: Repo):
    root = run.app_dir
    prefix = f"app-{run.run_id}".lower()
    if len(prefix) > MAX_NAME:
        raise ValueError(
            f"Service name {prefix} is {len(prefix)} chars; Cloud Run allows {MAX_NAME}"
        )
    constraints = CONSTRAINTS.format(
        project=run.project,
        region=REGION,
        prefix=prefix,
        label=run.run_id.lower()[:63],
        runtime_sa=f"{RUNTIME_SA_ID}@{run.project}.iam.gserviceaccount.com",
        project_roles=" and ".join(PROJECT_ROLES),
    )
    doc_rel = posixpath.normpath(posixpath.join(run.app_path, "docs", "DESIGN.md"))

    def _walk(base):
        return [
            p
            for p in sorted(base.rglob("*"))
            if p.is_file() and not SKIP_DIRS.intersection(p.relative_to(root).parts)
        ]

    def list_files(path: str = ".") -> dict:
        """List files under a folder of the app, skipping node_modules, dist and .git.

        Args:
          path: Folder relative to the app root.
        """
        files = [str(p.relative_to(root)) for p in _walk(safe_path(root, path))]
        return {"files": files[:500]}

    def read_file(path: str) -> dict:
        """Read a text file of the app.

        Args:
          path: File path relative to the app root.
        """
        target = safe_path(root, path)
        if target.stat().st_size > MAX_FILE_BYTES:
            return {"error": "file too large to read"}
        return {"path": path, "content": target.read_text(errors="replace")}

    tools = [list_files, read_file]

    async def checkout():
        await emitter.safe_emit(
            "status", "architect", f"Checking out {run.branch} from {run.repo}"
        )
        commit = repo.checkout()
        await emitter.safe_emit("status", "architect", f"At commit {commit[:7]}")
        return Event(state={"commit": commit})

    async def gather():
        files = _walk(root)
        parts = ["## File tree", *(str(p.relative_to(root)) for p in files)]
        total = 0
        included = []
        for p in files:
            rel = str(p.relative_to(root))
            if p.name in SKIP_CONTENT or not (
                p.suffix in TEXT_SUFFIXES or p.name in TEXT_NAMES
            ):
                continue
            size = p.stat().st_size
            if size > MAX_CONTEXT_FILE_BYTES or total + size > MAX_CONTEXT_BYTES:
                continue
            total += size
            included.append(rel)
            parts += ["", f"## {rel}", "```", p.read_text(errors="replace"), "```"]
        snapshot = await client.collection("runs").document(run.run_id).get()
        codeguard = (snapshot.to_dict() or {}).get("stages", {}).get("codeguard", {})
        parts += [
            "",
            "## Security agent summary",
            codeguard.get("summary") or "No summary recorded.",
        ]
        app_context = context.feedback_block(run) + "\n".join(parts)
        await emitter.safe_emit(
            "tool_result",
            "architect",
            "gather",
            {"result": {"files": len(files), "included": included}},
        )
        return Event(
            output=app_context, state={"app_context": app_context, "rounds": 0}
        )

    writer = Agent(
        name="writer",
        model=gemini(),
        planner=thinking(),
        instruction=WRITER_INSTRUCTION.format(constraints=constraints),
        tools=tools,
        output_schema=DesignDoc,
        output_key="design",
    )

    critic = Agent(
        name="critic",
        model=gemini(),
        planner=thinking(),
        instruction=CRITIC_INSTRUCTION.format(constraints=constraints),
        tools=tools,
        output_schema=Review,
        output_key="review",
    )

    async def gate(design: dict, review: dict, rounds: int, app_context: str):
        rounds += 1
        issues = review.get("blocking_issues") or []
        approved = bool(review.get("approved")) and not issues
        if approved or rounds >= MAX_ROUNDS:
            verdict = "approved" if approved else "not approved"
            await emitter.safe_emit(
                "status",
                "architect",
                f"Critic round {rounds}: {verdict}, {len(issues)} blocking issues",
            )
            return Event(route="done", state={"rounds": rounds})
        await emitter.safe_emit(
            "status",
            "architect",
            f"Critic round {rounds}: {len(issues)} blocking issues, revising",
            {"blocking_issues": issues},
        )
        revision = "\n".join(
            [
                app_context,
                "",
                "## Your previous draft",
                json.dumps(design, indent=1),
                "",
                "## Critic's blocking issues (fix all of them)",
                *(f"- {i}" for i in issues),
            ]
        )
        return Event(output=revision, route="revise", state={"rounds": rounds})

    async def write_doc(design: dict, review: dict, rounds: int):
        target = root / "docs" / "DESIGN.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        verdict = "approved" if review.get("approved") else "not approved"
        footer = (
            f"\n\n---\nWritten by the Vibe2Prod Architect agent; independent critic "
            f"{verdict} after {rounds} round(s). A human approves before Terraform is written.\n"
        )
        target.write_text(design["markdown"].rstrip() + footer)
        if repo.changed_files():
            repo.commit_and_push(f"Architect: design doc for run {run.run_id}")
            await emitter.safe_emit(
                "output", "architect", f"Pushed {doc_rel} to {run.branch}"
            )

    async def finish(design: dict, review: dict, rounds: int):
        issues = review.get("blocking_issues") or []
        approved = bool(review.get("approved")) and not issues
        result = {k: v for k, v in design.items() if k not in ("markdown", "resources")}
        result["resources"] = [
            {**r, "config": {s["key"]: _coerce(s["value"]) for s in r["config"]}}
            for r in design["resources"]
        ]
        result["critic"] = {
            "approved": approved,
            "blocking_issues": issues,
            "suggestions": review.get("suggestions") or [],
        }
        result["rounds"] = rounds
        result["doc_path"] = doc_rel
        artifacts = [
            {
                "kind": "doc",
                "title": "Design doc",
                "url": f"https://github.com/{run.repo}/blob/{run.branch}/{doc_rel}",
                "meta": {"markdown": design["markdown"]},
            }
        ]
        pr = repo.find_pr()
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
        verdict = (
            f"Critic approved after {rounds} round(s)."
            if approved
            else f"Critic did not approve after {rounds} rounds; {len(issues)} open issues."
        )
        summary = (
            f"{design['summary']} {len(design['resources'])} resources, "
            f"{len(design['iam'])} IAM bindings. {verdict}"
        )
        await set_stage(
            client,
            run,
            "awaiting_approval",
            summary=summary,
            artifacts=artifacts,
            result=result,
        )
        await emitter.safe_emit("status", "architect", "Waiting for approval")

    return Workflow(
        name="architect",
        edges=[
            ("START", checkout, gather, writer, critic, gate),
            (gate, {"revise": writer, "done": write_doc}),
            (write_doc, finish),
        ],
    ), {t.__name__ for t in tools}


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
            prompt="Design the production deployment.",
            state={},
            max_llm_calls=env_int("MAX_LLM_CALLS", 500),
            timeout_s=env_int("STAGE_TIMEOUT_S", 7200),
        )

    return await guarded(client, run, emitter, body)
