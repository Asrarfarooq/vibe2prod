import json
import os
import shutil
import subprocess
import tempfile
from pathlib import Path

GOOGLE_PROVIDER = "8.4.0"
RANDOM_PROVIDER = "3.9.1"
STATE_BUCKET = "vibe2prod-509620-tfstate"
PLAN_IMAGE = "us-docker.pkg.dev/cloudrun/container/hello"
PROVIDER_MIRROR = Path(os.environ.get("TF_PLUGIN_CACHE_DIR", "/opt/tf-plugin-cache"))
CLI_CONFIG = Path(tempfile.gettempdir()) / "v2p-terraformrc"
ALLOWED_PROVIDERS = {
    "registry.terraform.io/hashicorp/google",
    "registry.terraform.io/hashicorp/random",
}
PROJECT_ROLES = ("roles/datastore.user",)
# Pre-created by the platform with roles/aiplatform.user; the deploy agent may act only as this account.
RUNTIME_SA_ID = "vibe2prod-app-runtime"
DENIED_TYPES = {
    "google_billing_budget",
    "google_project",
    "google_project_service",
    "google_project_iam_custom_role",
    "google_project_iam_audit_config",
    "google_project_iam_member_remove",
    "google_service_account",
    "google_service_account_iam_member",
    "google_service_account_key",
}
NAME_FIELDS = {
    "google_cloud_run_v2_service": "name",
    "google_secret_manager_secret": "secret_id",
    "google_storage_bucket": "name",
    "google_firestore_database": "name",
}
PUBLIC_MEMBERS = ("allUsers", "allAuthenticatedUsers")
RESERVED_ENV = {"PORT", "K_SERVICE", "K_REVISION", "K_CONFIGURATION"}
MAX_ERRORS = 20


def names(run_id: str) -> dict:
    """Resource naming shared with the Architect stage."""
    prefix = f"app-{run_id}".lower()
    return {
        "prefix": prefix,
        "label": run_id.lower()[:63],
    }


def versions_tf(run_id: str, project: str, region: str) -> str:
    n = names(run_id)
    return f"""terraform {{
  required_version = "~> 1.16"

  required_providers {{
    google = {{
      source  = "hashicorp/google"
      version = "{GOOGLE_PROVIDER}"
    }}
    random = {{
      source  = "hashicorp/random"
      version = "{RANDOM_PROVIDER}"
    }}
  }}

  backend "gcs" {{
    bucket = "{STATE_BUCKET}"
    prefix = "apps/{run_id}"
  }}
}}

provider "google" {{
  project = local.project
  region  = local.region

  default_labels = {{
    v2p-run = local.run_label
  }}
}}

locals {{
  project   = "{project}"
  region    = "{region}"
  name      = "{n["prefix"]}"
  runtime_sa = "{RUNTIME_SA_ID}@{project}.iam.gserviceaccount.com"
  run_label = "{n["label"]}"
}}
"""


def _cli_config() -> dict:
    """Installs the pinned providers from the image's read-only provider directory as a filesystem mirror."""
    if not PROVIDER_MIRROR.is_dir():
        return {}
    pinned = '"registry.terraform.io/hashicorp/google", "registry.terraform.io/hashicorp/random"'
    CLI_CONFIG.write_text(
        "provider_installation {\n"
        f'  filesystem_mirror {{\n    path    = "{PROVIDER_MIRROR}"\n    include = [{pinned}]\n  }}\n'
        f"  direct {{\n    exclude = [{pinned}]\n  }}\n"
        "}\n"
    )
    return {"TF_CLI_CONFIG_FILE": str(CLI_CONFIG)}


def _run(args: list[str], cwd: Path, timeout: int = 600) -> subprocess.CompletedProcess:
    env = {k: v for k, v in os.environ.items() if k != "TF_PLUGIN_CACHE_DIR"} | {
        "TF_IN_AUTOMATION": "1",
        "TF_INPUT": "0",
        "CHECKPOINT_DISABLE": "1",
        **_cli_config(),
    }
    return subprocess.run(
        ["terraform", *args],
        cwd=cwd,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
        env=env,
    )


def _tail(proc: subprocess.CompletedProcess) -> str:
    return (proc.stdout + proc.stderr).strip()[-3000:]


def _diagnostics(raw: str) -> list[str]:
    out = []
    for d in json.loads(raw).get("diagnostics", []):
        rng = d.get("range") or {}
        where = (
            f"{rng.get('filename')}:{rng.get('start', {}).get('line')}" if rng else ""
        )
        out.append(
            f"{d.get('severity')}: {d.get('summary')} {where} {d.get('detail', '')}".strip()
        )
    return out


def check(infra: Path, run_id: str) -> dict:
    """Formats, validates and plans infra/ in a scratch copy with local state, then applies policy checks.

    Returns {ok, step, errors, plan}. The provider lock file is copied back so Deploy uses the same versions.
    """
    fmt = _run(["fmt", "-no-color"], infra)
    if fmt.returncode != 0:
        return {"ok": False, "step": "fmt", "errors": [_tail(fmt)], "plan": None}
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp) / "infra"
        shutil.copytree(infra, work, ignore=shutil.ignore_patterns(".terraform"))
        # Plans need no remote state: the stack is new, and Deploy owns the real backend.
        (work / "backend_override.tf").write_text(
            'terraform {\n  backend "local" {}\n}\n'
        )
        init = _run(["init", "-input=false", "-no-color"], work)
        if init.returncode != 0:
            return {"ok": False, "step": "init", "errors": [_tail(init)], "plan": None}
        shutil.copy2(work / ".terraform.lock.hcl", infra / ".terraform.lock.hcl")
        val = _run(["validate", "-json", "-no-color"], work)
        errors = _diagnostics(val.stdout) if val.stdout.strip() else [_tail(val)]
        if val.returncode != 0:
            return {
                "ok": False,
                "step": "validate",
                "errors": errors[:MAX_ERRORS],
                "plan": None,
            }
        plan = _run(
            [
                "plan",
                "-input=false",
                "-no-color",
                "-refresh=false",
                "-lock=false",
                "-out=tf.plan",
                f"-var=image={PLAN_IMAGE}",
            ],
            work,
        )
        if plan.returncode != 0:
            return {"ok": False, "step": "plan", "errors": [_tail(plan)], "plan": None}
        show = _run(["show", "-json", "tf.plan"], work)
        if show.returncode != 0:
            return {"ok": False, "step": "show", "errors": [_tail(show)], "plan": None}
        plan_json = json.loads(show.stdout)
    errors = policy(plan_json, run_id)
    return {
        "ok": not errors,
        "step": "policy",
        "errors": errors[:MAX_ERRORS],
        "plan": plan_json,
    }


def summarize(plan: dict) -> dict:
    counts = {"add": 0, "change": 0, "destroy": 0}
    addresses = []
    for rc in plan.get("resource_changes", []):
        actions = rc["change"]["actions"]
        if "create" in actions:
            counts["add"] += 1
        if "update" in actions:
            counts["change"] += 1
        if "delete" in actions:
            counts["destroy"] += 1
        if actions != ["no-op"]:
            addresses.append(rc["address"])
    return {**counts, "resources": addresses}


def _walk_strings(value):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for v in value.values():
            yield from _walk_strings(v)
    elif isinstance(value, list):
        for v in value:
            yield from _walk_strings(v)


def _references(expr) -> list[str]:
    """All references in a plan configuration expression, including nested blocks."""
    if isinstance(expr, list):
        return [r for v in expr for r in _references(v)]
    if not isinstance(expr, dict):
        return []
    refs = list(expr.get("references", []))
    for k, v in expr.items():
        if k != "references":
            refs += _references(v)
    return refs


def policy(plan: dict, run_id: str) -> list[str]:
    """Deterministic rules the Deploy stage relies on; the model cannot waive them."""
    n = names(run_id)
    prefix = n["prefix"]
    errors = []
    root = plan.get("configuration", {}).get("root_module", {})

    for key in plan.get("configuration", {}).get("provider_config", {}):
        full = plan["configuration"]["provider_config"][key].get("full_name", "")
        if full not in ALLOWED_PROVIDERS:
            errors.append(
                f"Provider {full or key} is not allowed; use only hashicorp/google and hashicorp/random."
            )
    if root.get("module_calls"):
        errors.append("Modules are not allowed; keep all resources in this folder.")
    if "image" not in root.get("variables", {}):
        errors.append(
            'Missing variable "image" (container image URL set by the deploy stage).'
        )
    if "service_url" not in root.get("outputs", {}):
        errors.append('Missing output "service_url" (the Cloud Run service URI).')

    services = []
    for res in root.get("resources", []):
        addr = res["address"]
        if res.get("mode") == "data":
            errors.append(
                f"{addr}: data sources are not allowed; this stack must not read platform resources."
            )
        if res.get("provisioners"):
            errors.append(f"{addr}: provisioners are not allowed.")
        if res.get("type") == "google_cloud_run_v2_service":
            services.append(res)
            tmpl = res.get("expressions", {}).get("template", [{}])
            tmpl = tmpl[0] if isinstance(tmpl, list) and tmpl else {}
            images = [
                r
                for c in tmpl.get("containers", [])
                for r in _references(c.get("image", {}))
            ]
            if "var.image" not in images:
                errors.append(f"{addr}: container image must be var.image.")
            if "local.runtime_sa" not in _references(tmpl.get("service_account", {})):
                errors.append(
                    f"{addr}: template.service_account must be local.runtime_sa."
                )
            for c in tmpl.get("containers", []):
                for env in c.get("env", []):
                    name = env.get("name", {}).get("constant_value")
                    if name in RESERVED_ENV:
                        errors.append(
                            f"{addr}: env {name} is reserved and set by Cloud Run; remove it."
                        )
    if len(services) != 1:
        errors.append(
            f"Expected exactly one google_cloud_run_v2_service, found {len(services)}."
        )

    for rc in plan.get("resource_changes", []):
        addr, rtype = rc["address"], rc["type"]
        change = rc["change"]
        after = change.get("after") or {}
        if rc.get("mode") == "data":
            continue
        if change.get("importing"):
            errors.append(f"{addr}: import is not allowed.")
        if change["actions"] != ["create"]:
            errors.append(
                f"{addr}: expected create on a new stack, got {change['actions']}."
            )
        if rtype in DENIED_TYPES or rtype.endswith(("_iam_policy", "_iam_binding")):
            errors.append(
                f"{addr}: {rtype} is not allowed (authoritative IAM, project-level or billing resource)."
            )
        for s in _walk_strings(after):
            if any(m in s for m in PUBLIC_MEMBERS):
                errors.append(
                    f"{addr}: public IAM members are forbidden by org policy; use invoker_iam_disabled on the service."
                )
                break
        field = NAME_FIELDS.get(rtype)
        if (
            field
            and isinstance(after.get(field), str)
            and not after[field].startswith(prefix)
        ):
            errors.append(
                f"{addr}: {field} {after[field]!r} must start with {prefix!r}."
            )
        if rtype == "google_firestore_database" and after.get("name") != prefix:
            errors.append(
                f"{addr}: the database id must be {prefix!r}; (default) belongs to the platform."
            )
        if (
            rtype == "google_cloud_run_v2_service"
            and after.get("deletion_protection") is not False
        ):
            errors.append(
                f"{addr}: set deletion_protection = false so the stack can be torn down."
            )
        if rtype == "google_project_iam_member":
            role = after.get("role")
            if role not in PROJECT_ROLES:
                errors.append(
                    f"{addr}: project role {role} is not allowed; only {', '.join(PROJECT_ROLES)}. Grant on the resource instead."
                )
            if role == "roles/datastore.user":
                expr = " ".join(
                    c.get("expression", "") for c in after.get("condition") or []
                )
                if f"databases/{prefix}" not in expr:
                    errors.append(
                        f'{addr}: roles/datastore.user needs condition resource.name == "projects/<project>/databases/{prefix}".'
                    )
        if rtype.endswith("_iam_member") and rtype != "google_project_iam_member":
            for key in ("secret_id", "bucket", "name", "service", "database"):
                target = after.get(key)
                if isinstance(target, str) and prefix not in target:
                    errors.append(
                        f"{addr}: {key} {target!r} is not a resource of this stack."
                    )
    return errors
